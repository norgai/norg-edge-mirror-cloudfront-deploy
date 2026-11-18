/**
 * NORG.ai Content-Craft Platform — Edge Router Worker
 *
 * Installed on the CUSTOMER's Cloudflare zone at {domain}/*. Serves
 * NORG-optimised content to AI agents at the customer's own URLs, and leaves
 * every other visitor's experience byte-for-byte unchanged.
 *
 * @description Edge-routing worker for customer-owned Cloudflare zones.
 */

/*
 * Serves NORG-optimised content to AI agents at the customer's own URLs, and
 * leaves everyone else completely alone:
 *
 *   human / search engine  -> origin, byte-for-byte untouched
 *   AI agent, page in R2   -> NORG render, fetched internally (never a redirect)
 *   AI agent, page missing -> origin HTML stripped to a token-dense form, plus
 *                             a non-blocking request asking NORG to render it
 *
 * Three rules govern every line here:
 *
 *  1. THIS MUST NEVER BREAK THE CUSTOMER'S SITE. Every failure path — NORG API
 *     down, R2 unreachable, a bug in this file — ends at the origin response.
 *     The top-level catch is load-bearing, not decoration.
 *
 *  2. SEARCH ENGINES ARE NOT AI AGENTS. Googlebot and friends always get the
 *     origin. Serving them different content than humans is cloaking and would
 *     put the customer's rankings at risk. There is deliberately no flag to
 *     turn this off, and nothing overrides it — not even ?agent=true.
 *
 *  3. NOTHING HAPPENS WITHOUT AN AUTHENTICATED FEED. SITE_ID + NORG_SITE_KEY
 *     are compulsory: every NORG endpoint that services this install requires
 *     them, and until one of those calls succeeds the worker changes nothing at
 *     all. Which crawlers exist, which may be diverted (serving_policy) and
 *     which source IPs are genuinely theirs (cidr_ranges) are all NORG's to
 *     publish and to withdraw — there is no local copy to fall back on. A
 *     refusal (401/403) revokes immediately; an outage does not, so a working
 *     install keeps serving from cache while NORG is away.
 *
 * Standalone AS SHIPPED: the built artifact (dist/, produced by build.mjs)
 * is a single file with no imports, so it can be uploaded as one script via
 * the Cloudflare API or a Deploy button, and so NORG-internal code can never
 * leak into a third-party account. THIS source imports shared lib/ modules;
 * the bundler inlines them at build time.
 *
 * Bindings (plain text unless noted):
 *   SITE_ID                edge_sites.id
 *   NORG_API_URL           https://content-craft-api.norg.ai
 *   NORG_CONTENT_BASE      NORG edge-content receptionist base, e.g.
 *                          https://edge-content.test.norg.ai — an
 *                          authenticated NORG-account worker fronting the
 *                          mirror bucket. Never a public bucket URL.
 *   STRIP_FALLBACK_ENABLED "true" | "false"
 *   EDGE_DISABLED          "true" kills all interception (remote off switch)
 *   EDGE_ENV               NORG environment this worker is bound to
 *                          ("production" | "test"). A test-bound worker serves
 *                          TEST content, so it must be identifiable from
 *                          outside — never let it look like a prod install.
 *   NORG_SITE_KEY          SECRET — per-site key. Compulsory (rule 3): NORG
 *                          refuses every call without it, so a worker deployed
 *                          without this binding stays permanently inert.
 */

import {
  classifyRequest,
  classifyScriptAutomation,
} from "./lib/classify.mjs";
import { pathToKeySuffix } from "./lib/r2-content.mjs";
import { withAlternateFormatHeaders } from "./lib/alternate-format.mjs";
import { cidrContains, cidrVerdictFor } from "./lib/cidr.mjs";
import { mcpForwardHeaders } from "./lib/mcp-forward.mjs";
import { constantTimeEqual } from "./lib/constant-time.mjs";

export const EDGE_SCRIPT_VERSION = "0.11.7";

// Baked binding defaults (EDGEPAR 04). Five bindings never vary across manual
// and deploy-button installs, so they default here and a hand install only
// needs SITE_ID + the NORG_SITE_KEY secret. An explicitly-bound value still
// overrides its default (see `binding`); EDGE_ENV deliberately has NO default —
// "unknown" is its fallback and the guards refuse to manage an unnamed env.
const BINDING_DEFAULTS = {
  NORG_API_URL: "https://content-craft-api.norg.ai",
  NORG_CONTENT_BASE: "https://edge-content.norg.ai",
  STRIP_FALLBACK_ENABLED: "true",
  EDGE_DISABLED: "false",
  LAZY_RENDER_ENABLED: "true",
};

/**
 * Resolve a worker binding, falling back to its baked default.
 *
 * Only an ABSENT binding takes the default; an explicitly-bound value is
 * returned unchanged, so bindings still override every default. Cloudflare
 * rejects empty plain_text, so a present binding is always a real value.
 *
 * @param {Object} env Worker bindings.
 * @param {string} name Binding name present in BINDING_DEFAULTS.
 * @returns {string} The bound value, or the baked default when unbound.
 */
function binding(env, name) {
  const value = env[name];
  return value === undefined ? BINDING_DEFAULTS[name] : value;
}

// Reserved NORG asset prefix on the customer domain. The whole prefix is
// NORG-served (currently just /.norg/theme.css — the mirror shell's stylesheet)
// before classification, for every caller. Kept in sync with the backend's
// app/services/edge_routing/paths.py::EDGE_THEME_PATH.
const RESERVED_NORG_PREFIX = "/.norg/";

// Public cache headers for reserved assets. Unlike a tenant render, theme CSS
// is identical for every caller, so it is a public, cacheable asset. Matches
// theme_css_builder.MASTER_CSS_CACHE_CONTROL's intent (instant theme updates).
const RESERVED_ASSET_CACHE_CONTROL =
  "public, max-age=60, s-maxage=30, stale-while-revalidate=300";

// Marks our own subrequests so a misconfigured route can't recurse into us.
const LOOP_GUARD_HEADER = "x-norg-edge";

// Health probes present the site key in this header; without it the path is
// left alone, so we never shadow a real customer URL.
const HEALTH_CHECK_HEADER = "x-norg-edge-check";

// Budgets. The origin is always the fallback, so a slow NORG must cost the
// visitor a few hundred ms at worst, never a failed page.
const MIRROR_FETCH_TIMEOUT_MS = 4000;
const PATTERN_FETCH_TIMEOUT_MS = 5000;
const CONTROL_CALL_TIMEOUT_MS = 3000;
const MCP_FORWARD_TIMEOUT_MS = 3000;

// Mirror serves ARE cached on the customer's own CF edge — but never under the
// customer URL. The key is a SYNTHETIC internal URL folding SITE_ID + a per-site
// content_version (responseCacheContext), so it is tenant-unique and unreachable
// by a public request for the customer page; a publish bumps content_version and
// self-invalidates the old key. Disabled unless the feed says so; every failure
// degrades to a direct fetchFromNorg. See serveAgent.
const RESPONSE_CACHE_KEY_PREFIX = "https://norg-edge.internal/rc/";
// Fallback response-cache TTL (seconds) if the feed omits one.
const RESPONSE_CACHE_DEFAULT_TTL_SECONDS = 300;

// Bot patterns are admin-managed in NORG and change rarely, so they are cached
// hard: in-isolate, then in the colo's Cache API, then served stale on error.
const PATTERN_CACHE_KEY = "https://norg-edge.internal/bot-patterns";
const PATTERN_DEFAULT_TTL_MS = 3600 * 1000;
const PATTERN_CACHE_RETENTION_SECONDS = 86400;

// A refused (401/403) or unreachable-with-nothing-cached install is
// negative-cached for this short window, so a paused site costs its visitors
// no blocking NORG probe on every request. Kept short so re-entitlement lands
// within a minute: after it expires one request re-probes and a 200 feed
// restores full behaviour.
const UNENTITLED_TTL_MS = 60 * 1000;

// Heartbeats piggyback on traffic so a site with a broken cron still reports
// in; this is the floor between traffic-driven beats per isolate.
const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Suppresses repeat render requests for the same cold path within an isolate.
// Only an optimisation — NORG dedups authoritatively — so a small bounded map
// is enough, and it must never grow without limit.
const RENDER_DEDUP_TTL_MS = 10 * 60 * 1000;
const RENDER_DEDUP_MAX_ENTRIES = 500;

// Below this many visible words after stripping, the stripped page carries
// less than the origin (measured: a client-rendered origin whose content is a
// newsletter + footer strips to near-empty). Serve the untouched origin as
// "origin_thin" instead — a real page beats a page with its content removed.
const STRIP_WORD_FLOOR = 120;

/**
 * Traditional web-index crawlers, matched on user-agent and always passed
 * through to the origin.
 *
 * This is deliberately an operator list and NOT `purpose === "search"`. In
 * ai_bot_patterns that purpose covers both Googlebot/Bingbot — where serving
 * different content is cloaking and risks the customer's rankings — and AI
 * answer engines like PerplexityBot and OAI-SearchBot, which are precisely
 * the agents this product exists to serve. Keying on purpose would silently
 * exclude the target market.
 *
 * Note "google-extended" (Google's AI crawler) does not contain "googlebot",
 * so it is served like any other AI agent.
 */
const TRADITIONAL_SEARCH_BOTS = [
  "googlebot",
  "bingbot",
  "applebot",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "slurp",
];

/**
 * There is deliberately NO hardcoded fallback pattern set.
 *
 * A local list would be exactly the loophole the entitlement gate exists to
 * close: an install whose key NORG has revoked, or which never authenticated at
 * all, would keep classifying and diverting from a stale copy baked into the
 * script. Bot detection is NORG's to publish and to withdraw, so an install
 * that cannot obtain an authenticated feed does nothing at all.
 */
const UNENTITLED = Object.freeze({
  entitled: false,
  patterns: [],
  cidrRanges: {},
  agenticPathPrefix: "",
  skipPaths: [],
});

// Used only if NORG somehow omits the field; the column's own default.
const DEFAULT_AGENTIC_PATH_PREFIX = "/ai";

// NORG answering with one of these is a decision, not an outage: the key is
// wrong, or the site is paused/uninstalled (NORG's API answers 401 and 403
// respectively). Cached entitlement is dropped immediately on either.
const REFUSAL_STATUSES = new Set([401, 403]);

/** Elements with no informational value to an agent. */
const STRIP_REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "form",
  "input",
  "select",
  "textarea",
  "nav",
  "aside",
  "footer",
  "link[rel='stylesheet']",
  "link[rel='preload']",
  "link[rel='prefetch']",
  "[role='navigation']",
  "[aria-hidden='true']",
];

// Wrapper-only elements: the tag itself carries no informational value, but
// (unlike STRIP_REMOVE_SELECTORS) its text content often does — accordion/
// nav toggles routinely wrap a real label in a <button> (for example a
// mobile menu: <h5><button><span>Trending</span></button></h5>).
// Remove the wrapper, keep its content.
const STRIP_UNWRAP_SELECTORS = ["button"];

/** Attributes carrying styling/behaviour rather than meaning. */
const STRIP_KEEP_ATTRIBUTES = new Set([
  "href",
  "src",
  "alt",
  "title",
  "lang",
  "datetime",
  "content",
  "name",
  "rel",
]);

// The authenticated feed for this isolate. Starts unentitled: nothing is served
// differently until NORG has confirmed this install at least once.
let feedCache = {
  entitled: false,
  patterns: [],
  cidrRanges: {},
  skipPaths: [],
  fetchedAt: 0,
  ttl: PATTERN_DEFAULT_TTL_MS,
};
let lastHeartbeatAt = 0;
const renderDedup = new Map();

/**
 * Should this attribute survive stripping?
 * @param {string} name Lower-cased attribute name.
 * @returns {boolean} True when the attribute carries meaning.
 */
function shouldKeepAttribute(name) {
  return STRIP_KEEP_ATTRIBUTES.has(name);
}

// pathToKeySuffix is imported from lib/r2-content.mjs — shared with the
// edge-content receptionist, which must map paths to bucket keys identically.

/**
 * Is this a traditional search-engine crawler that must see the origin?
 * @param {string} userAgent Raw User-Agent header.
 * @returns {boolean} True for web-index crawlers where cloaking is a risk.
 */
function isTraditionalSearchBot(userAgent) {
  const ua = (userAgent || "").toLowerCase();
  return TRADITIONAL_SEARCH_BOTS.some((bot) => ua.includes(bot));
}

// classifyRequest / classifyScriptAutomation are imported from
// lib/classify.mjs — the single source shared with r2-proxy-worker.js
// (previously duplicated here and held in sync by a byte-parity test).

/**
 * Headers authenticating this install to the NORG control endpoints.
 * @param {Object} env Worker bindings.
 * @returns {Object} Header map.
 */
function controlHeaders(env) {
  return {
    "Content-Type": "application/json",
    "X-Norg-Site-Id": env.SITE_ID || "",
    "X-Norg-Site-Key": env.NORG_SITE_KEY || "",
    "X-Norg-Edge-Version": EDGE_SCRIPT_VERSION,
  };
}

/**
 * POST to a NORG control endpoint, swallowing every failure.
 *
 * Callers run these through ctx.waitUntil, so a rejection here would surface
 * as an unhandled rejection and nothing more useful; telemetry must never
 * affect what the visitor sees.
 *
 * @param {Object} env Worker bindings.
 * @param {string} path API path beginning with "/".
 * @param {Object} body JSON body.
 * @returns {Promise<?Response>} Response, or null on failure.
 */
async function postControl(env, path, body) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_CALL_TIMEOUT_MS);
    const response = await fetch(`${binding(env, "NORG_API_URL")}${path}`, {
      method: "POST",
      headers: controlHeaders(env),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (e) {
    console.error("norg edge control call failed", path, e);
    return null;
  }
}

/**
 * Read the cached feed verdict from the colo Cache API.
 *
 * Returns a verdict OBJECT for both an entitled entry and a fresh negative
 * (unentitled) entry, so a colo-mate can honour a recent refusal without its
 * own probe. Returns null ONLY for a genuine miss or an unusable payload — the
 * caller reads null as "no entry, probe NORG".
 *
 * @param {Object} cache Cache API instance.
 * @returns {Promise<?Object>} Verdict entry, or null when absent/unusable.
 */
async function readCachedFeed(cache) {
  try {
    const hit = await cache.match(new Request(PATTERN_CACHE_KEY));
    if (!hit) return null;
    const payload = await hit.json();
    if (!payload || typeof payload.entitled !== "boolean") return null;
    // An entitled entry must carry its pattern list; a negative verdict needs
    // only its entitled:false flag plus fetchedAt/ttl to be honoured.
    if (payload.entitled && !Array.isArray(payload.patterns)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Turn a 200 feed response into a cache entry.
 * @param {Response} response Feed response from NORG.
 * @returns {Promise<?Object>} Entry, or null when the body is unusable.
 */
async function readFeedBody(response) {
  try {
    const data = await response.json();
    const rc = data.response_cache || {};
    return {
      entitled: true,
      patterns: data.patterns || [],
      cidrRanges: data.cidr_ranges || {},
      agenticPathPrefix: data.agentic_path_prefix || DEFAULT_AGENTIC_PATH_PREFIX,
      // Per-route mirror skip: paths an operator marked to
      // pass through to origin. An array of normalised EdgeRoute paths.
      skipPaths: Array.isArray(data.skip_paths) ? data.skip_paths : [],
      // Per-site content version (a publish bumps it) and the disabled-by-default
      // response-cache config both ride this feed — no extra round trip.
      contentVersion: data.content_version || "",
      responseCache: {
        enabled: rc.enabled === true,
        // Nullish (not falsy) fallback: an operator-set ttl of 0 is a valid
        // "immediate expiry / no retention" request and must reach s-maxage=0
        // unchanged; only a missing/null ttl falls back to the default.
        ttl: rc.ttl ?? RESPONSE_CACHE_DEFAULT_TTL_SECONDS,
      },
      fetchedAt: Date.now(),
      ttl: (data.cache_ttl ? data.cache_ttl : 3600) * 1000,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Persist a feed entry to the colo cache. Best effort — a failure here only
 * costs the next isolate a round trip.
 * @param {Object} cache Cache API instance.
 * @param {Object} entry Feed entry to store.
 * @returns {Promise<void>}
 */
async function writeFeedCache(cache, entry) {
  try {
    await cache.put(
      new Request(PATTERN_CACHE_KEY),
      new Response(JSON.stringify(entry), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `s-maxage=${PATTERN_CACHE_RETENTION_SECONDS}`,
        },
      }),
    );
  } catch (e) {
    console.error("norg edge feed cache write failed", e);
  }
}

/**
 * Build a fresh negative (unentitled) verdict stamped with the current time.
 * @returns {Object} UNENTITLED plus fetchedAt and the short negative-cache TTL.
 */
function negativeVerdict() {
  return { ...UNENTITLED, fetchedAt: Date.now(), ttl: UNENTITLED_TTL_MS };
}

/**
 * Record the unentitled verdict at both cache levels for UNENTITLED_TTL_MS.
 *
 * The colo copy lets a cold colo-mate isolate honour the verdict without its
 * own probe. It OVERWRITES any entitled entry, so a refused install stops
 * diverting at once; if the write fails we delete instead, never leaving a
 * revoked entitlement readable by the next isolate.
 *
 * @param {Object} cache Cache API instance.
 * @returns {Promise<void>}
 */
async function stampNegativeFeed(cache) {
  const entry = negativeVerdict();
  feedCache = entry;
  try {
    await cache.put(
      new Request(PATTERN_CACHE_KEY),
      new Response(JSON.stringify(entry), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `s-maxage=${UNENTITLED_TTL_MS / 1000}`,
        },
      }),
    );
  } catch (e) {
    console.error("norg edge negative feed cache write failed", e);
    try {
      await cache.delete(new Request(PATTERN_CACHE_KEY));
    } catch (e2) {
      console.error("norg edge feed cache purge failed", e2);
    }
  }
}

/**
 * Drop entitlement after NORG refuses this install (401/403).
 *
 * Stamps the short-lived negative verdict at both cache levels: the refused
 * install stops diverting immediately, and neither this isolate nor a colo-mate
 * re-probes NORG on every request while the refusal stands.
 *
 * @param {Object} cache Cache API instance.
 * @returns {Promise<void>}
 */
async function revokeFeed(cache) {
  await stampNegativeFeed(cache);
}

/**
 * Refresh the authenticated feed from NORG.
 *
 * Separates a refusal from an outage, because they mean opposite things: a
 * 401/403 is NORG saying this install may not serve, and is obeyed at once; a
 * timeout or network error says nothing about entitlement and must never
 * revoke a working install.
 *
 * @param {Object} env Worker bindings.
 * @param {Object} cache Cache API instance.
 * @returns {Promise<{outcome: string, entry: ?Object}>} outcome is
 *   "ok" | "refused" | "unreachable".
 */
async function refreshFeed(env, cache) {
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PATTERN_FETCH_TIMEOUT_MS);
    response = await fetch(`${binding(env, "NORG_API_URL")}/api/v1/edge/bot-patterns`, {
      method: "GET",
      headers: controlHeaders(env),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.error("norg edge feed refresh failed", e);
    return { outcome: "unreachable", entry: null };
  }

  if (REFUSAL_STATUSES.has(response.status)) {
    await revokeFeed(cache);
    return { outcome: "refused", entry: null };
  }
  if (!response.ok) return { outcome: "unreachable", entry: null };

  const entry = await readFeedBody(response);
  if (!entry) return { outcome: "unreachable", entry: null };
  feedCache = entry;
  await writeFeedCache(cache, entry);
  return { outcome: "ok", entry };
}

/**
 * Get the authenticated feed, preferring speed over freshness.
 *
 * Isolate cache, then colo cache, then the network. A stale-but-entitled entry
 * is served immediately with the refresh moved behind the response, so neither
 * a slow NORG nor a NORG outage adds latency or withdraws a working install.
 * A fresh negative verdict (from a refusal, or an outage with nothing cached)
 * short-circuits with no network call for UNENTITLED_TTL_MS; the serve-stale
 * path always wins, so the negative cache never overrides it.
 *
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @returns {Promise<Object>} Feed with entitled, patterns and cidrRanges.
 */
async function getBotFeed(env, ctx) {
  const now = Date.now();
  if (feedCache.entitled && now - feedCache.fetchedAt < feedCache.ttl) return feedCache;
  // A fresh negative verdict: a paused/unreachable install costs the visitor no
  // NORG round trip until the TTL expires and one request re-probes.
  if (!feedCache.entitled && feedCache.fetchedAt && now - feedCache.fetchedAt < feedCache.ttl) {
    return feedCache;
  }

  const cache = caches.default;
  const cached = await readCachedFeed(cache);
  if (cached) {
    feedCache = cached;
    // A fresh entry — entitled or negative — is honoured with no probe.
    if (now - cached.fetchedAt < cached.ttl) return cached;
    // A stale ENTITLED entry is served now and refreshed behind the response.
    // A stale negative entry must NOT serve stale — it falls through to re-probe.
    if (cached.entitled) {
      ctx.waitUntil(refreshFeed(env, cache));
      return cached;
    }
  }

  const { outcome, entry } = await refreshFeed(env, cache);
  if (outcome === "ok") return entry;
  // A refusal already stamped the negative verdict inside refreshFeed; an
  // unreachable probe with nothing usable cached stamps it here so the next
  // request (and cold colo-mates) skip the blocking fetch for the window.
  if (outcome === "unreachable") await stampNegativeFeed(cache);
  return feedCache;
}

/**
 * Report a classified visit to NORG.
 * @param {Object} env Worker bindings.
 * @param {Request} request Incoming request.
 * @param {Object} classification Bot classification.
 * @param {string} served How the request was answered.
 * @param {number|null} rawWordCount Visible words in the raw (non-JS) origin,
 *   reused from the strip-floor check; null when no count was computed.
 * @param {number|null} responseStatus HTTP status of the response actually
 *   returned to the agent, so analytics can tell a served page from a 404 or
 *   error by status rather than by path. null only where no
 *   response was resolved before logging.
 * @returns {Promise<void>}
 */
async function logEdgeEvent(env, request, classification, served, rawWordCount = null, responseStatus = null) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  await postControl(env, "/api/v1/edge/events", {
    domain: url.hostname,
    path: url.pathname,
    user_agent: request.headers.get("user-agent") || null,
    is_ai_bot: classification.is_ai_bot,
    bot_name: classification.bot_name,
    company: classification.company,
    purpose: classification.purpose,
    served,
    raw_word_count: rawWordCount,
    response_status: responseStatus,
    ip_country: cf.country || null,
    ip_city: cf.city || null,
    asn: cf.asn || null,
    as_organization: cf.asOrganization || null,
    colo: cf.colo || null,
    http_protocol: cf.httpProtocol || null,
    tls_version: cf.tlsVersion || null,
  });
}

/**
 * Send a heartbeat if enough time has passed in this isolate.
 * @param {Object} env Worker bindings.
 * @param {string} trigger "traffic" or "cron".
 * @returns {Promise<void>}
 */
async function maybeHeartbeat(env, trigger) {
  const now = Date.now();
  if (trigger === "traffic" && now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
    return;
  }
  lastHeartbeatAt = now;
  await postControl(env, "/api/v1/edge/heartbeat", {
    script_version: EDGE_SCRIPT_VERSION,
    trigger,
    // The environment this worker believes it is bound to (edgeEnv's
    // "unknown" when EDGE_ENV is absent). NORG warns when this disagrees with
    // the environment it can confirm, surfacing a wrong-env manual install.
    env: edgeEnv(env),
  });
}

/**
 * Ask NORG to render a path, at most once per path per isolate window.
 *
 * Fired only when R2 returned a definite 404. A timeout or network error is
 * NOT a miss — reporting those would let an R2 outage look like every page
 * vanishing, and NORG would re-render the whole site.
 *
 * @param {Object} env Worker bindings.
 * @param {URL} url Requested URL.
 * @returns {Promise<void>}
 */
async function requestRender(env, url) {
  const now = Date.now();
  const seenAt = renderDedup.get(url.pathname);
  if (seenAt && now - seenAt < RENDER_DEDUP_TTL_MS) return;

  // Bounded: drop the oldest entry rather than let an isolate grow forever.
  if (renderDedup.size >= RENDER_DEDUP_MAX_ENTRIES) {
    renderDedup.delete(renderDedup.keys().next().value);
  }
  renderDedup.set(url.pathname, now);

  await postControl(env, "/api/v1/edge/render-requests", {
    path: url.pathname,
    url: url.toString(),
    reason: "bot_miss",
  });
}

/**
 * Join the receptionist base and this install's site id into a URL stem.
 *
 * The receptionist's URL contract is /{site_id}/{path}: the site id lives in
 * the URL so every cache key — the receptionist's colo cache AND this
 * worker's cf-cache on the subrequest below — is tenant-unique. A bare
 * /{path} URL would let one customer's cached page answer a colo-mate's
 * request for another site. The workspace content prefix is resolved by the
 * receptionist from the authenticated site, never sent from here.
 *
 * @param {Object} env Worker bindings.
 * @returns {string} Base + "/" + site id, no trailing slash.
 */
function contentStem(env) {
  const base = binding(env, "NORG_CONTENT_BASE").replace(/\/+$/, "");
  return `${base}/${env.SITE_ID || ""}`;
}

/**
 * Fetch a NORG-rendered object for this path from the edge-content
 * receptionist (an authenticated NORG-account worker — the mirror bucket
 * itself is never public).
 *
 * One round trip: a 200 is the render and a 404 is a definite miss — there is
 * no separate existence check. The site id/key headers authenticate this
 * install.
 *
 * DELIBERATELY NO `cf: { cacheEverything }` HERE. Cloudflare keys that cache
 * on the URL alone — the site key is not part of the key — so caching an
 * authenticated response there would let any caller replay another tenant's
 * render by requesting the same URL without credentials, and would keep
 * serving it for the TTL after a key was revoked. Site-id-in-URL makes the
 * key tenant-unique, not tenant-private. Repeat reads are absorbed by the
 * receptionist's own colo cache, which sits BEHIND its auth check, so R2
 * still only sees cold misses.
 *
 * @param {Object} env Worker bindings.
 * @param {string} keySuffix Key suffix from pathToKeySuffix.
 * @returns {Promise<{response: ?Response, missing: boolean}>} missing is true
 *   only for a definite 404, never for an error or timeout.
 */
async function fetchFromNorg(env, keySuffix) {
  const target = `${contentStem(env)}${keySuffix}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIRROR_FETCH_TIMEOUT_MS);
    const response = await fetch(target, {
      headers: { ...controlHeaders(env), [LOOP_GUARD_HEADER]: "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.status === 404) return { response: null, missing: true };
    if (!response.ok) return { response: null, missing: false };
    return { response, missing: false };
  } catch (e) {
    console.error("norg edge mirror fetch failed", e);
    return { response: null, missing: false };
  }
}

/**
 * Forbid every cache — browser, proxy, and CDN — from storing a response.
 *
 * Diverted responses carry per-agent content and must never be replayed to a
 * human. no-store is the authoritative directive; CDN-Cache-Control repeats it
 * for CDN tiers that read their own header. Vary is intentionally not set.
 *
 * @param {Headers} headers Response headers to mutate in place.
 * @returns {void}
 */
function setNonCacheable(headers) {
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "private, no-store");
}

/**
 * Serve a NORG render at the customer's URL.
 *
 * Deliberately not noindex: this IS the customer's page as far as an agent is
 * concerned, and it carries a canonical link to this same URL.
 *
 * @param {Response} norgResponse Response from R2.
 * @param {Object} env Worker bindings.
 * @returns {Response} Response for the visitor.
 */
function mirrorResponse(norgResponse, env) {
  const headers = new Headers();
  // Trust what R2 stored; renders are HTML but the namespace can hold others.
  headers.set(
    "Content-Type",
    norgResponse.headers.get("content-type") || "text/html; charset=utf-8",
  );
  headers.set("X-Norg-Edge", "mirror");
  // A diverted response must never be handed to a human, so it is storable by
  // nobody. Vary: User-Agent is deliberately NOT used — it is advisory and
  // CDNs variously normalise, collapse, or ignore it, which is the exact
  // failure (a shopper served a spec sheet) this replaces. private, no-store
  // forbids every cache; CDN-Cache-Control repeats it for CDN tiers that read
  // their own header. The R2 object is still edge-cached on the internal
  // subrequest in fetchFromNorg (NORG's own content) and is unaffected.
  setNonCacheable(headers);
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Strip an origin HTML response to a token-dense form.
 *
 * HTMLRewriter itself streams, but note the caller does not: serveStrippedOrigin
 * buffers this whole response via .text() to apply the word floor, while holding
 * an unread clone of the origin. Both bodies are therefore resident at once, on
 * the customer's Workers quota, which we are spending on their behalf. That is
 * accepted — the floor cannot be decided without measuring first, and a page
 * large enough to matter against the 128MB isolate limit does not exist in
 * practice — but it is not free, so do not add a third pass here.
 *
 * @param {Response} response Origin response.
 * @param {Object} env Worker bindings.
 * @returns {Response} Stripped response.
 */
function stripHtml(response, env) {
  let rewriter = new HTMLRewriter();
  for (const selector of STRIP_REMOVE_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        element.remove();
      },
    });
  }
  for (const selector of STRIP_UNWRAP_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        element.removeAndKeepContent();
      },
    });
  }
  rewriter = rewriter.on("*", {
    element(element) {
      for (const [name] of [...element.attributes]) {
        if (!shouldKeepAttribute(name.toLowerCase())) {
          element.removeAttribute(name);
        }
      }
    },
    comments(comment) {
      comment.remove();
    },
  });

  const stripped = rewriter.transform(response);
  const headers = new Headers(stripped.headers);
  headers.set("X-Norg-Edge", "stripped");
  // A stripped response is diverted too — never cacheable, and no Vary. It is
  // superseded as soon as the render we just requested lands.
  setNonCacheable(headers);
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(stripped.body, { status: response.status, headers });
}

/**
 * Is this an exact discovery-artifact path?
 *
 * llms.txt / llms-full.txt / tree.json / graph.jsonld / agents.md are discovery
 * infrastructure, served to EVERY caller at a fixed URL — so only these exact
 * paths match, never a customer page that merely ends in the same name.
 *
 * agents.md is the capability contract (what this site is, which protocols it
 * speaks, which endpoints an agent may call). NORG publishes it beside the
 * other five artifacts under edge/{workspace}/, but until 0.11.5 this worker
 * did not route it, so a customer-zone mirror answered /agents.md from the
 * origin — a 404 on every site that does not author one itself.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for the five exact discovery-artifact paths.
 */
function isDiscoveryPath(pathname) {
  return (
    pathname === "/llms.txt" ||
    pathname === "/llms-full.txt" ||
    pathname === "/tree.json" ||
    pathname === "/graph.jsonld" ||
    pathname === "/agents.md"
  );
}

// Per-page sibling artifacts published beside index.html (MIRROR 03) and
// advertised by absolute URL in that page's mcp.json alternates. Matched by
// filename in ANY directory, since every mirrored route publishes its own set.
const SIBLING_ARTIFACT_FILENAMES = new Set([
  "index.md",
  "index.json",
  "index.jsonld",
  "index.pdf",
  "index.openai.json",
  "webmcp.js",
]);

/**
 * Is this pathname a published per-page sibling artifact?
 *
 * These are advertised to agents in mcp.json but were reachable by nobody:
 * webmcp.js and index.pdf were answered by the static-asset floor, and the
 * rest only ever reached a UA-and-IP-verified bot — so every MCP client that
 * read the manifest and fetched an alternate got the origin's 404.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for a sibling artifact filename in any directory.
 */
function isSiblingArtifactPath(pathname) {
  return SIBLING_ARTIFACT_FILENAMES.has(
    pathname.slice(pathname.lastIndexOf("/") + 1),
  );
}

/**
 * Serve a NORG-published artifact origin-first (discovery files and per-page
 * siblings alike).
 *
 * Origin-first: probe the customer origin (carrying the loop-guard header so
 * our own subrequest is not reprocessed by this worker). A 200 with a
 * non-HTML content type is the customer's own file and wins — passed through
 * byte-for-byte, the NORG copy never consulted. A 404/error, or an HTML 200
 * (a SPA soft-404, not a real artifact), means the origin has none, so the
 * NORG copy is served from the receptionist. On a receptionist miss the origin
 * response is returned verbatim — never a synthesised NORG error page.
 *
 * Served to every caller with no classification and no source-IP check:
 * identical bytes for all carries zero cloaking risk. Logs no crawler visit
 * and triggers no render — a pure read-and-serve.
 *
 * `alternateFormatHeaders` is OPT-IN and true only for the per-page siblings,
 * which are format variants of a page that exists. It must stay off for the
 * discovery files: deriveCanonicalUrl would read /tree.json and /graph.jsonld
 * as variants and stamp them with a rel=canonical to /tree/ and /graph/ —
 * URLs that do not exist. It is never applied to the ORIGIN response either;
 * the customer's own file is theirs, and re-heading it with our noindex would
 * be this worker altering a page it does not own.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {URL} url Parsed request URL.
 * @param {Object} [options] Serving options.
 * @param {boolean} [options.alternateFormatHeaders] Apply the cross-format
 *   canonical Link + X-Robots-Tag: noindex treatment to a NORG-served copy.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveOriginFirstArtifact(
  request,
  env,
  url,
  { alternateFormatHeaders = false } = {},
) {
  const probeHeaders = new Headers(request.headers);
  probeHeaders.set(LOOP_GUARD_HEADER, "1");
  let origin = null;
  try {
    origin = await fetch(new Request(request, { headers: probeHeaders }));
  } catch (e) {
    console.error("norg edge artifact origin probe failed", e);
  }
  if (origin && origin.status === 200) {
    const contentType = origin.headers.get("content-type") || "";
    // A real llms.txt/tree.json is never HTML; an HTML 200 is a SPA soft-404.
    if (!/text\/html/i.test(contentType)) return origin;
  }
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (response) {
    const served = mirrorResponse(response, env);
    return alternateFormatHeaders
      ? withAlternateFormatHeaders(served, url, url.pathname)
      : served;
  }
  return origin || fetch(request);
}

/**
 * Is this a reserved NORG asset path (/.norg/*)?
 *
 * The whole prefix is NORG-owned (the mirror shell's theme stylesheet lives at
 * /.norg/theme.css) and does not exist on the customer origin, so it is served
 * to every caller before classification — never a cloaking surface, since the
 * bytes are identical for all.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True when the path is under the reserved /.norg/ prefix.
 */
function isReservedNorgPath(pathname) {
  return pathname.startsWith(RESERVED_NORG_PREFIX);
}

/**
 * Serve a reserved NORG asset (e.g. /.norg/theme.css) from the receptionist.
 *
 * A pure asset read-and-serve: no classification, no source-IP check, no render
 * request, and no crawler-visit event — these are asset fetches, not visits. On
 * a hit the bytes are re-served with PUBLIC cache headers (a shared asset, not
 * tenant content, so NOT mirrorResponse's private/no-store). A miss falls
 * through to the customer origin exactly like any other NORG miss — never a
 * synthesised error page.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveReservedNorgAsset(request, env, url) {
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (!response) return fetch(request);
  const headers = new Headers();
  headers.set(
    "Content-Type",
    response.headers.get("content-type") || "text/css; charset=utf-8",
  );
  headers.set("Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("CDN-Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("X-Norg-Edge", "reserved-asset");
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(response.body, { status: 200, headers });
}

// Site-level OpenAI product-feed discovery artifacts (MIRROR 10). Published to
// R2 only when the site has product pages on a paid plan; they never exist on
// the customer origin, so they are served to every caller before classification
// (identical bytes for all — not a cloaking surface) and a miss falls through to
// origin. No render request and no crawler-visit event.
const OPENAI_FEED_PATHS = new Set([
  "/.well-known/ai-plugin.json",
  "/openapi.json",
  "/openapi.yaml",
]);

/**
 * Is this one of the three site-level OpenAI feed artifact paths?
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for the ai-plugin.json / openapi.json / openapi.yaml paths.
 */
function isOpenAiFeedPath(pathname) {
  return OPENAI_FEED_PATHS.has(pathname);
}

// Subresource extensions that are never a mirrorable document. A request for
// one is the browser fetching part of a page, not an agent asking for the page
// — NORG has no mirror for it and never will, so the whole pipeline
// (classification, R2 lookup, render request, visit logging) is pure waste.
//
// Mirrors _ASSET_SUFFIXES in app/services/edge_routing/render_requests.py,
// which is the source of truth, MINUS .xml/.txt/.json — those are excluded on
// purpose: /llms.txt, /tree.json, /graph.jsonld, /.well-known/mcp.json and
// /openapi.json are NORG's own surfaces and a blanket rule here would proxy
// them to the customer's origin. Do NOT "complete" this list from any other
// copy: NORG's own test suite fails if the subset breaks.
//
// Extension-less asset URLs (/img?id=123) are not covered. Sec-Fetch-Dest
// would catch them, but it is a browser fetch-metadata convention that
// scripted agent traffic often omits, so it is a future addition rather than a
// replacement for this list. To drop these requests before the Worker is
// invoked at all, the tool is a zone-level Cloudflare Cache/route rule on the
// customer's zone — configuration, not code.
const STATIC_ASSET_SUFFIXES = new Set([
  ".css", ".js", ".mjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif", ".bmp",
  ".tiff", ".heic",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".ogv",
  ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".weba",
  ".vtt", ".srt",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".gz", ".rar", ".tar", ".7z",
  ".webmanifest",
]);

/**
 * Is this pathname a static subresource rather than a document request?
 *
 * Reads the extension of the LAST path segment only, so a dot in a directory
 * ("/v1.2/page") is not mistaken for one. Ambiguous shapes deliberately answer
 * false: a missed asset costs the wasted lookups this check exists to avoid,
 * but a document wrongly called an asset is never mirrored at all — so the
 * cheaper mistake is the one to make.
 *
 * @param {string} pathname Request pathname (never includes the query string).
 * @returns {boolean} True when the request is for a static asset.
 */
function isStaticAssetPath(pathname) {
  const lastSlash = pathname.lastIndexOf("/");
  const segment = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
  const dot = segment.lastIndexOf(".");
  // No dot, leading-dot dotfile, or trailing dot: not an extension we know.
  if (dot <= 0 || dot === segment.length - 1) return false;
  return STATIC_ASSET_SUFFIXES.has(segment.slice(dot).toLowerCase());
}

/**
 * Normalise a request pathname to the stored EdgeRoute.path form for the
 * per-route skip membership test: guaranteed leading "/", internal repeated
 * slashes collapsed, and no trailing slash except root (mirrors the backend
 * paths.normalise_path rule, which collapses "//" when storing routes — so a
 * "/a//b" request must match the stored "/a/b").
 * @param {string} pathname url.pathname (always starts with "/").
 * @returns {string} The normalised path.
 */
function normaliseSkipPath(pathname) {
  if (pathname.length <= 1) return pathname;
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.replace(/\/+$/, "") || "/";
}

/**
 * Has the operator marked this page to pass through to the origin?
 *
 * One implementation for both callers — the page itself and a sibling
 * artifact's owning page — so the two can never disagree about what "skipped"
 * means.
 *
 * @param {Object} feed Bot-pattern feed (carries skipPaths).
 * @param {string} pathname Path to test, in request form.
 * @returns {boolean} True when this path is excluded from the mirror.
 */
function isSkippedPath(feed, pathname) {
  return Boolean(
    feed.skipPaths && feed.skipPaths.includes(normaliseSkipPath(pathname)),
  );
}

/**
 * The page a sibling artifact belongs to: "/about/index.md" → "/about",
 * "/webmcp.js" → "/".
 *
 * Siblings are published into their page's own directory, so dropping the
 * filename yields the route path the skip feed lists.
 *
 * @param {string} pathname Sibling artifact pathname.
 * @returns {string} The owning page's path.
 */
function siblingPageOf(pathname) {
  return pathname.slice(0, pathname.lastIndexOf("/")) || "/";
}

/**
 * Serve a site-level OpenAI feed artifact from the receptionist (MIRROR 10).
 *
 * Origin-first, every-caller (story-04): a pure read-and-serve with no
 * classification, no render request and no crawler-visit event. A miss falls
 * through to the customer origin, never a synthesised error page.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveOpenAiFeed(request, env, url) {
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (!response) return fetch(request);
  const headers = new Headers();
  headers.set(
    "Content-Type",
    url.pathname.endsWith(".yaml")
      ? "application/yaml"
      : "application/json; charset=utf-8",
  );
  headers.set("Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("CDN-Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("X-Norg-Edge", "openai-feed");
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(response.body, { status: 200, headers });
}

/**
 * Is this an MCP surface path?
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for MCP endpoints.
 */
function isMcpPath(pathname) {
  return (
    pathname === "/.well-known/mcp.json" ||
    pathname.endsWith("/mcp") ||
    pathname.endsWith("/sse")
  );
}

/**
 * Serve the MCP surface for a page, matching NORG-hosted pages.
 *
 * GET reads the static artifact published alongside the render. POST is the
 * JSON-RPC transport and is forwarded to NORG. A miss falls through to the
 * origin — for GET and POST alike — so a customer's own /mcp route keeps
 * working (rule 1). The POST request is cloned before forwarding so its
 * one-shot body survives for the origin fallback when NORG cannot serve it.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} Response, or null to fall through to origin.
 */
async function handleMcp(request, env, url) {
  if (request.method === "POST") return forwardMcpToNorg(request.clone(), env, url);
  // GET and HEAD share the descriptor lookup; the entry point drops the body
  // for HEAD, so both report the same status and headers.
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  // "/products/x/mcp" -> "/products/x/mcp.json"; "/mcp" -> "/mcp.json".
  const suffix =
    url.pathname === "/.well-known/mcp.json"
      ? "/.well-known/mcp.json"
      : `${url.pathname.replace(/\/(mcp|sse)$/, "")}/mcp.json`;

  const { response } = await fetchFromNorg(env, suffix);
  if (!response) return null;

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Norg-Edge", "mcp");
  return new Response(response.body, { status: 200, headers });
}

/**
 * Forward an MCP JSON-RPC request to NORG's public MCP endpoint.
 *
 * Returns NORG's response ONLY when NORG can serve the request; otherwise
 * returns null so the caller falls back to the customer origin (rule 1).
 *
 * The 2xx/transport boundary is status-based:
 *   - HTTP 2xx is returned as-is. A JSON-RPC application error (e.g. method
 *     not found) arrives as HTTP 200 and IS the caller's answer — it is not a
 *     NORG failure, so it is returned, not fallen back on.
 *   - Any non-2xx (transport-level 401/403/404/5xx), a thrown fetch, or the
 *     bounded timeout aborting means "NORG cannot serve this" -> return null.
 *
 * The fetch is bounded by MCP_FORWARD_TIMEOUT_MS so an unreachable or hung
 * NORG costs the visitor at most that budget before the origin fallback,
 * rather than relying on the platform default.
 *
 * Only the headers JSON-RPC needs are relayed (lib/mcp-forward.mjs): a Cookie
 * or Authorization header sent to the customer's domain never reaches NORG.
 *
 * @param {Request} request Incoming request (already cloned by the caller so
 *   its one-shot body survives for the origin fallback).
 * @param {Object} env Worker bindings.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} NORG's 2xx response, or null on any miss/error.
 */
async function forwardMcpToNorg(request, env, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_FORWARD_TIMEOUT_MS);
  try {
    const headers = mcpForwardHeaders(request.headers);
    headers.set("X-Norg-Site-Id", env.SITE_ID || "");
    headers.set("X-Norg-Site-Key", env.NORG_SITE_KEY || "");
    headers.set("X-Norg-Edge-Page", url.pathname);
    // The trailing slash is load-bearing. The mount's streamable-HTTP route is
    // at "/", so "/public-mcp" answers 307 to "/public-mcp/" — and this POST's
    // body is a one-shot stream that cannot be replayed onto the redirect, so
    // the forward failed and every advertised MCP client fell through to the
    // origin's 404.
    const response = await fetch(`${binding(env, "NORG_API_URL")}/public-mcp/`, {
      method: "POST",
      headers,
      body: request.body,
      signal: controller.signal,
    });
    return response.ok ? response : null;
  } catch (e) {
    console.error("norg edge mcp forward failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which NORG environment this worker is bound to.
 *
 * Defaults to "unknown" rather than "production": an install whose environment
 * we cannot name is exactly the one nobody should assume is safe.
 *
 * @param {Object} env Worker bindings.
 * @returns {string} "production" | "test" | "unknown".
 */
function edgeEnv(env) {
  return env.EDGE_ENV || "unknown";
}

/**
 * Answer an authenticated health probe.
 * @param {Object} env Worker bindings.
 * @returns {Response} JSON status.
 */
function healthResponse(env) {
  return new Response(
    JSON.stringify({
      site_id: env.SITE_ID || null,
      version: EDGE_SCRIPT_VERSION,
      env: edgeEnv(env),
      disabled: binding(env, "EDGE_DISABLED") === "true",
      // Whether this isolate currently holds an authenticated feed. The first
      // question to ask when an install is "doing nothing" — an unentitled
      // worker passes everything through and is otherwise indistinguishable
      // from not being installed at all.
      entitled: feedCache.entitled,
      ts: Date.now(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Should this request skip interception entirely?
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @returns {boolean} True to pass straight to origin.
 */
/**
 * Is this a path NORG owns and serves itself, before any classification?
 *
 * The four pure read-and-serve surfaces: MCP descriptors, the discovery
 * artifacts, the reserved /.norg/ assets and the site-level OpenAI feed. Each
 * is served to EVERY caller from identical bytes, emits no crawler-visit event
 * and triggers no render — which is exactly why a HEAD may be answered from
 * them (see isPassthrough). The agentic subtree is deliberately NOT here: it
 * heartbeats and can drive a render, so it keeps GET-only semantics.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True when this worker, not the origin, owns the path.
 */
function isNorgOwnedArtifactPath(pathname) {
  return (
    isMcpPath(pathname) ||
    isDiscoveryPath(pathname) ||
    isReservedNorgPath(pathname) ||
    isOpenAiFeedPath(pathname)
  );
}

function isPassthrough(request, env) {
  if (binding(env, "EDGE_DISABLED") === "true") return true;
  if (request.headers.get(LOOP_GUARD_HEADER)) return true;
  if (request.headers.get("upgrade")) return true;
  // MCP is the one surface that accepts POST (JSON-RPC transport); every
  // other non-GET method belongs to the customer's application.
  const method = request.method;
  if (method === "GET") return false;
  // HEAD must answer with the SAME status and headers as GET (RFC 9110), and
  // these paths exist only in NORG's R2 — passing HEAD to the origin made every
  // one of them 404 while GET returned 200, so any client that probes with HEAD
  // concluded the artifacts were missing. Scoped to the paths this worker owns:
  // a HEAD to a customer page still belongs to their application.
  if (method === "HEAD" && isNorgOwnedArtifactPath(new URL(request.url).pathname))
    return false;
  if (method === "POST" && isMcpPath(new URL(request.url).pathname)) return false;
  return true;
}

/**
 * Is this an authenticated health probe rather than a real visit?
 *
 * The probe key is compared in constant time (see lib/constant-time.mjs) so the
 * site key cannot be recovered by timing repeated guesses. A successful probe
 * reveals only the site id and script version.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @returns {Promise<boolean>} True when the probe key matches.
 */
async function isHealthProbe(request, env) {
  const probeKey = request.headers.get(HEALTH_CHECK_HEADER);
  if (!probeKey || !env.NORG_SITE_KEY) return false;
  return constantTimeEqual(probeKey, env.NORG_SITE_KEY);
}

/**
 * The serving policy NORG published for a matched pattern.
 *
 * Looked up separately rather than returned by classifyRequest, because that
 * function is asserted byte-for-byte against r2-proxy-worker.js by the parity
 * test — the two must keep agreeing on WHICH crawler a user-agent is, even
 * though only this worker acts on the policy.
 *
 * @param {?string} botName Matched pattern string.
 * @param {Array} patterns Patterns from NORG.
 * @returns {?string} Published policy, or undefined when the feed omits it.
 */
function servingPolicyFor(botName, patterns) {
  const match = patterns.find((p) => p.pattern === botName);
  return match ? match.serving_policy : undefined;
}

/**
 * Classify a visitor: named patterns first, then script automation.
 *
 * The returned classification carries the published serving_policy so the
 * divert decision is NORG's to make, not this file's.
 *
 * @param {string} userAgent Raw User-Agent header.
 * @param {Array} patterns Patterns from NORG.
 * @returns {Object} Classification.
 */
function classifyAgent(userAgent, patterns) {
  const patternMatch = classifyRequest(userAgent, patterns);
  if (patternMatch.is_ai_bot) {
    return {
      ...patternMatch,
      serving_policy: servingPolicyFor(patternMatch.bot_name, patterns),
    };
  }
  // Script automation is not in ai_bot_patterns, so NORG publishes no policy
  // for it. Migration 495's default is never_divert and that is what applies:
  // curl and friends are identified for analytics, never served the mirror.
  const automation = classifyScriptAutomation(userAgent);
  if (automation) return { ...automation, serving_policy: "never_divert" };
  return patternMatch;
}

/**
 * Has NORG authorised diverting this agent?
 *
 * Anything other than an explicit "divert" passes through, so a newly-added or
 * unclassified pattern is fail-safe by construction (migration 495 defaults
 * every row to never_divert) and an operator can withdraw a crawler from
 * diverting by flipping one column, with no worker redeploy.
 *
 * @param {Object} classification Classification from classifyAgent.
 * @returns {boolean} True only when the published policy is "divert".
 */
function mayDivert(classification) {
  return classification.serving_policy === "divert";
}

/**
 * Verify the source against the operator's published CIDR set.
 *
 * Family-aware (lib/cidr.mjs): an IPv6 client is measured against the
 * operator's IPv6 ranges when any are published, and is unmeasurable — null,
 * never false — when none are, so a crawler of an IPv4-only operator is not
 * refused for arriving over IPv6.
 *
 * @param {Request} request Incoming request.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {?boolean} Verdict, or null when no usable CIDR set applies and the
 *   caller must fall back to Cloudflare's own verification.
 */
function cidrVerdict(request, cidrRanges, classification) {
  return cidrVerdictFor(request.headers.get("cf-connecting-ip"), cidrRanges, classification);
}

/**
 * Is the request's source genuinely the operator it claims to be?
 *
 * A User-Agent alone is trivially spoofable (`curl -A "GPTBot/1.4"`), so a
 * divert candidate is only trusted when its source IP is verified. Story 12
 * specifies the operator CIDR sets published by story 11's refresh pipeline as
 * the check, with Cloudflare's own signal as the per-zone fallback where no set
 * applies — CIDR is authoritative when present precisely because it is
 * operator-specific: cf.verifiedBotCategory only says "some verified bot", so
 * it would let a verified Googlebot presenting a GPTBot UA through.
 *
 * Fails CLOSED: no signal at all means not verified, so the request falls
 * through to the origin.
 *
 * @param {Request} request Incoming request.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {boolean} True only when the source is verified.
 */
function verifiedSource(request, cidrRanges, classification) {
  const byCidr = cidrVerdict(request, cidrRanges, classification);
  if (byCidr !== null) return byCidr;
  const cf = request.cf || {};
  return Boolean(cf.verifiedBotCategory) || cf.botManagement?.verifiedBot === true;
}

/**
 * May this origin response be stripped?
 * @param {Object} env Worker bindings.
 * @param {Response} originResponse Response from the customer's origin.
 * @returns {boolean} True when stripping is enabled and the body is HTML.
 */
function canStrip(env, originResponse) {
  if (binding(env, "STRIP_FALLBACK_ENABLED") === "false") return false;
  if (!originResponse.ok) return false;
  return (originResponse.headers.get("content-type") || "").includes("text/html");
}

/**
 * Count the visible words left in an HTML string after tags are removed.
 *
 * Used to decide whether a strip left enough content to be worth serving.
 *
 * @param {string} html HTML to measure.
 * @returns {number} Whitespace-delimited word count of the tag-free text.
 */
function countVisibleWords(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}

/**
 * Serve the origin, stripped to a token-dense form where possible.
 *
 * If the strip leaves fewer than STRIP_WORD_FLOOR visible words (a
 * client-rendered origin whose real content the strip removes), the stripped
 * page carries less than the origin — so serve the untouched origin and label
 * the event "origin_thin". The async NORG render will supersede it.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @param {Object} classification Bot classification.
 * @returns {Promise<Response>} Response for the agent.
 */
async function serveStrippedOrigin(request, env, ctx, classification) {
  const originResponse = await fetch(request);
  if (!canStrip(env, originResponse)) {
    ctx.waitUntil(logEdgeEvent(env, request, classification, "origin", null, originResponse.status));
    return originResponse;
  }
  const originClone = originResponse.clone();
  const strippedResponse = stripHtml(originResponse, env);
  const strippedHtml = await strippedResponse.text();
  // Story 13: reuse the strip-floor word count (no second pass) as the raw
  // origin word count logged with the served event.
  const rawWordCount = countVisibleWords(strippedHtml);
  if (rawWordCount < STRIP_WORD_FLOOR) {
    ctx.waitUntil(
      logEdgeEvent(env, request, classification, "origin_thin", rawWordCount, originClone.status),
    );
    return originClone;
  }
  ctx.waitUntil(
    logEdgeEvent(env, request, classification, "stripped", rawWordCount, strippedResponse.status),
  );
  return new Response(strippedHtml, {
    status: strippedResponse.status,
    headers: strippedResponse.headers,
  });
}

/**
 * Resolve the response-cache context for this request, or null to bypass it.
 *
 * Returns null (serve straight from R2, today's exact behaviour) unless the feed
 * enables the cache AND carries a content_version AND this install has a SITE_ID.
 * The key folds SITE_ID + content_version + path suffix under a synthetic
 * internal origin, so it is tenant-unique and never reachable via the customer
 * URL; a publish (new content_version) yields a new key and self-invalidates.
 *
 * @param {Object} env Worker bindings.
 * @param {Object} feed Authenticated feed (responseCache, contentVersion).
 * @param {string} keySuffix Path suffix from pathToKeySuffix.
 * @returns {?{cache: Object, key: string, ttl: number}} Context, or null.
 */
function responseCacheContext(env, feed, keySuffix) {
  const rc = feed && feed.responseCache;
  if (!rc || !rc.enabled) return null;
  const version = feed.contentVersion;
  if (!version || !env.SITE_ID) return null;
  return {
    cache: caches.default,
    key: `${RESPONSE_CACHE_KEY_PREFIX}${env.SITE_ID}/${version}${keySuffix}`,
    ttl: rc.ttl,
  };
}

/**
 * Read a cached mirror copy, swallowing any Cache API failure as a miss.
 * @param {Object} cache Cache API instance.
 * @param {string} key Synthetic response-cache key.
 * @returns {Promise<?Response>} The stored copy, or null on miss/error.
 */
async function readResponseCache(cache, key) {
  try {
    return (await cache.match(new Request(key))) || null;
  } catch (e) {
    console.error("norg edge response cache read failed", e);
    return null;
  }
}

/**
 * Store a mirror copy under the synthetic key, swallowing every failure.
 *
 * A cache.put failure must never turn a successful serve into an error, so it is
 * best-effort and logged only (edge-content-proxy cacheQuietly idiom).
 *
 * @param {Object} cache Cache API instance.
 * @param {string} key Synthetic response-cache key.
 * @param {Response} response The cacheable copy to store.
 * @returns {Promise<void>}
 */
async function cacheResponseQuietly(cache, key, response) {
  try {
    await cache.put(new Request(key), response);
  } catch (e) {
    console.error("norg edge response cache write failed", e);
  }
}

/**
 * Build a CACHEABLE copy of a NORG render for the Cache API.
 *
 * The visitor copy carries `private, no-store` (mirrorResponse) which cache.put
 * rejects, so the stored copy is a separate Response with an s-maxage TTL and no
 * no-store. On a hit it is re-wrapped through mirrorResponse, which re-applies
 * no-store — the human never receives a storable copy (two-response idiom).
 *
 * @param {Response} norgResponse Response from the receptionist.
 * @param {number} ttlSeconds Response-cache TTL in seconds.
 * @returns {Response} A cacheable Response.
 */
function cacheableMirror(norgResponse, ttlSeconds) {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    norgResponse.headers.get("content-type") || "text/html; charset=utf-8",
  );
  headers.set("Cache-Control", `s-maxage=${ttlSeconds}`);
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Serve an AI agent: the NORG render if it exists, else the stripped origin.
 *
 * When the feed enables the response cache, a warm entry is served without the
 * R2 round trip; a miss fetches once and stores a cacheable copy. Classification
 * and source verification already ran in handleRequest, and logEdgeEvent still
 * fires on every serve including a cache hit — a hit changes only where the
 * bytes come from, never the security or analytics path.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @param {URL} url Parsed request URL.
 * @param {Object} classification Bot classification.
 * @param {Object} feed Authenticated feed (response-cache config + version).
 * @returns {Promise<Response>} Response for the agent.
 */
async function serveAgent(request, env, ctx, url, classification, feed) {
  const keySuffix = pathToKeySuffix(url.pathname);
  const rc = responseCacheContext(env, feed, keySuffix);
  if (rc) {
    const hit = await readResponseCache(rc.cache, rc.key);
    if (hit) {
      const cached = withAlternateFormatHeaders(
        mirrorResponse(hit, env),
        url,
        url.pathname,
      );
      ctx.waitUntil(logEdgeEvent(env, request, classification, "mirror", null, cached.status));
      return cached;
    }
  }

  const { response, missing } = await fetchFromNorg(env, keySuffix);
  if (response) {
    ctx.waitUntil(logEdgeEvent(env, request, classification, "mirror", null, response.status));
    // A cache miss stores a separate cacheable copy (clone first — the visitor
    // copy consumes the body). Sibling formats (.md/.json/.jsonld/.pdf) carry a
    // canonical Link + noindex (MIRROR 03 AC3); HTML and the exempt mcp surfaces
    // are returned unchanged.
    if (rc) {
      ctx.waitUntil(
        cacheResponseQuietly(rc.cache, rc.key, cacheableMirror(response.clone(), rc.ttl)),
      );
    }
    return withAlternateFormatHeaders(
      mirrorResponse(response, env),
      url,
      url.pathname,
    );
  }

  // Only a definite 404 means "NORG has not rendered this yet". LAZY_RENDER_ENABLED
  // gates the render trigger: "false" runs a deployed-only edge that serves the
  // stripped origin on a miss without asking NORG to render (EDGEPAR 04).
  if (missing && binding(env, "LAZY_RENDER_ENABLED") !== "false") {
    ctx.waitUntil(requestRender(env, url));
  }

  return serveStrippedOrigin(request, env, ctx, classification);
}

/**
 * Is this path inside the site's agentic subtree?
 *
 * Matches the prefix itself and anything beneath it, but not a sibling that
 * merely starts with the same characters — "/ai" must not capture "/aircraft".
 *
 * @param {string} pathname Request pathname.
 * @param {string} prefix Configured prefix, e.g. "/ai".
 * @returns {boolean} True when the path is the prefix or inside it.
 */
function isAgenticPath(pathname, prefix) {
  if (!prefix) return false;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Serve the agentic subtree from the NORG render.
 *
 * Addressed by URL, not by caller: every visitor asking for this path gets the
 * same bytes, so there is no classification, no source-IP verification and no
 * cloaking question to answer. The prefix is stripped before the key lookup,
 * so /ai/products/widget resolves to the same object the customer's own
 * /products/widget would have mirrored to.
 *
 * A miss is a passthrough, never a synthesised 404: the subtree does not exist
 * on the customer's site, so their origin answers exactly as it always would.
 * No render is enqueued — this surface serves what NORG has already built.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @param {URL} url Parsed request URL.
 * @param {string} prefix Configured agentic prefix.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveAgenticPath(request, env, ctx, url, prefix) {
  const innerPath = url.pathname.slice(prefix.length) || "/";
  const { response } = await fetchFromNorg(env, pathToKeySuffix(innerPath));
  const classification = {
    is_ai_bot: false,
    bot_name: null,
    company: null,
    purpose: null,
  };

  if (!response) {
    const passthrough = await fetch(request);
    ctx.waitUntil(logEdgeEvent(env, request, classification, "agentic_path_miss", null, passthrough.status));
    return passthrough;
  }
  ctx.waitUntil(logEdgeEvent(env, request, classification, "agentic_path", null, response.status));
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * Does this request carry the ?agent=true force-serve override?
 *
 * Deliberately an OPEN bypass — no session, token, or workspace gating (explicit
 * product decision, 2026-08-04). SECURITY TENSION: this is a separate, intentional
 * door around the UA+IP verification stories 11/12 add — anyone appending
 * ?agent=true forces the R2 Agentic version of any edge-routed page. If this ever
 * needs revisiting, the fix is to add gating HERE, not to change verifiedSource().
 * Matched strictly against the lowercase literal "true" so it stays predictable.
 *
 * It does NOT open the traditional-search-engine floor. Story 17 AC1 originally
 * had the override beat the floor, which meant a linked or crawled ?agent=true
 * URL served Googlebot the render — cloaking, against rule 2 at the top of this
 * file. The floor now runs first; demo and QA traffic is unaffected because it
 * arrives with a browser user-agent, not a crawler's.
 *
 * @param {URL} url Parsed request URL.
 * @returns {boolean} True when ?agent=true is present.
 */
function hasAgentOverride(url) {
  return url.searchParams.get("agent") === "true";
}

/**
 * Synthetic classification for a ?agent=true override hit.
 *
 * Tags the event distinctly from genuine UA+IP-verified bot diverts so override
 * usage is visible in analytics (story 13) rather than inflating real-bot counts.
 *
 * @returns {Object} Classification identifying the override.
 */
function agentOverrideClassification() {
  return {
    is_ai_bot: true,
    bot_name: "agent_param_override",
    company: "agent_param_override",
    purpose: "override",
  };
}

/**
 * Serve the R2 Agentic mirror for a ?agent=true override, bypassing UA/IP
 * classification. Traditional search engines never reach here — the floor in
 * handleRequest runs first, so this cannot cloak.
 *
 * A mirror hit goes through mirrorResponse (private, no-store + CDN bypass so it
 * is never cached and replayed to a visitor without the param) and is tagged
 * served=agent_param_override. When no render exists there is nothing Agentic to
 * show, so the untouched origin is served (tagged agent_param_override_miss) — and,
 * unlike a genuine bot miss, NO render is enqueued: param-driven demo/QA traffic
 * must not be able to trigger renders across the catalogue.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveAgentOverride(request, env, ctx, url) {
  const classification = agentOverrideClassification();
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (response) {
    ctx.waitUntil(logEdgeEvent(env, request, classification, "agent_param_override", null, response.status));
    return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
  }
  const passthrough = await fetch(request);
  ctx.waitUntil(logEdgeEvent(env, request, classification, "agent_param_override_miss", null, passthrough.status));
  return passthrough;
}

/**
 * The request pipeline — routing only; each branch delegates.
 * @param {Request} request Incoming request.
 * @param {Object} env Worker bindings.
 * @param {Object} ctx Execution context.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function handleRequest(request, env, ctx) {
  if (await isHealthProbe(request, env)) return healthResponse(env);
  if (isPassthrough(request, env)) return fetch(request);

  const url = new URL(request.url);
  const userAgent = request.headers.get("user-agent") || "";

  // Entitlement gate. Everything below this line serves NORG content or alters
  // the origin response, so none of it may run until NORG has authenticated
  // this install. Unentitled — refused, or never authenticated and NORG is
  // unreachable — the request is passed through completely untouched: no
  // mirror, no strip, no render request, no event. The visitor gets the
  // customer's ordinary page and cannot tell the worker is installed.
  const feed = await getBotFeed(env, ctx);
  if (!feed.entitled) return fetch(request);

  // MCP paths do not exist on the origin, so they are served for any caller
  // and before any classification.
  if (isMcpPath(url.pathname)) {
    const mcp = await handleMcp(request, env, url);
    return mcp || fetch(request);
  }

  // Discovery artifacts (llms.txt, llms-full.txt, tree.json, graph.jsonld,
  // agents.md) are served to every caller before classification and the
  // search-bot floor — identical bytes for all, origin-first so the customer's
  // own file always wins.
  if (isDiscoveryPath(url.pathname)) {
    return serveOriginFirstArtifact(request, env, url);
  }

  // Reserved NORG asset paths (/.norg/*, e.g. the per-site theme stylesheet)
  // are served to EVERY caller before the search-bot floor and classification:
  // identical public bytes for all, so no cloaking surface. A pure asset read —
  // no render request, no crawler-visit event. A miss falls through to origin.
  if (isReservedNorgPath(url.pathname)) {
    return serveReservedNorgAsset(request, env, url);
  }

  // Site-level OpenAI feed artifacts (MIRROR 10) join the origin-first,
  // every-caller branch: served by exact path from R2 (identical bytes for all),
  // a miss falls through to origin, and no event or render is emitted.
  if (isOpenAiFeedPath(url.pathname)) {
    return serveOpenAiFeed(request, env, url);
  }

  // The agentic subtree (migration 500) is answered by URL for every caller —
  // humans, search engines and agents alike get identical bytes — so it runs
  // before the search-engine floor and all classification. Serving the same
  // content to everyone at a distinct URL is not cloaking, which is exactly
  // why this surface exists alongside the riskier user-agent path below.
  if (isAgenticPath(url.pathname, feed.agenticPathPrefix)) {
    ctx.waitUntil(maybeHeartbeat(env, "traffic"));
    return serveAgenticPath(request, env, ctx, url, feed.agenticPathPrefix);
  }

  // Per-page sibling artifacts (index.md/.json/.jsonld/.pdf, webmcp.js) are
  // advertised as absolute URLs in the page's own mcp.json, so an MCP client
  // that reads the manifest fetches them WITHOUT being a verified bot. Served
  // origin-first to every caller — identical bytes for all, and the customer's
  // own file at the same path still wins. Placed before the static-asset floor
  // because webmcp.js and index.pdf end in extensions that floor matches, and
  // after the agentic branch because /ai/* serves its own siblings.
  // The per-route skip covers a page's siblings too: an operator who excluded
  // /about from the mirror did not agree to serve /about/index.md, which
  // carries the same mirrored text. The feed lists PAGE paths, so the sibling's
  // owning page is what gets tested — the skip check below never would, since
  // "/about/index.md" is not the stored route path.
  if (isSiblingArtifactPath(url.pathname)) {
    if (isSkippedPath(feed, siblingPageOf(url.pathname))) return fetch(request);
    return serveOriginFirstArtifact(request, env, url, {
      alternateFormatHeaders: true,
    });
  }

  // Static subresources (css/js/images/fonts/media/downloads) are never a
  // mirrorable document, so they skip classification, the R2 lookup, the
  // render request and the visit log — origin answers them, as it already did.
  // Deliberately placed AFTER every NORG-owned surface above: the agentic
  // subtree and the reserved/discovery/MCP/feed paths must win, because some of
  // them legitimately end in an extension this set matches.
  if (isStaticAssetPath(url.pathname)) return fetch(request);

  // Per-route mirror skip: an operator marked this exact path
  // to pass through untouched — the customer's ORIGINAL page is served to every
  // caller (no mirror, no strip). Placed with the static-asset floor, before
  // the search-bot floor and serveAgent, so even a diverting AI bot on this
  // path gets the origin. The path is normalised to match the stored
  // EdgeRoute.path form (leading '/', no trailing slash except root).
  if (isSkippedPath(feed, url.pathname)) {
    return fetch(request);
  }

  // Search engines see exactly what humans see. Checked before classification
  // so it holds even when the pattern feed is stale or unavailable, and before
  // the ?agent=true override because that override is ungated: any ?agent=true
  // URL that gets linked or discovered would otherwise be crawlable, and
  // answering a crawler with the NORG render is the cloaking that rule 2 at the
  // top of this file forbids. The floor is the one thing nothing overrides.
  if (isTraditionalSearchBot(userAgent)) return fetch(request);

  // ?agent=true forces the R2 Agentic version regardless of UA/IP for every
  // caller that cleared the floor above. An OPEN, deliberately ungated bypass
  // (see hasAgentOverride) — it still overrides all classification.
  if (hasAgentOverride(url)) {
    ctx.waitUntil(maybeHeartbeat(env, "traffic"));
    return serveAgentOverride(request, env, ctx, url);
  }

  const classification = classifyAgent(userAgent, feed.patterns);
  if (!classification.is_ai_bot) return fetch(request);

  // NORG decides which crawlers may be served differently, not this file.
  if (!mayDivert(classification)) return fetch(request);

  // A spoofable UA is not enough to divert: the source IP must be verified,
  // or a spoofed UA from any IP would harvest the NORG mirror.
  if (!verifiedSource(request, feed.cidrRanges, classification)) return fetch(request);

  ctx.waitUntil(maybeHeartbeat(env, "traffic"));
  return serveAgent(request, env, ctx, url, classification, feed);
}

/**
 * Drop the body from a HEAD response, keeping status and headers.
 *
 * RFC 9110: HEAD is GET without the body, and the headers must match what GET
 * would send. Applied at the single entry point so every branch — the artifact
 * servers this worker answers and the origin passthrough alike — is covered by
 * one rule rather than each remembering.
 *
 * @param {Request} request Incoming request.
 * @param {Response} response Response the pipeline produced.
 * @returns {Response} Bodyless response for HEAD; the original otherwise.
 */
function stripBodyForHead(request, response) {
  if (request.method !== "HEAD" || !response) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default {
  /**
   * Entry point. The catch is the whole safety story: any bug in this worker
   * degrades to the unmodified origin response rather than an error page on
   * the customer's site.
   */
  async fetch(request, env, ctx) {
    try {
      const response = await handleRequest(request, env, ctx);
      return stripBodyForHead(request, response);
    } catch (e) {
      console.error("norg edge worker error", e);
      return stripBodyForHead(request, await fetch(request));
    }
  },

  /** Scheduled heartbeat, so a zero-traffic install still reports liveness. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maybeHeartbeat(env, "cron"));
  },
};

// Test-only exports (same convention as r2-proxy-worker.js).
export {
  classifyRequest as __test_classifyRequest,
  classifyScriptAutomation as __test_classifyScriptAutomation,
  pathToKeySuffix as __test_pathToKeySuffix,
  shouldKeepAttribute as __test_shouldKeepAttribute,
  handleRequest as __test_handleRequest,
  hasAgentOverride as __test_hasAgentOverride,
  getBotFeed as __test_getBotFeed,
  mayDivert as __test_mayDivert,
  verifiedSource as __test_verifiedSource,
  cidrContains as __test_cidrContains,
  cidrVerdict as __test_cidrVerdict,
  isPassthrough as __test_isPassthrough,
  isMcpPath as __test_isMcpPath,
  isDiscoveryPath as __test_isDiscoveryPath,
  serveOriginFirstArtifact as __test_serveOriginFirstArtifact,
  isSiblingArtifactPath as __test_isSiblingArtifactPath,
  isReservedNorgPath as __test_isReservedNorgPath,
  serveReservedNorgAsset as __test_serveReservedNorgAsset,
  isOpenAiFeedPath as __test_isOpenAiFeedPath,
  serveOpenAiFeed as __test_serveOpenAiFeed,
  isAgenticPath as __test_isAgenticPath,
  contentStem as __test_contentStem,
  UNENTITLED as __test_UNENTITLED,
  STRIP_REMOVE_SELECTORS as __test_STRIP_REMOVE_SELECTORS,
  STRIP_UNWRAP_SELECTORS as __test_STRIP_UNWRAP_SELECTORS,
  logEdgeEvent as __test_logEdgeEvent,
  countVisibleWords as __test_countVisibleWords,
  serveAgent as __test_serveAgent,
  responseCacheContext as __test_responseCacheContext,
  cacheableMirror as __test_cacheableMirror,
  readFeedBody as __test_readFeedBody,
};
