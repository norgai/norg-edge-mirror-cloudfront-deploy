/**
 * Constant tables shared with the Cloudflare edge-router worker.
 *
 * @description Provider-neutral constants for the CloudFront edge router.
 *
 * These are a deliberate COPY of the declarations in
 * `workers/edge-router-worker.js`, not an import. The Cloudflare worker's
 * bundle is pinned by SHA-256 in content-craft and its EDGE_SCRIPT_VERSION is
 * matched against a backend setting, so refactoring shared values out of that
 * file would change the shipped bundle and tell every installed Cloudflare site
 * an update is available until the backend catches up. Copying costs nothing at
 * runtime; the divergence risk is closed instead by
 * `aws/tests/constants-parity.test.mjs`, which compares the declaration text in
 * both files and fails on any drift.
 *
 * Keep every declaration below BYTE-IDENTICAL to its counterpart (modulo the
 * `export ` prefix) or that test will fail.
 */

// Baked binding defaults (EDGEPAR 04). Five bindings never vary across manual
// and deploy-button installs, so they default here and a hand install only
// needs SITE_ID + the NORG_SITE_KEY secret. An explicitly-bound value still
// overrides its default (see `binding`); EDGE_ENV deliberately has NO default —
// "unknown" is its fallback and the guards refuse to manage an unnamed env.
export const BINDING_DEFAULTS = {
  NORG_API_URL: "https://content-craft-api.norg.ai",
  NORG_CONTENT_BASE: "https://edge-content.norg.ai",
  STRIP_FALLBACK_ENABLED: "true",
  EDGE_DISABLED: "false",
  LAZY_RENDER_ENABLED: "true",
};

// Reserved NORG asset prefix on the customer domain. The whole prefix is
// NORG-served (currently just /.norg/theme.css — the mirror shell's stylesheet)
// before classification, for every caller. Kept in sync with the backend's
// app/services/edge_routing/paths.py::EDGE_THEME_PATH.
export const RESERVED_NORG_PREFIX = "/.norg/";

// Public cache headers for reserved assets. Unlike a tenant render, theme CSS
// is identical for every caller, so it is a public, cacheable asset. Matches
// theme_css_builder.MASTER_CSS_CACHE_CONTROL's intent (instant theme updates).
export const RESERVED_ASSET_CACHE_CONTROL =
  "public, max-age=60, s-maxage=30, stale-while-revalidate=300";

// Marks our own subrequests so a misconfigured route can't recurse into us.
export const LOOP_GUARD_HEADER = "x-norg-edge";

// Names the hostname the visitor actually asked for, for a provider that cannot
// forward the viewer's Host. CloudFront REQUIRES the Host it returns to name the
// origin (see alignHostToOrigin), so an origin that builds absolute URLs — a
// sitemap, robots.txt, a canonical tag — otherwise has no way to learn the
// public name of the site it is serving and advertises its own instead.
export const PUBLIC_HOST_HEADER = "x-norg-public-host";

// A bare hostname, optionally with a port. Anything else is a viewer trying to
// name the public host itself, and is dropped rather than forwarded.
export const HOSTNAME_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i;

// Health probes present the site key in this header; without it the path is
// left alone, so we never shadow a real customer URL.
export const HEALTH_CHECK_HEADER = "x-norg-edge-check";

// Budgets. The origin is always the fallback, so a slow NORG must cost the
// visitor a few hundred ms at worst, never a failed page.
export const MIRROR_FETCH_TIMEOUT_MS = 4000;
export const PATTERN_FETCH_TIMEOUT_MS = 5000;
export const CONTROL_CALL_TIMEOUT_MS = 3000;

// Deferred control calls get a TIGHTER timeout than a foreground one, because
// their bound is not the call, it is the flush budget below. A call allowed to
// run longer than the flush that is waiting for it would be abandoned in flight
// on every runtime that has no keep-alive, which is exactly the failure this
// pair of numbers exists to prevent. Keep it strictly under the flush budget.
export const DEFERRED_CALL_TIMEOUT_MS = 1200;

// How long a flush may wait for the work it just started. On Fastly and Bunny
// this is spent after the response has been sent, so a visitor never feels it;
// on Lambda@Edge, which has no keep-alive at all, it is spent inside the
// invocation that queued the work — an agent request, never a human one.
export const DEFERRED_FLUSH_BUDGET_MS = 1500;

// The budget for mopping up a PREVIOUS invocation's leftovers. Much smaller,
// because that flush lands on whichever request arrives next, which may well be
// a human, and no human should wait on a crawler's telemetry.
export const DEFERRED_SWEEP_BUDGET_MS = 200;
export const MCP_FORWARD_TIMEOUT_MS = 3000;

// Fallback response-cache TTL (seconds) if the feed omits one.
export const RESPONSE_CACHE_DEFAULT_TTL_SECONDS = 300;

export const PATTERN_DEFAULT_TTL_MS = 3600 * 1000;

// A refused (401/403) or unreachable-with-nothing-cached install is
// negative-cached for this short window, so a paused site costs its visitors
// no blocking NORG probe on every request. Kept short so re-entitlement lands
// within a minute: after it expires one request re-probes and a 200 feed
// restores full behaviour.
export const UNENTITLED_TTL_MS = 60 * 1000;

// Heartbeats piggyback on traffic so a site with a broken cron still reports
// in; this is the floor between traffic-driven beats per isolate.
export const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Suppresses repeat render requests for the same cold path within an isolate.
// Only an optimisation — NORG dedups authoritatively — so a small bounded map
// is enough, and it must never grow without limit.
export const RENDER_DEDUP_TTL_MS = 10 * 60 * 1000;
export const RENDER_DEDUP_MAX_ENTRIES = 500;

// Below this many visible words after stripping, the stripped page carries
// less than the origin (measured: a client-rendered origin whose content is a
// newsletter + footer strips to near-empty). Serve the untouched origin as
// "origin_thin" instead — a real page beats a page with its content removed.
export const STRIP_WORD_FLOOR = 120;

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
// Tokens that never appear in an ordinary browser user-agent, and do appear in
// crawler and scripted-client ones. "compatible;" is included on purpose: every
// major crawler uses the "Mozilla/5.0 (compatible; Name/1.0; +url)" form, and
// among real browsers only legacy IE does — which is worth one extra lookup.
// A divert-policy pattern NORG publishes must contain one of these, or the
// crawler takes the human fast path and is never diverted; content-craft
// asserts that at publish time.
export const BOT_MARKERS = [
  "bot", "crawl", "spider", "slurp", "scrape", "fetch", "agent",
  "compatible;", "http://", "https://", "headless", "preview",
  "python", "curl", "wget", "java/", "okhttp", "axios", "node-fetch",
  "go-http", "ruby", "perl", "libwww", "httpx", "aiohttp",
];

// A real browser presents Mozilla/5.0 AND one of these engine or brand tokens.
export const BROWSER_MARKERS = ["chrome/", "safari/", "firefox/", "edg/", "opr/", "trident/"];

export const TRADITIONAL_SEARCH_BOTS = [
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
export const UNENTITLED = Object.freeze({
  entitled: false,
  patterns: [],
  cidrRanges: {},
  agenticPathPrefix: "",
  skipPaths: [],
});

// Used only if NORG somehow omits the field; the column's own default.
export const DEFAULT_AGENTIC_PATH_PREFIX = "/ai";

// NORG answering with one of these is a decision, not an outage: the key is
// wrong, or the site is paused/uninstalled (NORG's API answers 401 and 403
// respectively). Cached entitlement is dropped immediately on either.
export const REFUSAL_STATUSES = new Set([401, 403]);

/** Elements with no informational value to an agent. */
export const STRIP_REMOVE_SELECTORS = [
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
export const STRIP_UNWRAP_SELECTORS = ["button"];

/** Attributes carrying styling/behaviour rather than meaning. */
export const STRIP_KEEP_ATTRIBUTES = new Set([
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

// Per-page sibling artifacts published beside index.html (MIRROR 03) and
// advertised by absolute URL in that page's mcp.json alternates. Matched by
// filename in ANY directory, since every mirrored route publishes its own set.
export const SIBLING_ARTIFACT_FILENAMES = new Set([
  "index.md",
  "index.json",
  "index.jsonld",
  "index.pdf",
  "index.openai.json",
  "webmcp.js",
]);

// Site-level OpenAI product-feed discovery artifacts (MIRROR 10). Published to
// R2 only when the site has product pages on a paid plan; they never exist on
// the customer origin, so they are served to every caller before classification
// (identical bytes for all — not a cloaking surface) and a miss falls through to
// origin. No render request and no crawler-visit event.
export const OPENAI_FEED_PATHS = new Set([
  "/.well-known/ai-plugin.json",
  "/openapi.json",
  "/openapi.yaml",
]);

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
export const STATIC_ASSET_SUFFIXES = new Set([
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
