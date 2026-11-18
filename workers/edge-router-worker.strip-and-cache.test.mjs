/**
 * Edge-router worker — strip rules and bot-pattern caching.
 *
 * Run with: node --test edge-router-worker.strip-and-cache.test.mjs
 *
 * HTMLRewriter is lol-html and cannot run outside the Workers runtime, so the
 * strip tests cover the DECISION surface (which selectors are removed, which
 * attributes survive) rather than the transformation itself. The actual
 * rewriting is verified against a real `wrangler dev` before release — see
 * the PR notes; this is a known and deliberate coverage boundary.
 *
 * The caching tests matter because a customer's install polls NORG on every
 * cold isolate: getting this wrong turns a large install fleet into a
 * self-inflicted load test on the API.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_shouldKeepAttribute as shouldKeepAttribute,
  __test_STRIP_REMOVE_SELECTORS as STRIP_REMOVE_SELECTORS,
  __test_STRIP_UNWRAP_SELECTORS as STRIP_UNWRAP_SELECTORS,
  __test_logEdgeEvent as logEdgeEvent,
  __test_countVisibleWords as countVisibleWords,
} from "./edge-router-worker.js";

/**
 * Load a fresh module instance.
 *
 * The pattern cache is module-level state — correct for a Worker, where it
 * persists for the life of an isolate — so each caching test needs its own
 * instance to stand in for a cold isolate.
 */
let moduleCounter = 0;
async function coldIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?isolate=${moduleCounter}`);
  return mod.__test_getBotFeed;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const body = this.store.get(req.url);
    return body === undefined ? undefined : { json: async () => JSON.parse(body) };
  }
  async put(req, res) {
    this.store.set(req.url, await res.text());
  }
  async delete(req) {
    return this.store.delete(req.url);
  }
}

let fetchCalls;
let waitUntilTasks;
const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };

beforeEach(() => {
  fetchCalls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
});

// --- Strip decision surface ----------------------------------------------

test("styling and behaviour attributes are dropped, meaning is kept", () => {
  for (const keep of ["href", "src", "alt", "title", "lang", "content"]) {
    assert.equal(shouldKeepAttribute(keep), true, `${keep} should survive`);
  }
  for (const drop of ["class", "style", "onclick", "data-analytics-id", "srcset"]) {
    assert.equal(shouldKeepAttribute(drop), false, `${drop} should be stripped`);
  }
});

test("the strip list removes chrome and executable content", () => {
  for (const selector of ["script", "style", "nav", "footer", "iframe", "form"]) {
    assert.ok(
      STRIP_REMOVE_SELECTORS.includes(selector),
      `expected ${selector} in the strip list`,
    );
  }
});

test("the strip list never removes content-bearing elements", () => {
  // A regression here would silently gut the fallback: an agent would receive
  // a page with the actual answer removed.
  for (const keep of ["p", "h1", "h2", "table", "ul", "li", "article", "main", "a"]) {
    assert.equal(
      STRIP_REMOVE_SELECTORS.includes(keep),
      false,
      `${keep} must not be stripped`,
    );
  }
});

test("button is unwrapped, not removed with its content", () => {
  // Regression: a retailer's mobile accordion menu wraps real category
  // labels in <h5><button><span>Trending</span></button></h5>. Grouping
  // "button" with script/style/nav in STRIP_REMOVE_SELECTORS deleted the
  // label text too, publishing empty <h5></h5> shells. The wrapper tag is
  // still noise (STRIP_UNWRAP_SELECTORS), but its content is meaning.
  assert.equal(
    STRIP_REMOVE_SELECTORS.includes("button"),
    false,
    "button must not be in the full-removal list",
  );
  assert.ok(
    STRIP_UNWRAP_SELECTORS.includes("button"),
    "button must be unwrapped so its label text survives",
  );
});

// --- Render-gap: raw word count on the served event (story 13) ------------

const eventEnv = {
  NORG_API_URL: "https://api.norg.test",
  SITE_ID: "site-123",
  NORG_SITE_KEY: "nek_live_secret",
};

function captureEdgeEvent() {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  };
  return () => body;
}

function fakeRequest() {
  const req = new Request("https://shop.example/widgets");
  req.cf = { country: "AU" };
  return req;
}

const classification = { is_ai_bot: true, bot_name: "gptbot", company: "openai", purpose: "training" };

test("countVisibleWords counts the strip-floor words (empty -> 0)", () => {
  assert.equal(countVisibleWords("<p>one two three</p>"), 3);
  assert.equal(countVisibleWords("<div></div>"), 0);
});

test("logEdgeEvent carries the raw word count on the stripped path", async () => {
  const read = captureEdgeEvent();
  await logEdgeEvent(eventEnv, fakeRequest(), classification, "stripped", 137);
  assert.equal(read().raw_word_count, 137);
  assert.equal(read().served, "stripped");
});

test("logEdgeEvent reports zero words distinctly from not-measured", async () => {
  const read = captureEdgeEvent();
  await logEdgeEvent(eventEnv, fakeRequest(), classification, "origin_thin", 0);
  assert.equal(read().raw_word_count, 0);
});

test("logEdgeEvent defaults raw_word_count to null on mirror/origin paths", async () => {
  const read = captureEdgeEvent();
  await logEdgeEvent(eventEnv, fakeRequest(), classification, "mirror");
  assert.equal(read().raw_word_count, null);
});

// --- Bot-pattern caching --------------------------------------------------

function installPatternFetch({ status = 200, patterns, cacheTtl = 3600 } = {}) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    if (status !== 200) return new Response("err", { status });
    return new Response(
      JSON.stringify({
        patterns: patterns ?? [{ pattern: "gptbot", company: "openai", purpose: "training" }],
        cache_ttl: cacheTtl,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

/**
 * Seed the colo cache with an entitled entry that has already expired.
 *
 * Written directly rather than fetched with a short cache_ttl: readFeedBody
 * treats a falsy cache_ttl as "use the 3600s default", so a 0 would produce a
 * FRESH entry and silently skip the revalidation path under test. fetchedAt 0
 * is the epoch, so the entry is stale regardless of clock.
 */
async function seedStaleFeed() {
  await globalThis.caches.default.put(
    new Request("https://norg-edge.internal/bot-patterns"),
    new Response(
      JSON.stringify({
        entitled: true,
        patterns: [
          { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
        ],
        cidrRanges: {},
        fetchedAt: 0,
        ttl: 1,
      }),
    ),
  );
}

test("the feed is fetched once and then served from cache", async () => {
  installPatternFetch();
  const getBotFeed = await coldIsolate();
  const first = await getBotFeed(env, ctx);
  const second = await getBotFeed(env, ctx);

  assert.equal(first.entitled, true);
  assert.equal(first.patterns[0].pattern, "gptbot");
  assert.deepEqual(second, first);
  assert.equal(fetchCalls.length, 1, "second call must not hit the network");
});

test("a cold isolate that cannot reach NORG is UNENTITLED, not fallen back", async () => {
  // There is no local pattern set to fall back to: an install that has never
  // been authenticated must change nothing, so the visitor sees the customer's
  // ordinary page and cannot tell the worker is installed.
  installPatternFetch({ status: 500 });
  const feed = await (await coldIsolate())(env, ctx);

  assert.equal(feed.entitled, false);
  assert.deepEqual(feed.patterns, []);
});

test("an outage does NOT revoke an install that already has a cached feed", async () => {
  // Open on outage: NORG being unreachable says nothing about entitlement, so
  // a working install keeps serving from the colo cache while NORG is away.
  // The entry must be STALE, or getBotFeed returns it on the fresh path and
  // the outage is never exercised at all.
  await seedStaleFeed();

  installPatternFetch({ status: 500 });
  const feed = await (await coldIsolate())(env, ctx);
  assert.equal(feed.entitled, true, "a 5xx must not withdraw a cached entitlement");
  assert.equal(feed.patterns[0].pattern, "gptbot");

  await Promise.allSettled(waitUntilTasks);

  // And the failed revalidation must not have purged the colo copy either —
  // that is the difference between an outage and a refusal.
  const cached = await globalThis.caches.default.match(
    new Request("https://norg-edge.internal/bot-patterns"),
  );
  assert.ok(cached, "an outage must leave the cached entitlement in place");
});

for (const status of [401, 403]) {
  test(`a ${status} refusal on a cold isolate is refused outright`, async () => {
    // Closed on refusal: 401 = bad/absent key, 403 = paused or uninstalled site
    // (site_auth.resolve_edge_site). With nothing cached there is nothing to
    // serve from, so the refusal applies to this very request.
    installPatternFetch({ status });
    const feed = await (await coldIsolate())(env, ctx);

    assert.equal(feed.entitled, false, `${status} must refuse`);
    assert.deepEqual(feed.patterns, []);
  });

  test(`a ${status} refusal overwrites a warm colo cache with a negative verdict on revalidation`, async () => {
    // A stale-but-entitled entry is served while the refresh runs behind the
    // response (stale-while-revalidate), so the refusal lands one request
    // later — but it MUST land, and it must take the revoked entitlement with
    // it. Under the negative-cache contract the refusal stamps an
    // entitled:false verdict OVER the colo copy (rather than purging it), so
    // the next cold isolate reads the refusal straight from cache without a
    // re-probe — the revoked entitlement is never reloadable either way.
    await seedStaleFeed();

    installPatternFetch({ status });
    const served = await (await coldIsolate())(env, ctx);
    assert.equal(served.entitled, true, "the stale entry still serves this request");

    await Promise.allSettled(waitUntilTasks);

    const cached = await globalThis.caches.default.match(
      new Request("https://norg-edge.internal/bot-patterns"),
    );
    assert.ok(cached, "the colo copy now holds the negative verdict, not purged");
    const verdict = await cached.json();
    assert.equal(
      verdict.entitled,
      false,
      "the colo copy must hold an entitled:false verdict, never the revoked entitlement",
    );

    // Proof it actually bites: a fresh isolate now reads the refusal (no reload
    // of the revoked entitlement), and needs no probe to do so.
    const before = fetchCalls.length;
    const next = await (await coldIsolate())(env, ctx);
    assert.equal(next.entitled, false, `${status} must revoke by the next isolate`);
    assert.equal(
      fetchCalls.length,
      before,
      "the cached negative verdict spares the next isolate a re-probe",
    );
  });
}

test("a warm colo cache spares a cold isolate the network call", async () => {
  // Cross-isolate reuse is what keeps a large install fleet off the API.
  installPatternFetch();
  await (await coldIsolate())(env, ctx);
  assert.equal(fetchCalls.length, 1);

  await (await coldIsolate())(env, ctx);
  assert.equal(fetchCalls.length, 1, "colo cache should have served the new isolate");
});

test("the request carries site credentials, not a NORG-internal secret", async () => {
  let seenHeaders;
  globalThis.fetch = async (url, init) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ patterns: [], cache_ttl: 60 }), { status: 200 });
  };
  await (await coldIsolate())(env, ctx);

  assert.equal(seenHeaders["X-Norg-Site-Id"], "site-123");
  assert.equal(seenHeaders["X-Norg-Site-Key"], "nek_live_secret");
  assert.ok(seenHeaders["X-Norg-Edge-Version"], "version should be reported");
});

test("the server's cache_ttl is honoured over the local default", async () => {
  installPatternFetch({ cacheTtl: 1 });
  await (await coldIsolate())(env, ctx);
  const cached = await globalThis.caches.default.match(
    new Request("https://norg-edge.internal/bot-patterns"),
  );
  const payload = await cached.json();
  assert.equal(payload.ttl, 1000, "ttl should be the server value in ms");
});
