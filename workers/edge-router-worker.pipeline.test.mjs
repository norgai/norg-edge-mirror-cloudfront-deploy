/**
 * Edge-router worker — request pipeline tests.
 *
 * Run with: node --test edge-router-worker.pipeline.test.mjs
 *
 * The contract being protected, in order of importance:
 *   1. the customer's site never breaks — every failure ends at the origin
 *   2. humans and search engines get the origin, byte-for-byte
 *   3. AI agents get the NORG render when it exists
 *   4. a definite 404 (and ONLY a definite 404) asks NORG to render
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_pathToKeySuffix as pathToKeySuffix,
  __test_isPassthrough as isPassthrough,
  __test_isMcpPath as isMcpPath,
  __test_contentStem as contentStem,
  __test_hasAgentOverride as hasAgentOverride,
  __test_isAgenticPath as isAgenticPath,
} from "./edge-router-worker.js";

/**
 * Each test gets its own module instance, standing in for a cold isolate.
 *
 * The bot-pattern cache is module-level state — correct for a Worker, where
 * it lives as long as the isolate — but it would otherwise leak one test's
 * pattern set into the next. Tests that need continuity within an isolate
 * (the render dedup window) simply call handleRequest twice on the same one.
 */
let moduleCounter = 0;
let handleRequest;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?isolate=${moduleCounter}`);
  return mod.__test_handleRequest;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
  STRIP_FALLBACK_ENABLED: "true",
};

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let calls;
let waitUntilTasks;

const ctx = {
  waitUntil: (p) => {
    waitUntilTasks.push(p);
  },
};

/** Minimal Cache API stub — the colo cache layer for bot patterns. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const body = this.store.get(req.url);
    if (body === undefined) return undefined;
    return { json: async () => JSON.parse(body) };
  }
  async put(req, res) {
    this.store.set(req.url, await res.text());
  }
  async delete(req) {
    return this.store.delete(req.url);
  }
}

/**
 * HTMLRewriter stub. lol-html cannot run under node --test, so this records
 * which selectors were registered and passes the body through untouched —
 * enough to prove wiring and headers. The actual transformation is verified
 * by `node verify-strip.mjs` against a real `wrangler dev` (see PR notes).
 */
class FakeHTMLRewriter {
  constructor() {
    FakeHTMLRewriter.lastSelectors = [];
  }
  on(selector) {
    FakeHTMLRewriter.lastSelectors.push(selector);
    return this;
  }
  transform(response) {
    return response;
  }
}

async function drain() {
  await Promise.allSettled(waitUntilTasks);
}

/** Records every fetch and answers from a url->handler routing table. */
function installFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    // `input` is recorded so a fallback test can read the body of a
    // Request-object fetch (fetch(request)), whose body is NOT on `init`.
    calls.push({ url, method: init.method || (input.method ?? "GET"), init, input });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    return new Response("origin body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

// A real bot arrives from a Cloudflare-verified source; the worker now
// requires this before diverting. Tests that spoof a UA pass `cf: {}` to prove
// an unverified source is served the origin (the security fix).
const VERIFIED_CF = { verifiedBotCategory: "AI Crawler" };

// >120 visible words so the strip fallback stays "stripped" rather than
// tripping the origin_thin word-count floor.
const RICH_HTML =
  `<html><body><main><p>${Array(150).fill("content").join(" ")}</p></main></body></html>`;

function req(path = "/products/widget/", userAgent = GPTBOT, extra = {}) {
  const { cf, ...init } = extra;
  // `...init` must come FIRST: spreading it after `headers` lets an extra.headers
  // replace the merged object wholesale and silently drop the user-agent, which
  // makes any test that passes both headers and a UA quietly test a UA-less
  // request instead.
  const r = new Request(`https://customer.com${path}`, {
    ...init,
    headers: { "user-agent": userAgent, ...(init.headers || {}) },
  });
  r.cf = cf !== undefined ? cf : VERIFIED_CF;
  return r;
}

/** Bot patterns come from NORG; the fetch stub answers that call by default. */
// A 200 here is also the entitlement signal: the endpoint is authenticated
// (site_auth.require_edge_site), so answering at all means NORG accepted this
// install's SITE_ID + NORG_SITE_KEY. serving_policy must be "divert" or the
// worker passes the bot through — that is the point of the policy field.
function patternsRoute(
  patterns = [
    { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
  ],
  cidrRanges = {},
) {
  return [
    "/api/v1/edge/bot-patterns",
    async () =>
      new Response(
        JSON.stringify({ patterns, cache_ttl: 3600, cidr_ranges: cidrRanges }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
}

/** The feed carrying a non-default agentic prefix. */
function patternsRouteWithPrefix(prefix) {
  return [
    "/api/v1/edge/bot-patterns",
    async () =>
      new Response(
        JSON.stringify({
          patterns: [
            { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
          agentic_path_prefix: prefix,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
}

/** The feed carrying a per-route skip_paths list. */
function patternsRouteWithSkip(skipPaths) {
  return [
    "/api/v1/edge/bot-patterns",
    async () =>
      new Response(
        JSON.stringify({
          patterns: [
            { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
          skip_paths: skipPaths,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
}

/** The feed endpoint refusing this install: bad key (401) or paused site (403). */
function refusedPatternsRoute(status = 401) {
  return [
    "/api/v1/edge/bot-patterns",
    async () => new Response(JSON.stringify({ detail: "refused" }), { status }),
  ];
}

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  globalThis.HTMLRewriter = FakeHTMLRewriter;
  handleRequest = await loadColdIsolate();
});

// --- Pure helpers ---------------------------------------------------------

test("pathToKeySuffix matches the backend key rule", () => {
  assert.equal(pathToKeySuffix("/"), "/index.html");
  assert.equal(pathToKeySuffix("/products/widget/"), "/products/widget/index.html");
  assert.equal(pathToKeySuffix("/products/widget"), "/products/widget/index.html");
  assert.equal(pathToKeySuffix("/brochure.pdf"), "/brochure.pdf");
  // Trailing slash wins over the dot — same rule as r2_key_for().
  assert.equal(pathToKeySuffix("/products/v2.0/"), "/products/v2.0/index.html");
});

test("contentStem is base + site id, tenant-unique for cache safety", () => {
  // The receptionist's URL contract is /{site_id}/{path}: the site id in the
  // URL makes every cache key tenant-unique (receptionist colo cache AND the
  // cf-cache on this worker's subrequest). Trailing slashes on the base are
  // absorbed so a config with one cannot 404 every page.
  assert.equal(
    contentStem({ NORG_CONTENT_BASE: "https://edge.test", SITE_ID: "site-123" }),
    "https://edge.test/site-123",
  );
  assert.equal(
    contentStem({ NORG_CONTENT_BASE: "https://edge.test/", SITE_ID: "site-123" }),
    "https://edge.test/site-123",
  );
});

test("the mirror URL carries the site id and the site auth headers", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>ok</html>", { status: 200 })],
  ]);

  await handleRequest(req("/products/widget/"), env, ctx);
  await drain();

  const mirror = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(mirror.url, "https://r2.norg.test/site-123/products/widget/index.html");
  // The receptionist authenticates every read — the bucket is never public.
  assert.equal(mirror.init.headers["X-Norg-Site-Id"], "site-123");
  assert.equal(mirror.init.headers["X-Norg-Site-Key"], env.NORG_SITE_KEY);
});

test("isMcpPath recognises the MCP surface only", () => {
  assert.equal(isMcpPath("/.well-known/mcp.json"), true);
  assert.equal(isMcpPath("/products/x/mcp"), true);
  assert.equal(isMcpPath("/products/x/sse"), true);
  assert.equal(isMcpPath("/products/mcpx"), false);
  assert.equal(isMcpPath("/about/"), false);
});

test("isPassthrough short-circuits the cases that must never be touched", () => {
  assert.equal(isPassthrough(req("/", GPTBOT, { method: "POST" }), env), true);
  assert.equal(isPassthrough(req("/"), { ...env, EDGE_DISABLED: "true" }), true);
  assert.equal(
    isPassthrough(req("/", GPTBOT, { headers: { "x-norg-edge": "1" } }), env),
    true,
  );
  assert.equal(
    isPassthrough(req("/", GPTBOT, { headers: { upgrade: "websocket" } }), env),
    true,
  );
  assert.equal(isPassthrough(req("/"), env), false);
});

// --- Humans and search engines -------------------------------------------

test("a human gets the origin and NORG is never consulted for content", async () => {
  installFetch([patternsRoute()]);
  const response = await handleRequest(req("/about/", BROWSER), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);
  assert.equal(calls.filter((c) => c.url.includes("/edge/events")).length, 0);
});

test("a search engine is never served different content than a human", async () => {
  installFetch([
    patternsRoute([{ pattern: "googlebot", company: "google", purpose: "search" }]),
  ]);
  const response = await handleRequest(req("/about/", GOOGLEBOT), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);
});

test("search engines pass through even when the pattern feed is down", async () => {
  // The cloaking guard must not depend on NORG being reachable.
  installFetch([["/api/v1/edge/", async () => new Response("down", { status: 500 })]]);
  const response = await handleRequest(req("/about/", GOOGLEBOT), env, ctx);
  await drain();
  assert.equal(await response.text(), "origin body");
});

test("AI answer engines ARE served — they are not traditional search", async () => {
  // PerplexityBot and OAI-SearchBot carry purpose="search" in ai_bot_patterns
  // but are the core target market; excluding them would gut the product.
  for (const ua of [
    "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
    "Mozilla/5.0 (compatible; OAI-SearchBot/1.0)",
  ]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    handleRequest = await loadColdIsolate();
    installFetch([
      patternsRoute([
        {
          pattern: "perplexitybot",
          company: "perplexity",
          purpose: "search",
          serving_policy: "divert",
        },
        {
          pattern: "oai-searchbot",
          company: "openai",
          purpose: "search",
          serving_policy: "divert",
        },
      ]),
      [
        "r2.norg.test",
        async () =>
          new Response("<html>render</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ],
    ]);

    const response = await handleRequest(req("/products/widget/", ua), env, ctx);
    await drain();
    assert.equal(response.headers.get("X-Norg-Edge"), "mirror", `${ua} should be served`);
  }
});

test("google-extended is not Googlebot, but its 'ignore' policy still passes it through", async () => {
  // It does not contain "googlebot", so it never trips the traditional-search
  // floor — but migration 495 classifies google-extended as an AI-training
  // opt-out signal rather than a crawler and sets serving_policy='ignore'.
  // The worker obeys the published policy, so it is NOT diverted. Before the
  // policy field was honoured this same user-agent was served the mirror.
  installFetch([
    patternsRoute([
      {
        pattern: "google-extended",
        company: "google",
        purpose: "training",
        serving_policy: "ignore",
      },
    ]),
    [
      "r2.norg.test",
      async () =>
        new Response("<html>render</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
  ]);

  const response = await handleRequest(
    req("/products/widget/", "Mozilla/5.0 (compatible; Google-Extended/1.0)"),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "ignore must not divert");
  assert.ok(
    !calls.find((c) => c.url.includes("r2.norg.test")),
    "an 'ignore' policy must not reach the NORG mirror",
  );
});

// --- Agents: the mirror hit ----------------------------------------------

test("an AI agent gets the NORG render at the customer URL", async () => {
  installFetch([
    patternsRoute(),
    [
      "r2.norg.test",
      async () =>
        new Response("<html>norg render</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
  ]);

  const response = await handleRequest(req("/products/widget/"), env, ctx);
  await drain();

  assert.equal(await response.text(), "<html>norg render</html>");
  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  // Vary: User-Agent is no longer used — a cache keying on less than the full
  // header could hand this render to a human. no-store forbids it instead.
  assert.equal(response.headers.get("Vary"), null);
  // Fetched the right key, and never touched the origin.
  const mirror = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(mirror.url, "https://r2.norg.test/site-123/products/widget/index.html");
  assert.equal(calls.filter((c) => c.url === "https://customer.com/products/widget/").length, 0);
});

test("a skipped path passes through to origin UNCHANGED even for a diverting AI bot", async () => {
  // AC #3: an AI-bot UA that would otherwise be served the
  // mirror gets the customer's ORIGINAL page (fetch(request)), not serveAgent
  // and not the stripped fallback, when its path is in skip_paths.
  installFetch([
    patternsRouteWithSkip(["/products/widget"]),
    [
      "r2.norg.test",
      async () =>
        new Response("<html>norg render</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
  ]);

  const response = await handleRequest(req("/products/widget/"), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  // The mirror was never consulted, and the origin WAS fetched.
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);
  assert.equal(
    calls.filter((c) => c.url === "https://customer.com/products/widget/").length,
    1,
  );
});

test("a NON-skipped path still diverts to the mirror (no regression)", async () => {
  // AC #4: only the listed path passes through; every other
  // route is intercepted exactly as before.
  installFetch([
    patternsRouteWithSkip(["/other-page"]),
    ["r2.norg.test", async () => new Response("<html>norg render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/"), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

test("a trailing-slash variant of a skip path still matches", async () => {
  // Stored EdgeRoute.path has no trailing slash; url.pathname does. The worker
  // normalises before the membership test so both forms skip.
  installFetch([patternsRouteWithSkip(["/products/widget"])]);

  const response = await handleRequest(req("/products/widget/"), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
});

test("a repeated-slash variant of a skip path still matches", async () => {
  // Backend normalise_path collapses internal '//' when storing routes; on
  // zones that preserve duplicate slashes url.pathname does not. The worker
  // collapses too, so '/products//widget' still matches the stored
  // '/products/widget' and passes through to origin.
  installFetch([patternsRouteWithSkip(["/products/widget"])]);

  const response = await handleRequest(req("/products//widget"), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
});

test("an intercepted response names the NORG environment it came from", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  const response = await handleRequest(req(), { ...env, EDGE_ENV: "test" }, ctx);
  await drain();

  // A test-bound worker serves TEST content. Anyone looking at a customer zone
  // — the probe, automation, a human debugging — must be able to tell which
  // environment answered without access to the install's bindings.
  assert.equal(response.headers.get("X-Norg-Edge-Env"), "test");
});

test("an unlabelled install reports 'unknown', never 'production'", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  // env deliberately has no EDGE_ENV — an install we cannot name is exactly
  // the one nobody should assume is safe.
  const response = await handleRequest(req(), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge-Env"), "unknown");
});

test("the stripped fallback is labelled too", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("gone", { status: 404 })],
    [
      "customer.com",
      async () =>
        new Response(RICH_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ]);

  const response = await handleRequest(req(), { ...env, EDGE_ENV: "test" }, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "stripped");
  assert.equal(response.headers.get("X-Norg-Edge-Env"), "test");
});

test("the mirror is never storable by any cache", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  const response = await handleRequest(req(), env, ctx);
  await drain();

  // Vary: User-Agent is advisory — a cache keying on less than the full header
  // could still hand this render to a human. no-store is what actually forbids
  // it, so assert the directive rather than trusting Vary to do the work.
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("the mirror is not marked noindex — it is the customer's page for agents", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);
  const response = await handleRequest(req(), env, ctx);
  await drain();
  assert.equal(response.headers.get("X-Robots-Tag"), null);
});

// --- Agents: the miss ----------------------------------------------------

test("a definite 404 strips the origin and asks NORG to render", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
    [
      "customer.com",
      async () =>
        new Response(
          `<html><head><style>x{}</style></head><body><nav>menu</nav><h1 class='a'>Hi</h1><main><p>${Array(150).fill("content").join(" ")}</p></main><script>1</script></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    ],
  ]);

  const response = await handleRequest(req("/new-page/"), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "stripped");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");

  const renderCall = calls.find((c) => c.url.includes("/edge/render-requests"));
  assert.ok(renderCall, "expected a render request");
  assert.equal(JSON.parse(renderCall.init.body).path, "/new-page/");
});

test("an R2 error or timeout is NOT reported as a missing page", async () => {
  // The critical distinction: reporting non-404 failures as misses would let
  // an R2 outage trigger a re-render of the customer's entire site.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("boom", { status: 503 })],
  ]);

  await handleRequest(req("/some-page/"), env, ctx);
  await drain();

  assert.equal(calls.filter((c) => c.url.includes("/edge/render-requests")).length, 0);
});

test("a repeat miss within the dedup window does not re-ask", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  await handleRequest(req("/dedup-me/"), env, ctx);
  await drain();
  await handleRequest(req("/dedup-me/"), env, ctx);
  await drain();

  assert.equal(calls.filter((c) => c.url.includes("/edge/render-requests")).length, 1);
});

test("a non-HTML origin response is passed through unstripped", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
    [
      "customer.com",
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ],
  ]);

  const response = await handleRequest(req("/api/data"), env, ctx);
  await drain();
  assert.equal(response.headers.get("X-Norg-Edge"), null);
});

test("strip fallback can be turned off without losing the render request", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(
    req("/off/"),
    { ...env, STRIP_FALLBACK_ENABLED: "false" },
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(calls.filter((c) => c.url.includes("/edge/render-requests")).length, 1);
});

// --- Resilience ----------------------------------------------------------

test("the site still works when the NORG API is completely down", async () => {
  installFetch([
    ["/api/v1/edge/", async () => new Response("down", { status: 500 })],
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(req("/anything/"), env, ctx);
  await drain();

  // Fallback patterns still classified GPTBot, and the visitor got a page.
  assert.equal(response.status, 200);
});

test("a thrown error anywhere still serves the origin", async () => {
  installFetch([patternsRoute()]);
  const brokenCtx = {
    waitUntil: () => {
      throw new Error("ctx exploded");
    },
  };
  const worker = (await import("./edge-router-worker.js")).default;
  const response = await worker.fetch(req("/boom/"), env, brokenCtx);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin body");
});

// --- Health probe --------------------------------------------------------

test("a health probe answers only with the right key", async () => {
  installFetch([patternsRoute()]);
  const probe = req("/", GPTBOT, {
    headers: { "x-norg-edge-check": "nek_live_secret" },
  });
  const response = await handleRequest(probe, env, ctx);
  const body = await response.json();
  assert.equal(body.site_id, "site-123");
  assert.ok(body.version);
});

test("a wrong probe key does not shadow the customer's path", async () => {
  installFetch([patternsRoute()]);
  const probe = req("/", BROWSER, { headers: { "x-norg-edge-check": "wrong" } });
  const response = await handleRequest(probe, env, ctx);
  assert.equal(await response.text(), "origin body");
});

// --- MCP surface ---------------------------------------------------------

test("a page's MCP manifest is served from the render namespace", async () => {
  installFetch([
    patternsRoute(),
    [
      "r2.norg.test",
      async (url) => {
        assert.ok(url.endsWith("/site-123/products/widget/mcp.json"), url);
        return new Response('{"tools":[]}', { status: 200 });
      },
    ],
  ]);

  const response = await handleRequest(req("/products/widget/mcp", BROWSER), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mcp");
  assert.equal(response.headers.get("Content-Type"), "application/json");
});

test("an MCP JSON-RPC POST reaches NORG instead of the origin", async () => {
  // POST is the MCP transport; the generic non-GET passthrough must not
  // swallow it, or the MCP surface is read-only in practice.
  installFetch([
    patternsRoute(),
    [
      "/public-mcp",
      async () => new Response('{"result":{}}', { status: 200 }),
    ],
  ]);

  const request = new Request("https://customer.com/products/widget/mcp", {
    method: "POST",
    headers: { "user-agent": BROWSER, "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
  });
  const response = await handleRequest(request, env, ctx);
  await drain();

  assert.equal(response.status, 200);
  const forwarded = calls.find((c) => c.url.includes("/public-mcp"));
  assert.ok(forwarded, "MCP POST should be forwarded to NORG");
  // The trailing slash is the whole fix: the mount's streamable-HTTP route is
  // at "/", so "/public-mcp" answers 307 and this POST's one-shot body cannot
  // be replayed onto the redirect — the forward fails and every advertised MCP
  // client falls through to the origin's 404.
  assert.ok(
    forwarded.url.endsWith("/public-mcp/"),
    `MCP POST must target /public-mcp/ (got ${forwarded.url})`,
  );
});

test("a non-MCP POST is left entirely to the customer's application", async () => {
  installFetch([patternsRoute()]);
  const request = new Request("https://customer.com/checkout", {
    method: "POST",
    headers: { "user-agent": BROWSER },
    body: "order=1",
  });
  const response = await handleRequest(request, env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(calls.filter((c) => c.url.includes("/public-mcp")).length, 0);
});

test("an unpublished MCP path falls through to the customer's own route", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(req("/custom/mcp", BROWSER), env, ctx);
  await drain();
  assert.equal(await response.text(), "origin body");
});

// --- MCP POST origin fallback (MIRROR 11) --------------------------------
// The POST branch must mirror the GET miss: when NORG cannot serve the
// request the customer's own endpoint at that path keeps working (rule 1).
const MCP_JSONRPC = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x"},"id":7}';
const MCP_ORIGIN_URL = "https://customer.com/products/widget/mcp";

/** A JSON-RPC POST to the MCP surface, body intact for fallback assertions. */
function mcpPost() {
  return new Request(MCP_ORIGIN_URL, {
    method: "POST",
    headers: { "user-agent": BROWSER, "content-type": "application/json" },
    body: MCP_JSONRPC,
  });
}

test("MCP POST: a NORG 200 is returned and the origin is not consulted", async () => {
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => new Response('{"result":{"ok":true}}', { status: 200 })],
  ]);
  const response = await handleRequest(mcpPost(), env, ctx);
  await drain();

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"result":{"ok":true}}');
  assert.ok(calls.find((c) => c.url.includes("/public-mcp")), "NORG must be attempted");
  assert.ok(
    !calls.find((c) => c.url === MCP_ORIGIN_URL),
    "origin must not be consulted when NORG serves a 200",
  );
});

test("MCP POST: a JSON-RPC application error carried as HTTP 200 is returned, not fallen back on", async () => {
  // AC6 / 4xx boundary: a JSON-RPC application error arrives from NORG as an
  // HTTP 200 body — that IS the caller's answer, so it is returned as-is and
  // the origin is NOT consulted. Only transport-level non-2xx falls back.
  const RPC_ERROR = '{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":7}';
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => new Response(RPC_ERROR, { status: 200 })],
    [MCP_ORIGIN_URL, async () => new Response("origin", { status: 200 })],
  ]);
  const response = await handleRequest(mcpPost(), env, ctx);
  await drain();

  assert.equal(response.status, 200);
  assert.equal(await response.text(), RPC_ERROR, "the JSON-RPC error body is returned to the caller");
  assert.ok(
    !calls.find((c) => c.url === MCP_ORIGIN_URL),
    "a 200 JSON-RPC error must NOT trigger the origin fallback",
  );
});

test("MCP POST: a NORG 404 falls back to the origin with the identical POST", async () => {
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => new Response("not found", { status: 404 })],
    [MCP_ORIGIN_URL, async () => new Response('{"origin":"served"}', { status: 200 })],
  ]);
  const response = await handleRequest(mcpPost(), env, ctx);
  await drain();

  const origin = calls.find((c) => c.url === MCP_ORIGIN_URL);
  assert.ok(origin, "origin must receive the fallback POST");
  assert.equal(origin.method, "POST");
  assert.equal(await origin.input.text(), MCP_JSONRPC);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"origin":"served"}');
});

test("MCP POST: a NORG fetch that throws falls back to the origin, body intact", async () => {
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => {
      throw new Error("connection reset");
    }],
    [MCP_ORIGIN_URL, async () => new Response("origin ok", { status: 200 })],
  ]);
  const response = await handleRequest(mcpPost(), env, ctx);
  await drain();

  const origin = calls.find((c) => c.url === MCP_ORIGIN_URL);
  assert.ok(origin, "origin must receive the fallback POST after a NORG throw");
  assert.equal(origin.method, "POST");
  assert.equal(await origin.input.text(), MCP_JSONRPC);
  assert.equal(await response.text(), "origin ok");
});

test("MCP POST: the NORG forward is bounded by an abort-signal timeout", async () => {
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => new Response("{}", { status: 200 })],
  ]);
  await handleRequest(mcpPost(), env, ctx);
  await drain();

  const forward = calls.find((c) => c.url.includes("/public-mcp"));
  assert.ok(forward, "NORG must be attempted");
  assert.ok(
    forward.init.signal instanceof AbortSignal,
    "the forward must carry an AbortSignal so a hung NORG cannot exceed the bounded timeout",
  );
});

test("MCP POST: a customer origin that itself 404s the POST still gets it, unsynthesised", async () => {
  installFetch([
    patternsRoute(),
    ["/public-mcp", async () => new Response("nope", { status: 404 })],
    [MCP_ORIGIN_URL, async () => new Response("customer not found", { status: 404 })],
  ]);
  const response = await handleRequest(mcpPost(), env, ctx);
  await drain();

  const origin = calls.find((c) => c.url === MCP_ORIGIN_URL);
  assert.ok(origin, "origin must receive the POST even though it will 404 it");
  assert.equal(origin.method, "POST");
  assert.equal(response.status, 404, "the origin's own 404 is returned, not a synthesised NORG error");
  assert.equal(await response.text(), "customer not found");
});

test("MCP POST: the fallback body is not consumed by the NORG attempt (clone regression)", async () => {
  let norgSawBody = "";
  installFetch([
    patternsRoute(),
    ["/public-mcp", async (_url, init) => {
      norgSawBody = await new Response(init.body).text();
      return new Response("miss", { status: 502 });
    }],
    [MCP_ORIGIN_URL, async () => new Response("origin", { status: 200 })],
  ]);
  await handleRequest(mcpPost(), env, ctx);
  await drain();

  // NORG consumed the CLONE's body — the original must survive for the origin.
  assert.equal(norgSawBody, MCP_JSONRPC, "NORG must have received the forwarded body");
  const origin = calls.find((c) => c.url === MCP_ORIGIN_URL);
  const originBody = await origin.input.text();
  assert.notEqual(originBody, "", "the fallback body must not be empty");
  assert.equal(originBody, MCP_JSONRPC, "the fallback body must be byte-identical to the original");
});

// --- FIX 1: source verification (AC1) ------------------------------------

test("a spoofed UA from an unverified source is served the origin, never the mirror", async () => {
  // `curl -A "GPTBot/1.4"` from any IP: the UA matches, but the source is not
  // a Cloudflare-verified bot, so it must get the ordinary origin — every time.
  installFetch([
    patternsRoute(),
    [
      "r2.norg.test",
      async () =>
        new Response("<html>norg render</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
  ]);

  const response = await handleRequest(req("/products/widget/", GPTBOT, { cf: {} }), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(
    calls.filter((c) => c.url.includes("r2.norg.test")).length,
    0,
    "an unverified source must never reach the NORG mirror",
  );
});

// --- FIX 2: hard-coded search-engine floor (AC2) -------------------------

test("the hard-coded search floor wins over a contradicting serving_policy row", async () => {
  // Even a serving_policy='divert' admin row for a search engine must not
  // divert it — the floor is checked before classification and cannot be
  // overridden from the database.
  for (const bot of ["googlebot", "bingbot", "applebot", "duckduckbot", "baiduspider", "yandex"]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    handleRequest = await loadColdIsolate();
    installFetch([
      patternsRoute([{ pattern: bot, company: "x", purpose: "search", serving_policy: "divert" }]),
      [
        "r2.norg.test",
        async () =>
          new Response("<html>render</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ],
    ]);

    const response = await handleRequest(
      req("/products/widget/", `Mozilla/5.0 (compatible; ${bot}/1.0)`),
      env,
      ctx,
    );
    await drain();

    assert.equal(await response.text(), "origin body", `${bot} must be served the origin`);
    assert.equal(response.headers.get("X-Norg-Edge"), null, `${bot} must not be diverted`);
    assert.equal(
      calls.filter((c) => c.url.includes("r2.norg.test")).length,
      0,
      `${bot} must not reach the mirror`,
    );
  }
});

// --- FIX 3: cache safety on diverted responses (AC3) --------------------

test("a diverted mirror is excluded from CDN caching and sets no Vary", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  const response = await handleRequest(req(), env, ctx);
  await drain();

  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("CDN-Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Vary"), null);
});

test("the mirror fetch never puts an authenticated response in a URL-keyed cache", async () => {
  // This fetch used to target a PUBLIC bucket URL, where cacheEverything was
  // free performance. It now targets the authenticated edge-content
  // receptionist, and Cloudflare keys that cache on the URL alone — the site
  // key is not part of the key. Caching there would let any caller replay
  // another tenant's render by requesting the same URL with no credentials,
  // and would keep serving it for the TTL after a key was revoked.
  // Repeat reads are absorbed by the receptionist's own post-auth colo cache.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  await handleRequest(req(), env, ctx);
  await drain();

  const r2 = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(r2.init.cf, undefined, "no cf cache directives on an authenticated fetch");
});

// --- FIX 4: strip word-count floor (AC4) --------------------------------

test("a strip below the word floor serves the untouched origin as origin_thin", async () => {
  // A client-rendered origin whose visible content is a newsletter + footer
  // strips to near-empty. Serving that is worse than serving the real page.
  const THIN =
    "<html><body><nav>Sign up to our newsletter</nav><footer>Home About Contact</footer></body></html>";
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("gone", { status: 404 })],
    [
      "customer.com",
      async () =>
        new Response(THIN, { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ]);

  const response = await handleRequest(req("/thin/"), env, ctx);
  await drain();

  // The untouched origin, not the near-empty stripped body.
  assert.equal(await response.text(), THIN);
  assert.notEqual(response.headers.get("X-Norg-Edge"), "stripped");
  const event = calls.find((c) => c.url.includes("/edge/events"));
  assert.equal(JSON.parse(event.init.body).served, "origin_thin");
  // the real origin status travels with the event.
  assert.equal(JSON.parse(event.init.body).response_status, response.status);
});

test("a strip above the word floor is still served as stripped", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("gone", { status: 404 })],
    [
      "customer.com",
      async () =>
        new Response(RICH_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ]);

  const response = await handleRequest(req("/rich/"), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "stripped");
  const event = calls.find((c) => c.url.includes("/edge/events"));
  assert.equal(JSON.parse(event.init.body).served, "stripped");
  assert.equal(JSON.parse(event.init.body).response_status, response.status);
});

// AC4 boundary: spec threshold is 120 words; the guard is strictly `< 120`, so
// EXACTLY 120 words must still strip and 119 must go thin. Pinning both sides of
// the boundary kills a `<`→`<=` (or off-by-one threshold) mutation that the
// far-apart 8-word / 150-word cases above would not catch.
// Coverage: FIX4 word-count floor = STRIP_WORD_FLOOR (120), spec AC4.
test("the word-count floor is exactly 120: 119 words -> origin_thin, 120 -> stripped", async () => {
  for (const { words, served } of [
    { words: 119, served: "origin_thin" },
    { words: 120, served: "stripped" },
  ]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    globalThis.HTMLRewriter = FakeHTMLRewriter;
    handleRequest = await loadColdIsolate();
    // Tags collapse to whitespace, so countVisibleWords sees exactly `words`.
    const body = `<html><body><main>${Array(words).fill("w").join(" ")}</main></body></html>`;
    installFetch([
      patternsRoute(),
      ["r2.norg.test", async () => new Response("gone", { status: 404 })],
      [
        "customer.com",
        async () =>
          new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
      ],
    ]);

    await handleRequest(req("/boundary/"), env, ctx);
    await drain();

    const event = calls.find((c) => c.url.includes("/edge/events"));
    assert.equal(
      JSON.parse(event.init.body).served,
      served,
      `${words} visible words must be served as ${served}`,
    );
  }
});

// --- STORY 17: ?agent=true force-serve override -------------------------

test("hasAgentOverride matches only the literal ?agent=true", () => {
  const has = (q) => hasAgentOverride(new URL(`https://c.com/p${q}`));
  assert.equal(has("?agent=true"), true);
  assert.equal(has("?utm=x&agent=true"), true);
  // Anything but the lowercase literal "true" is NOT the override.
  assert.equal(has("?agent=false"), false);
  assert.equal(has("?agent=1"), false);
  assert.equal(has("?agent=True"), false);
  assert.equal(has("?agent"), false);
  assert.equal(has(""), false);
});

test("AC1/AC4: ?agent=true serves the R2 mirror to a plain browser UA from an UNVERIFIED source", async () => {
  // No matching UA, no verified IP — the exact request stories 11/12 would send
  // to the origin. ?agent=true must still return the R2 Agentic version, proving
  // the bypass works independently of that verification.
  installFetch([
    patternsRoute(),
    [
      "r2.norg.test",
      async () =>
        new Response("<html>norg render</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
  ]);

  const response = await handleRequest(
    req("/products/widget/?agent=true", BROWSER, { cf: {} }),
    env,
    ctx,
  );
  await drain();

  assert.equal(await response.text(), "<html>norg render</html>");
  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  assert.ok(
    calls.find((c) => c.url.includes("r2.norg.test")),
    "the override must reach the NORG mirror",
  );
});

// Story 17 AC1 originally read "?agent=true overrides the traditional-search-
// engine floor (Googlebot still gets the mirror)". That was narrowed: the
// override is ungated, so a ?agent=true URL that gets linked or crawled would
// have served Googlebot the render — cloaking, against rule 2 at the top of the
// worker. The floor now beats the override. Demo/QA is unaffected: it arrives
// with a browser user-agent (covered by the AC1/AC4 test above).
test("AC1 (narrowed): the search-engine floor beats ?agent=true — Googlebot gets the origin", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/?agent=true", GOOGLEBOT), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "Googlebot must not be diverted");
  assert.ok(
    !calls.find((c) => c.url.includes("r2.norg.test")),
    "Googlebot+?agent=true must never reach the NORG mirror (cloaking)",
  );
});

test("AC1 (narrowed): every traditional crawler is held to the floor under ?agent=true", async () => {
  for (const ua of ["bingbot/2.0", "DuckDuckBot/1.1", "Baiduspider/2.0", "Applebot/0.1"]) {
    installFetch([
      patternsRoute(),
      ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
    ]);
    const response = await handleRequest(req("/p/?agent=true", ua), env, ctx);
    await drain();
    assert.equal(response.headers.get("X-Norg-Edge"), null, `${ua} must not be diverted`);
  }
});

test("AC2: the ?agent=true mirror is non-cacheable (private, no-store + CDN bypass), no Vary", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  const response = await handleRequest(req("/p/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("CDN-Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Vary"), null);
});

test("AC3: a ?agent=true mirror hit is tagged served=agent_param_override", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  await handleRequest(req("/p/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  const event = calls.find((c) => c.url.includes("/edge/events"));
  assert.equal(JSON.parse(event.init.body).served, "agent_param_override");
});

test("AC8: the R2 key is derived from the path only — the query string is ignored", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("x", { status: 200 })],
  ]);

  await handleRequest(req("/products/widget/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  const mirror = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(mirror.url, "https://r2.norg.test/site-123/products/widget/index.html");
});

test("a pass-through miss records the origin's REAL status (404), not a path-derived guess", async () => {
  // Before this, the edge worker never sent response_status, so analytics could
  // not tell a served page from a 404 except by looking at the path.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
    ["customer.com", async () => new Response("missing", { status: 404 })],
  ]);

  const response = await handleRequest(req("/does-not-exist/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.status, 404);
  const event = calls.find((c) => c.url.includes("/edge/events"));
  const body = JSON.parse(event.init.body);
  assert.equal(body.served, "agent_param_override_miss");
  assert.equal(body.response_status, 404);
});

test("a ?agent=true miss serves the untouched origin, tags it, and enqueues NO render", async () => {
  // No R2 render exists: there is nothing Agentic to show, so the origin is
  // served (tagged distinctly), and param-driven traffic must not trigger a render.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(req("/no-render/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  const event = calls.find((c) => c.url.includes("/edge/events"));
  assert.equal(JSON.parse(event.init.body).served, "agent_param_override_miss");
  assert.equal(typeof JSON.parse(event.init.body).response_status, "number");
  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    0,
    "?agent=true must not enqueue a render",
  );
});

test("without ?agent=true, a browser from an unverified source is NOT diverted", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/p/?agent=false", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(
    calls.filter((c) => c.url.includes("r2.norg.test")).length,
    0,
    "no override -> normal classification -> origin",
  );
});

// Spec AC7: "the mirror fetch fails, times out, or the worker throws ... the
// visitor receives the unmodified origin response." fetchFromNorg maps any
// non-200 (incl. a 503 R2 outage — NOT just a definite 404) to response:null,
// so the override must fail open to the origin and tag the hit as a miss. A 503
// is used here specifically because the builder's other miss test only pins the
// 404 path; this pins the error path AC7 calls out.
test("AC7: a ?agent=true R2 error (503) fails open to the untouched origin", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("boom", { status: 503 })],
  ]);

  const response = await handleRequest(req("/p/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  const event = calls.find((c) => c.url.includes("/edge/events"));
  assert.equal(JSON.parse(event.init.body).served, "agent_param_override_miss");
  assert.equal(typeof JSON.parse(event.init.body).response_status, "number");
  // An R2 outage under the override must NOT enqueue a render (same rule as the
  // 404 miss: param-driven traffic never triggers renders).
  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    0,
    "an R2 error under ?agent=true must not enqueue a render",
  );
});

// --- Rule 3: nothing happens without an authenticated feed ----------------

test("an unentitled install passes a real AI agent straight through, untouched", async () => {
  // The whole point of the gate: NORG refuses the key, so the worker must be
  // indistinguishable from not being installed. Not a strip, not a thin
  // origin — the customer's ordinary page, with no NORG headers on it.
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "no NORG header may appear");
  assert.equal(await response.text(), "origin body");
});

test("an unentitled install makes no mirror, render or event calls at all", async () => {
  installFetch([refusedPatternsRoute(403)]);

  await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain();

  for (const path of ["r2.norg.test", "/edge/render-requests", "/edge/events", "/edge/heartbeat"]) {
    assert.ok(
      !calls.find((c) => c.url.includes(path)),
      `an unentitled worker must not call ${path}`,
    );
  }
});

test("an unentitled install does not serve the MCP surface", async () => {
  // mcp.json is NORG content pulled from public R2, so it would otherwise leak
  // to an install NORG has refused.
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response('{"tools":[]}', { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/mcp", BROWSER), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.ok(!calls.find((c) => c.url.includes("r2.norg.test")), "must not read the MCP artifact");
});

test("an unentitled install ignores ?agent=true", async () => {
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/p/?agent=true", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "the override needs entitlement too");
});

// --- MIRROR 12: negative-cache the unentitled verdict ---------------------
// A refused / unreachable install must not blocking-probe NORG on every visit.
// The colo key mirrors PATTERN_CACHE_KEY in edge-router-worker.js.
const NEG_CACHE_KEY = "https://norg-edge.internal/bot-patterns";
const NEG_TTL_MS = 60 * 1000;

/** How many blocking NORG feed probes have been recorded so far. */
function probeCount() {
  return calls.filter((c) => c.url.includes("/api/v1/edge/bot-patterns")).length;
}

/** Seed the shared colo cache with a raw feed entry under the pattern key. */
async function seedColo(entry) {
  await globalThis.caches.default.put(
    new Request(NEG_CACHE_KEY),
    new Response(JSON.stringify(entry), { headers: { "content-type": "application/json" } }),
  );
}

test("AC1: after a 401 refusal, requests within the TTL probe NORG exactly once", async () => {
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  for (let i = 0; i < 4; i++) {
    const response = await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
    await drain();
    assert.equal(await response.text(), "origin body", "every request passes through");
  }
  assert.equal(probeCount(), 1, "one probe, then silence within the TTL");
});

test("AC1b: a 403 pause negative-caches identically to a 401", async () => {
  installFetch([
    refusedPatternsRoute(403),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  for (let i = 0; i < 3; i++) {
    await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
    await drain();
  }
  assert.equal(probeCount(), 1, "403 pause is cached just like a 401");
});

test("AC5: a cached-unentitled passthrough performs no awaited NORG probe", async () => {
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  await handleRequest(req(), env, ctx); // first request: the single probe
  await drain();
  const before = probeCount();
  await handleRequest(req(), env, ctx); // second: must not touch NORG at all
  await drain();
  assert.equal(probeCount(), before, "no blocking feed fetch on the cached-unentitled path");
});

test("AC2: after the TTL one request re-probes and a 200 feed restores diverting", async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  globalThis.Date.now = () => clock;
  try {
    let refuse = true;
    installFetch([
      [
        "/api/v1/edge/bot-patterns",
        async () =>
          refuse
            ? new Response(JSON.stringify({ detail: "paused" }), { status: 401 })
            : new Response(
                JSON.stringify({
                  patterns: [
                    {
                      pattern: "gptbot",
                      company: "openai",
                      purpose: "training",
                      serving_policy: "divert",
                    },
                  ],
                  cache_ttl: 3600,
                  cidr_ranges: {},
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
      ],
      ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
    ]);

    await handleRequest(req(), env, ctx); // refused -> negative cached
    await drain();
    await handleRequest(req(), env, ctx); // within TTL -> no probe
    await drain();
    assert.equal(probeCount(), 1, "no re-probe within the TTL");

    clock += NEG_TTL_MS + 1_000; // TTL elapsed
    refuse = false; // re-entitled
    await handleRequest(req(), env, ctx);
    await drain();
    assert.equal(probeCount(), 2, "exactly one re-probe after the TTL");
    assert.ok(
      calls.some((c) => c.url.includes("r2.norg.test")),
      "a 200 feed restores diverting behaviour immediately",
    );
  } finally {
    globalThis.Date.now = realNow;
  }
});

test("AC4: a fresh colo negative entry short-circuits a cold isolate with no probe", async () => {
  await seedColo({
    entitled: false,
    patterns: [],
    cidrRanges: {},
    fetchedAt: Date.now(),
    ttl: NEG_TTL_MS,
  });
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  // handleRequest from beforeEach is a cold isolate (no in-memory feed state).
  const response = await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain();

  assert.equal(probeCount(), 0, "the colo negative verdict spares the cold isolate a probe");
  assert.equal(response.headers.get("X-Norg-Edge"), null, "passthrough, untouched");
});

test("AC7: an unreachable probe with nothing cached negative-caches for colo-mates", async () => {
  installFetch([
    [
      "/api/v1/edge/bot-patterns",
      async () => {
        throw new Error("network down");
      },
    ],
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  await handleRequest(req(), env, ctx); // isolate A: unreachable, stamps colo negative
  await drain();
  assert.equal(probeCount(), 1, "isolate A probes once");

  const colomate = await loadColdIsolate(); // isolate B, same colo cache
  await colomate(req(), env, ctx);
  await drain();
  assert.equal(probeCount(), 1, "the cold colo-mate honours the negative verdict, no new probe");
});

test("AC3: a stale entitled colo entry still serves stale on outage (negative cache must not override)", async () => {
  const realNow = Date.now;
  const now = 5_000_000;
  globalThis.Date.now = () => now;
  try {
    // Entitled entry older than its own ttl -> stale, but still entitled.
    await seedColo({
      entitled: true,
      patterns: [
        {
          pattern: "gptbot",
          company: "openai",
          purpose: "training",
          serving_policy: "divert",
        },
      ],
      cidrRanges: {},
      agenticPathPrefix: "/ai",
      fetchedAt: now - 2 * 3600 * 1000,
      ttl: 3600 * 1000,
    });
    installFetch([
      [
        "/api/v1/edge/bot-patterns",
        async () => {
          throw new Error("network down");
        },
      ],
      ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
    ]);

    const cold = await loadColdIsolate();
    await cold(req("/products/widget/", GPTBOT), env, ctx);
    await drain();

    assert.ok(
      calls.some((c) => c.url.includes("r2.norg.test")),
      "the stale entitled entry still diverts (serve-stale-on-error preserved)",
    );
    // The background refresh hit an outage and must NOT have stamped a negative
    // verdict over the entitled colo entry.
    const stored = await globalThis.caches.default.match(new Request(NEG_CACHE_KEY));
    assert.equal(
      (await stored.json()).entitled,
      true,
      "colo entry stays entitled after the failed refresh",
    );
  } finally {
    globalThis.Date.now = realNow;
  }
});

test("AC1/AC2 boundary: the negative-TTL freshness guard is strict (age < ttl)", async () => {
  // Oracle: the guard is `now - fetchedAt < ttl` (edge-router-worker.js getBotFeed /
  // readCachedFeed). Pin the exact boundary so a `<` -> `<=` mutation is caught:
  // at age == ttl-1 the verdict is still fresh (skip); at age == ttl it is stale
  // (re-probe). Comfortable-distance tests (well within / well past) miss this flip.
  const realNow = Date.now;
  try {
    const base = 2_000_000;
    await seedColo({
      entitled: false,
      patterns: [],
      cidrRanges: {},
      fetchedAt: base,
      ttl: NEG_TTL_MS,
    });
    installFetch([
      refusedPatternsRoute(401),
      ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
    ]);

    // age == ttl-1 -> still fresh -> a cold isolate honours it with NO probe.
    globalThis.Date.now = () => base + NEG_TTL_MS - 1;
    const iso1 = await loadColdIsolate();
    await iso1(req(), env, ctx);
    await drain();
    assert.equal(probeCount(), 0, "at ttl-1 the negative verdict is still fresh: no probe");

    // age == ttl -> stale -> a cold isolate re-probes exactly once.
    globalThis.Date.now = () => base + NEG_TTL_MS;
    const iso2 = await loadColdIsolate();
    await iso2(req(), env, ctx);
    await drain();
    assert.equal(probeCount(), 1, "at exactly ttl the verdict is stale: re-probe (guard is strict <)");
  } finally {
    globalThis.Date.now = realNow;
  }
});

test("AC9: a failed colo negative-write purges the entitled entry, never leaves it readable", async () => {
  // Oracle: stampNegativeFeed (edge-router-worker.js) — on a cache.put failure it
  // MUST fall back to cache.delete, so a refused install never leaves its old
  // ENTITLED colo entry readable by the next isolate. Spec AC9. Adversarial:
  // dropping the delete fallback leaves the stale entitled entry in the colo
  // store, which this test then reads back as still-entitled and fails.
  let deletedKey = null;
  globalThis.caches = {
    default: new (class extends FakeCache {
      async put(request, response) {
        if (request.url === NEG_CACHE_KEY) throw new Error("colo write failed");
        return super.put(request, response);
      }
      async delete(request) {
        deletedKey = request.url;
        return super.delete(request);
      }
    })(),
  };
  // Seed a STALE entitled entry (fetchedAt far in the past) so getBotFeed serves
  // it stale and runs the background refresh — which 401s and revokes.
  globalThis.caches.default.store.set(
    NEG_CACHE_KEY,
    JSON.stringify({
      entitled: true,
      patterns: [{ pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" }],
      cidrRanges: {},
      agenticPathPrefix: "/ai",
      fetchedAt: 1000, // real Date.now() is far larger -> stale
      ttl: 3600 * 1000,
    }),
  );
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain(); // let the background refresh (401 -> revoke -> stampNegativeFeed) settle

  assert.equal(deletedKey, NEG_CACHE_KEY, "the failed negative-write falls back to deleting the colo entry");
  const stored = await globalThis.caches.default.match(new Request(NEG_CACHE_KEY));
  assert.equal(stored, undefined, "the revoked entitlement is purged, never left readable as entitled");
});

// --- serving_policy: NORG decides who may be diverted ---------------------

test("a matched bot whose policy is never_divert passes through", async () => {
  installFetch([
    patternsRoute([
      { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "never_divert" },
    ]),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.ok(!calls.find((c) => c.url.includes("r2.norg.test")), "never_divert must not divert");
});

test("a feed that omits serving_policy diverts nobody (fail-safe by construction)", async () => {
  // Migration 495 defaults every row to never_divert, so an absent field must
  // behave the same way — never as an implicit "divert".
  installFetch([
    patternsRoute([{ pattern: "gptbot", company: "openai", purpose: "training" }]),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/products/widget/", GPTBOT), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
});

// --- Story 12: operator CIDR sets, cf.verifiedBotCategory as the fallback --

const OPENAI_CIDRS = { openai: { cidrs: ["203.0.113.0/24"] } };

function ipReq(path, ua, ip, cf) {
  return req(path, ua, { cf, headers: { "cf-connecting-ip": ip } });
}

test("a divert candidate from inside the operator's CIDR set is served", async () => {
  installFetch([
    patternsRoute(undefined, OPENAI_CIDRS),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  // cf: {} — no Cloudflare verification at all, so only the CIDR can allow it.
  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "203.0.113.7", {}),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

test("a spoofed UA from outside the operator's CIDR set gets the origin", async () => {
  // The headline story-12 case: `curl -A "GPTBot/1.0"` from anywhere.
  installFetch([
    patternsRoute(undefined, OPENAI_CIDRS),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "198.51.100.9", {}),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.ok(!calls.find((c) => c.url.includes("r2.norg.test")), "spoofed UA must not divert");
});

test("a published CIDR set overrides Cloudflare's own verified-bot signal", async () => {
  // cf.verifiedBotCategory only says "some verified bot" — it would let a
  // verified crawler presenting another operator's UA through. The
  // operator-specific set is authoritative when we have one.
  installFetch([
    patternsRoute(undefined, OPENAI_CIDRS),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "198.51.100.9", { verifiedBotCategory: "Search Engine" }),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "CIDR must win over the cf signal");
});

test("with no CIDR set for the operator, cf.verifiedBotCategory still decides", async () => {
  // The per-zone fallback story 12 specifies, for operators whose ranges have
  // never been refreshed (story 11 publishes them per operator).
  installFetch([
    patternsRoute(undefined, { perplexity: { cidrs: ["192.0.2.0/24"] } }),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "198.51.100.9", VERIFIED_CF),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

test("an IPv6 client falls back to the cf signal rather than being refused", async () => {
  // The published sets are IPv4-only, so an IPv6 bot is unmeasurable against
  // them — answering "not in the set" would refuse every IPv6 crawler.
  installFetch([
    patternsRoute(undefined, OPENAI_CIDRS),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "2001:db8::1", VERIFIED_CF),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

// --- The agentic path surface (/ai/*, migration 500) ----------------------

test("isAgenticPath matches the subtree but not a same-prefixed sibling", () => {
  assert.equal(isAgenticPath("/ai", "/ai"), true);
  assert.equal(isAgenticPath("/ai/products/widget", "/ai"), true);
  assert.equal(isAgenticPath("/aircraft", "/ai"), false, "/ai must not capture /aircraft");
  assert.equal(isAgenticPath("/ai-assistant", "/ai"), false);
  assert.equal(isAgenticPath("/products", "/ai"), false);
  // An unconfigured prefix must never match, or an unentitled feed would
  // capture the whole site with "".
  assert.equal(isAgenticPath("/anything", ""), false);
});

test("/ai/<path> serves the R2 render to a plain browser from an unverified source", async () => {
  // The point of the surface: addressed by URL, so no classification, no
  // source-IP verification, no bot required.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    req("/ai/products/widget/", BROWSER, { cf: {} }),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(await response.text(), "<html>render</html>");
});

test("/ai/<path> strips the prefix before the R2 key lookup", async () => {
  // /ai/products/widget/ must resolve to the same object /products/widget/
  // mirrors to — the prefix is a customer-facing address, not part of the key.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  await handleRequest(req("/ai/products/widget/", BROWSER, { cf: {} }), env, ctx);
  await drain();

  const mirror = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(mirror.url, "https://r2.norg.test/site-123/products/widget/index.html");
});

test("the bare prefix maps to the site root index", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>root</html>", { status: 200 })],
  ]);

  await handleRequest(req("/ai", BROWSER, { cf: {} }), env, ctx);
  await drain();

  const mirror = calls.find((c) => c.url.includes("r2.norg.test"));
  assert.equal(mirror.url, "https://r2.norg.test/site-123/index.html");
});

test("an /ai/* miss passes through to the origin and enqueues NO render", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(req("/ai/missing/", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(await response.text(), "origin body");
  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    0,
    "the agentic surface serves what NORG has built; it must not queue work",
  );
});

test("an /ai/* R2 error also passes through untouched", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("boom", { status: 503 })],
  ]);

  const response = await handleRequest(req("/ai/p/", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(await response.text(), "origin body");
});

test("a search engine is served the agentic path like anyone else", async () => {
  // NOT cloaking: the same URL returns the same bytes to every caller, which
  // is why this branch sits above the traditional-search floor.
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/ai/products/widget/", GOOGLEBOT), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

test("a configurable prefix from the feed is honoured over the default", async () => {
  installFetch([
    patternsRouteWithPrefix("/agents"),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const onNew = await handleRequest(req("/agents/p/", BROWSER, { cf: {} }), env, ctx);
  await drain();
  assert.equal(onNew.headers.get("X-Norg-Edge"), "mirror");

  // And the default must no longer be live once the site moves off it.
  calls = [];
  const onOld = await handleRequest(req("/ai/p/", BROWSER, { cf: {} }), env, ctx);
  await drain();
  assert.equal(onOld.headers.get("X-Norg-Edge"), null, "/ai must be inert once reconfigured");
});

test("agentic hits are tagged distinctly from user-agent diverts", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  await handleRequest(req("/ai/p/", BROWSER, { cf: {} }), env, ctx);
  await drain();

  const event = calls.find((c) => c.url.includes("/edge/events"));
  const body = JSON.parse(event.init.body);
  assert.equal(body.served, "agentic_path");
  assert.equal(body.response_status, 200);
  assert.equal(body.is_ai_bot, false, "a URL hit is not evidence of a bot");
});

test("an unentitled install does not serve the agentic path either", async () => {
  installFetch([
    refusedPatternsRoute(401),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(req("/ai/p/", BROWSER, { cf: {} }), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.ok(!calls.find((c) => c.url.includes("r2.norg.test")), "must not read R2 unentitled");
});

// --- EDGEPAR 04: two-binding worker bundle (baked defaults) ----------------

// A hand/deploy-button install binds only SITE_ID + NORG_SITE_KEY; the worker
// bakes NORG_API_URL, NORG_CONTENT_BASE, STRIP_FALLBACK_ENABLED, EDGE_DISABLED
// and LAZY_RENDER_ENABLED as defaults. Routes match on the PRODUCTION default
// hostnames to prove the defaults, not the (absent) bindings, are in effect.
const TWO_BINDING_ENV = { SITE_ID: "site-123", NORG_SITE_KEY: "nek_live_secret" };

test("two-binding install fetches patterns + reads renders from the baked defaults", async () => {
  installFetch([
    patternsRoute(),
    ["edge-content.norg.ai", async () => new Response("<html>ok</html>", { status: 200 })],
  ]);

  await handleRequest(req("/products/widget/"), TWO_BINDING_ENV, ctx);
  await drain();

  // Patterns come from the baked NORG_API_URL default.
  const patterns = calls.find((c) => c.url.includes("/api/v1/edge/bot-patterns"));
  assert.ok(patterns, "patterns must be fetched");
  assert.ok(
    patterns.url.startsWith("https://content-craft-api.norg.ai/"),
    `expected the baked NORG_API_URL, got ${patterns.url}`,
  );
  // Renders come from the baked NORG_CONTENT_BASE default, tenant-scoped by SITE_ID.
  const mirror = calls.find((c) => c.url.includes("edge-content.norg.ai"));
  assert.equal(
    mirror.url,
    "https://edge-content.norg.ai/site-123/products/widget/index.html",
  );
});

test("two-binding install strips on a miss and asks NORG to render (baked defaults)", async () => {
  installFetch([
    patternsRoute(),
    ["edge-content.norg.ai", async () => new Response("nope", { status: 404 })],
    ["customer.com", async () => new Response(RICH_HTML, {
      status: 200, headers: { "content-type": "text/html" },
    })],
  ]);

  const response = await handleRequest(req("/new-page/"), TWO_BINDING_ENV, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "stripped");
  const render = calls.find((c) => c.url.includes("/edge/render-requests"));
  assert.ok(render, "expected a render request under the default LAZY_RENDER_ENABLED=true");
  assert.ok(
    render.url.startsWith("https://content-craft-api.norg.ai/"),
    "render request must go to the baked NORG_API_URL",
  );
});

test('LAZY_RENDER_ENABLED="false" serves the stripped origin without asking to render', async () => {
  installFetch([
    patternsRoute(),
    ["edge-content.norg.ai", async () => new Response("nope", { status: 404 })],
    ["customer.com", async () => new Response(RICH_HTML, {
      status: 200, headers: { "content-type": "text/html" },
    })],
  ]);

  const env2 = { ...TWO_BINDING_ENV, LAZY_RENDER_ENABLED: "false" };
  const response = await handleRequest(req("/lazy-off/"), env2, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "stripped");
  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    0,
    "requestRender must NOT be called when LAZY_RENDER_ENABLED=false",
  );
});

test('LAZY_RENDER_ENABLED="false" with strip off serves the plain origin, still no render', async () => {
  installFetch([
    patternsRoute(),
    ["edge-content.norg.ai", async () => new Response("nope", { status: 404 })],
    ["customer.com", async () => new Response(RICH_HTML, {
      status: 200, headers: { "content-type": "text/html" },
    })],
  ]);

  const env2 = {
    ...TWO_BINDING_ENV,
    LAZY_RENDER_ENABLED: "false",
    STRIP_FALLBACK_ENABLED: "false",
  };
  const response = await handleRequest(req("/plain-origin/"), env2, ctx);
  await drain();

  assert.equal(await response.text(), RICH_HTML, "plain origin is served when strip is off");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    0,
  );
});

test("LAZY_RENDER_ENABLED unset (default) still asks NORG to render on a miss", async () => {
  installFetch([
    patternsRoute(),
    ["edge-content.norg.ai", async () => new Response("nope", { status: 404 })],
    ["customer.com", async () => new Response(RICH_HTML, {
      status: 200, headers: { "content-type": "text/html" },
    })],
  ]);

  await handleRequest(req("/default-lazy/"), TWO_BINDING_ENV, ctx);
  await drain();

  assert.equal(
    calls.filter((c) => c.url.includes("/edge/render-requests")).length,
    1,
    "the default (unset) LAZY_RENDER_ENABLED must render exactly as today",
  );
});

test("an explicit binding overrides the baked default", async () => {
  installFetch([
    patternsRoute(),
    ["override-content.test", async () => new Response("<html>ok</html>", { status: 200 })],
  ]);

  // Override NORG_CONTENT_BASE; the request must hit the bound host, not the default.
  const env2 = { ...TWO_BINDING_ENV, NORG_CONTENT_BASE: "https://override-content.test" };
  await handleRequest(req("/products/widget/"), env2, ctx);
  await drain();

  const mirror = calls.find((c) => c.url.includes("override-content.test"));
  assert.equal(
    mirror.url,
    "https://override-content.test/site-123/products/widget/index.html",
  );
  assert.equal(
    calls.filter((c) => c.url.includes("edge-content.norg.ai")).length,
    0,
    "the baked default must not be used when the binding is present",
  );
});

test("EDGE_ENV unset still reports env: unknown on the health probe (no default)", async () => {
  installFetch([patternsRoute()]);

  const probe = req("/", BROWSER, { headers: { "x-norg-edge-check": "nek_live_secret" } });
  const response = await handleRequest(probe, TWO_BINDING_ENV, ctx);
  await drain();

  const body = await response.json();
  assert.equal(body.env, "unknown", "EDGE_ENV must have no baked default");
  assert.equal(body.disabled, false, "EDGE_DISABLED default is false");
});

// --- Static-asset fast path ------------------------------------------------

// A subresource request (css/js/image/font/media/download) is never a
// mirrorable document, so it must reach origin untouched without paying for
// classification, the R2 lookup, the render request or the visit log. The
// no-side-effect assertions are the point: an asset that merely *renders*
// correctly while still firing the backend calls has not fixed anything.

/** Every asset-path assertion: origin bytes, and none of the three costs. */
async function assertServedByOriginWithNoSideEffects(path, userAgent = GPTBOT) {
  installFetch([patternsRoute()]);
  const response = await handleRequest(req(path, userAgent), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, `${path} was diverted`);
  assert.ok(
    !calls.find((c) => c.url.includes("r2.norg.test")),
    `${path} paid for an R2 lookup`,
  );
  assert.ok(
    !calls.find((c) => c.url.includes("/edge/render-requests")),
    `${path} triggered a render request`,
  );
  assert.ok(
    !calls.find((c) => c.url.includes("/edge/events")),
    `${path} wrote a crawler-visit row`,
  );
  return response;
}

for (const path of [
  "/assets/site.css",
  "/static/app.js",
  "/app.js.map",
  "/images/hero.png",
  "/media/clip.mp4",
  "/audio/track.mp3",
  "/fonts/inter.woff2",
  "/downloads/spec.pdf",
  "/downloads/report.docx",
  "/archive/bundle.zip",
  "/site.webmanifest",
]) {
  test(`static asset ${path} goes straight to origin`, async () => {
    await assertServedByOriginWithNoSideEffects(path);
  });
}

test("asset matching is case-insensitive and ignores the query string", async () => {
  await assertServedByOriginWithNoSideEffects("/IMAGES/HERO.PNG");
  await assertServedByOriginWithNoSideEffects("/assets/site.css?v=2");
});

// Ambiguous shapes must fail TOWARD full handling: a missed asset costs the
// lookups this path exists to save, but a document wrongly treated as an asset
// is never mirrored at all.
test("ambiguous paths are treated as documents, not assets", async () => {
  for (const path of [
    "/file.pdf/", // trailing slash: not a file request
    "/style%2Ecss", // percent-encoded dot: no decoding games
    "/v1.2/page", // dot in a directory, not the final segment
    "/products/widget/", // ordinary document
  ]) {
    installFetch([
      patternsRoute(),
      ["r2.norg.test", async () => new Response(RICH_HTML, { status: 200 })],
    ]);
    const response = await handleRequest(req(path), env, ctx);
    await drain();
    assert.equal(
      response.headers.get("X-Norg-Edge"),
      "mirror",
      `${path} must still be handled as a document`,
    );
  }
});

// The reserved surfaces below share extensions with the asset set (.css) or sit
// next to it (.json/.txt were deliberately left out of the worker's list). If
// the fast path ever runs before them, NORG's own endpoints get proxied to the
// customer's origin — silent, and exactly what the placement guards against.
test("NORG's own reserved surfaces still win over the asset fast path", async () => {
  for (const path of [
    "/.norg/theme.css",
    "/llms.txt",
    "/tree.json",
    "/graph.jsonld",
    "/.well-known/mcp.json",
    "/openapi.json",
  ]) {
    installFetch([
      patternsRoute(),
      ["r2.norg.test", async () => new Response("norg artifact", { status: 200 })],
    ]);
    const response = await handleRequest(req(path, BROWSER, { cf: {} }), env, ctx);
    await drain();
    assert.notEqual(
      response.headers.get("X-Norg-Edge"),
      null,
      `${path} was proxied to origin instead of served by NORG`,
    );
  }
});

test("an agentic-path document with an asset extension is still served by NORG", async () => {
  installFetch([
    patternsRouteWithPrefix("/ai"),
    ["r2.norg.test", async () => new Response(RICH_HTML, { status: 200 })],
  ]);
  const response = await handleRequest(
    req("/ai/brochure.pdf", BROWSER, { cf: {} }),
    env,
    ctx,
  );
  await drain();

  assert.equal(
    response.headers.get("X-Norg-Edge"),
    "mirror",
    "the agentic subtree must win over the asset fast path",
  );
});

// Only GET carries a document request; isPassthrough drops every other method
// (bar MCP POST) before any of this runs. Pinned because "we only care about
// GET" is now a stated requirement, not incidental behaviour.
test("non-GET methods never reach the document pipeline", async () => {
  for (const method of ["PUT", "POST", "DELETE", "PATCH", "HEAD"]) {
    installFetch([patternsRoute()]);
    const response = await handleRequest(
      req("/products/widget/", GPTBOT, { method }),
      env,
      ctx,
    );
    await drain();
    assert.equal(
      response.headers.get("X-Norg-Edge"),
      null,
      `${method} must pass straight to origin`,
    );
    assert.ok(
      !calls.find((c) => c.url.includes("/edge/events")),
      `${method} must not write a crawler-visit row`,
    );
  }
});

test("a POST to an asset path exits before the asset check, via passthrough", async () => {
  installFetch([patternsRoute()]);
  const response = await handleRequest(
    req("/assets/site.css", GPTBOT, { method: "POST" }),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  // isPassthrough runs before getBotFeed, so a non-GET never even reads the feed.
  assert.ok(
    !calls.find((c) => c.url.includes("/edge/bot-patterns")),
    "a non-GET must not pay for the pattern feed",
  );
});

test("a skipped page's sibling artifacts are skipped too", async () => {
  // The skip feed lists PAGE paths, so the skip branch alone would never match
  // "/products/widget/index.md" — and the sibling branch runs before it. An
  // operator who excluded a page did not agree to serve the same mirrored text
  // one URL over.
  installFetch([
    patternsRouteWithSkip(["/products/widget"]),
    [
      "r2.norg.test",
      async () =>
        new Response("norg sibling", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
    ],
  ]);

  for (const sibling of ["/products/widget/index.md", "/products/widget/webmcp.js"]) {
    const response = await handleRequest(req(sibling), env, ctx);
    await drain();

    assert.equal(await response.text(), "origin body", `${sibling} served origin`);
    assert.equal(response.headers.get("X-Norg-Edge"), null, `${sibling} untagged`);
  }
  assert.equal(
    calls.filter((c) => c.url.includes("r2.norg.test")).length,
    0,
    "the mirror must never be consulted for a skipped page's siblings",
  );
});

// --- IPv6 source verification (lib/cidr.mjs) ------------------------------

const OPENAI_DUAL_STACK = { openai: { cidrs: ["203.0.113.0/24", "2001:db8:1::/48"] } };

test("an IPv6 client inside the operator's published IPv6 range is served", async () => {
  installFetch([
    patternsRoute(undefined, OPENAI_DUAL_STACK),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  // cf: {} — no Cloudflare verification at all, so only the CIDR can allow it.
  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "2001:db8:1::42", {}),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

test("an IPv6 client outside the operator's IPv6 range gets the origin, even when cf says verified", async () => {
  installFetch([
    patternsRoute(undefined, OPENAI_DUAL_STACK),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "2001:db8:2::42", VERIFIED_CF),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null, "a published IPv6 set is authoritative, like IPv4");
  assert.ok(!calls.find((c) => c.url.includes("r2.norg.test")), "must not reach the mirror");
});

test("an IPv4 client is unaffected by IPv6 ranges in the same set", async () => {
  installFetch([
    patternsRoute(undefined, OPENAI_DUAL_STACK),
    ["r2.norg.test", async () => new Response("<html>render</html>", { status: 200 })],
  ]);

  const response = await handleRequest(
    ipReq("/products/widget/", GPTBOT, "203.0.113.7", {}),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
});

// --- MCP forward carries only what JSON-RPC needs ---------------------------

test("MCP POST: cookies and authorization never reach NORG; JSON-RPC headers do", async () => {
  let forwarded = null;
  installFetch([
    patternsRoute(),
    [
      "/public-mcp",
      async (_url, init) => {
        forwarded = new Headers(init.headers);
        return new Response("{}", { status: 200 });
      },
    ],
  ]);

  const request = new Request(MCP_ORIGIN_URL, {
    method: "POST",
    headers: {
      "user-agent": BROWSER,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "sess-1",
      cookie: "session=secret",
      authorization: "Bearer customer-token",
      "x-forwarded-for": "198.51.100.9",
      "cf-connecting-ip": "198.51.100.9",
    },
    body: MCP_JSONRPC,
  });
  const response = await handleRequest(request, env, ctx);
  await drain();

  assert.equal(response.status, 200);
  assert.ok(forwarded, "NORG must have been called");
  for (const name of ["cookie", "authorization", "x-forwarded-for", "cf-connecting-ip"]) {
    assert.equal(forwarded.get(name), null, `${name} must not be forwarded`);
  }
  assert.equal(forwarded.get("content-type"), "application/json");
  assert.equal(forwarded.get("accept"), "application/json, text/event-stream");
  assert.equal(forwarded.get("mcp-session-id"), "sess-1");
  assert.equal(forwarded.get("X-Norg-Site-Id"), env.SITE_ID);
  assert.equal(forwarded.get("X-Norg-Site-Key"), env.NORG_SITE_KEY);
});
