/**
 * The attach CLI's decisions about a live CloudFront distribution.
 *
 * @description Covers the refusals, which are the point of the tool.
 *
 * The risky part of attaching is not the happy path — it is what the tool does
 * when the distribution already has routing on it. That is a refusal, and a
 * refusal that quietly stopped refusing is the failure worth catching. The
 * other thing worth pinning is the upgrade from the retired Lambda layout: what
 * that install left behind must go, including the headers its router stripped.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  attachGate,
  carveOutBehaviours,
  deployArgs,
  detachGate,
  isOurs,
  parseArgs,
  parseHeaderPairs,
  plannedOutputs,
  stackName,
} from "../install/attach.mjs";
import {
  CURATED_ASSET_SUFFIXES,
  DEFAULT_ROUTE_EXCLUSIONS,
  DYNAMIC_ROUTE_EXCLUSIONS,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
  MANAGED_CACHING_DISABLED_ID,
  MCP_PATH_PATTERNS,
} from "../../core/exclusions.mjs";
import { GATE_VERSION } from "../function/build.mjs";

/**
 * A minimal distribution config with one origin and a default behaviour.
 *
 * @param {Object} overrides Behaviour fields to override.
 * @returns {Object} Distribution config.
 */
function distributionConfig(overrides = {}) {
  return {
    Comment: "customer site",
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: "customer-origin",
          DomainName: "origin.example.com",
          CustomHeaders: { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "customer-origin",
      CachePolicyId: "managed-caching-optimized",
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
      ...overrides,
    },
  };
}

const ROUTER_ARN = "arn:aws:lambda:us-east-1:111:function:norg-router:7";

/**
 * A distribution as the retired Lambda layout left it, written out by hand now
 * that nothing in this repo produces it: router on the default behaviour,
 * install config on the customer's origin, and MCP, dynamic and static carve-outs.
 *
 * @returns {Object} Distribution config.
 */
function lambdaLayoutInstall() {
  const config = distributionConfig({
    CachePolicyId: MANAGED_CACHING_DISABLED_ID,
    LambdaFunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "origin-request", LambdaFunctionARN: ROUTER_ARN, IncludeBody: false }],
    },
  });
  config.Origins.Items[0].CustomHeaders = {
    Quantity: 3,
    Items: [
      { HeaderName: "x-api-key", HeaderValue: "theirs" },
      { HeaderName: "x-norg-secret-arn", HeaderValue: "arn:aws:secretsmanager:us-east-1:111:secret:k" },
      { HeaderName: "x-norg-probe-token", HeaderValue: "nprobe_tok" },
    ],
  };
  const base = { TargetOriginId: "customer-origin" };
  const noFunctions = { LambdaFunctionAssociations: { Quantity: 0, Items: [] }, FunctionAssociations: { Quantity: 0, Items: [] } };
  const items = [
    ...MCP_PATH_PATTERNS.map((PathPattern) => ({
      ...base,
      PathPattern,
      LambdaFunctionAssociations: { Quantity: 1, Items: [{ EventType: "origin-request", LambdaFunctionARN: ROUTER_ARN, IncludeBody: true }] },
    })),
    ...DYNAMIC_ROUTE_EXCLUSIONS.map((PathPattern) => ({
      ...base,
      ...noFunctions,
      PathPattern,
      CachePolicyId: MANAGED_CACHING_DISABLED_ID,
      OriginRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
    })),
    ...[...DEFAULT_ROUTE_EXCLUSIONS, ...CURATED_ASSET_SUFFIXES.map((s) => `*${s}`)].map((PathPattern) => ({
      ...base,
      ...noFunctions,
      PathPattern,
      CachePolicyId: "static-policy",
    })),
  ];
  config.CacheBehaviors = { Quantity: items.length, Items: items };
  return config;
}

const GATE_OUTPUTS = {
  FunctionArn: "arn:aws:cloudfront::111:function/norg-edge-gate-site-1",
  FunctionName: "norg-edge-gate-site-1",
  ReceptionistHost: "edge-content.norg.ai",
  ReceptionistOriginId: "norg-receptionist",
  CustomerOriginId: "customer-origin",
  GateVersion: "0.1.0",
  OriginCustomHeaders: "x-norg-site-id=site-1, x-norg-env=production",
};
const GATE_OPTIONS = {
  distributionId: "E123",
  originHeaders: "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=nmt_secret_token",
};

test("gate: the function goes on viewer-request, no Lambda is added, and the cache policy is left alone", () => {
  const config = distributionConfig();
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  assert.deepEqual(behaviour.FunctionAssociations, {
    Quantity: 1,
    Items: [{ EventType: "viewer-request", FunctionARN: GATE_OUTPUTS.FunctionArn }],
  });
  assert.deepEqual(behaviour.LambdaFunctionAssociations, { Quantity: 0, Items: [] });
  assert.equal(behaviour.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, "gate headers and the query string must reach the receptionist");
  assert.equal(behaviour.CachePolicyId, "managed-caching-optimized", "humans never reach NORG code: HTML caching is not the gate's business");
  assert.ok(changes.some((c) => /cache policy\s+managed-caching-optimized left as it is/.test(c)), "the dry run says the cache policy is untouched");
  assert.ok(changes.some((c) => /origin request\s+managed-caching-optimized|origin request\s+\(none\) -> AllViewerExceptHostHeader/.test(c)));
});

test("gate: the receptionist origin is added, https-only, with the stack headers and the caller's token; the customer origin is untouched", () => {
  const config = distributionConfig();
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);

  assert.equal(config.Origins.Quantity, 2);
  const receptionist = config.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.ok(receptionist, "receptionist origin missing");
  assert.equal(receptionist.DomainName, "edge-content.norg.ai");
  assert.equal(receptionist.CustomOriginConfig.OriginProtocolPolicy, "https-only");
  assert.deepEqual(receptionist.CustomOriginConfig.OriginSslProtocols, { Quantity: 1, Items: ["TLSv1.2"] });
  const headers = Object.fromEntries(receptionist.CustomHeaders.Items.map((h) => [h.HeaderName.toLowerCase(), h.HeaderValue]));
  assert.equal(headers["x-norg-mirror-token"], "nmt_secret_token");
  assert.equal(headers["x-norg-site-id"], "site-1");
  assert.equal(headers["x-norg-env"], "production");
  assert.equal(receptionist.CustomHeaders.Quantity, receptionist.CustomHeaders.Items.length);
  assert.equal(receptionist.CustomHeaders.Items.filter((h) => h.HeaderName.toLowerCase() === "x-norg-site-id").length, 1, "the caller's X-Norg-Site-Id and the stack's x-norg-site-id are one header");

  const customer = config.Origins.Items.find((o) => o.Id === "customer-origin");
  assert.deepEqual(customer.CustomHeaders, { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] }, "nothing is written on the customer's own origin");
});

test("gate: attaching REFUSES without the mirror token — a tokenless receptionist 404s everything, silently", () => {
  const config = distributionConfig();
  assert.throws(() => attachGate(config, GATE_OUTPUTS, { layout: "gate" }), /x-norg-mirror-token/);
  assert.throws(() => attachGate(config, GATE_OUTPUTS, { layout: "gate", originHeaders: "X-Norg-Site-Id=site-1" }), /x-norg-mirror-token/);
});

test("gate: attaching REFUSES when the stack's CustomerOriginId is not the default behaviour's origin", () => {
  // The function names the customer origin by Id in its origin group; a wrong
  // Id fails every agent request at the edge while humans see nothing wrong.
  const config = distributionConfig();
  assert.throws(
    () => attachGate(config, { ...GATE_OUTPUTS, CustomerOriginId: "web" }, GATE_OPTIONS),
    /CustomerOriginId is "web" but the default behaviour points at "customer-origin"/,
  );
});

test("gate: the old viewer-classifier is replaced, a foreign viewer-request function is refused, viewer-response is kept", () => {
  const classifier = { EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::111:function/norg-edge-cloudfront-norg-viewer-classifier" };
  const theirs = { EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/their-headers" };
  const config = distributionConfig({ FunctionAssociations: { Quantity: 2, Items: [classifier, theirs] } });
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  assert.deepEqual(config.DefaultCacheBehavior.FunctionAssociations.Items, [
    theirs,
    { EventType: "viewer-request", FunctionARN: GATE_OUTPUTS.FunctionArn },
  ]);
  assert.ok(changes.some((c) => c.includes("replaces") && c.includes("viewer-classifier")));

  const foreign = distributionConfig({
    FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::222:function/their-router" }] },
  });
  assert.throws(() => attachGate(foreign, GATE_OUTPUTS, GATE_OPTIONS), /already has a viewer-request CloudFront Function/);
});

test("gate: the carve-outs are the dynamic group only, listed ahead of the customer's own", () => {
  const config = distributionConfig();
  config.CacheBehaviors = { Quantity: 1, Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }] };
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const patterns = config.CacheBehaviors.Items.map((b) => b.PathPattern);
  assert.deepEqual(patterns, [...DYNAMIC_ROUTE_EXCLUSIONS, "/their-thing/*"]);
  for (const b of config.CacheBehaviors.Items.slice(0, -1)) {
    assert.equal(b.CachePolicyId, MANAGED_CACHING_DISABLED_ID, b.PathPattern);
    assert.equal(b.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, b.PathPattern);
    assert.ok(b.AllowedMethods.Items.includes("POST"), `${b.PathPattern} must accept POST`);
  }
  assert.ok(changes.some((c) => /no MCP or static carve-outs/.test(c)), "the dry run says what is NOT carved out");
  assert.equal(config.CacheBehaviors.Quantity, config.CacheBehaviors.Items.length);
});

test("gate: re-attaching is idempotent — one receptionist origin, one association, no duplicate carve-outs", () => {
  const config = distributionConfig();
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const once = structuredClone(config);
  const changes = attachGate(config, GATE_OUTPUTS, { ...GATE_OPTIONS, originHeaders: "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=nmt_rotated" });
  assert.equal(config.Origins.Quantity, 2);
  assert.equal(config.DefaultCacheBehavior.FunctionAssociations.Quantity, 1);
  assert.equal(config.CacheBehaviors.Items.length, once.CacheBehaviors.Items.length);
  const receptionist = config.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.equal(receptionist.CustomHeaders.Items.find((h) => h.HeaderName === "X-Norg-Mirror-Token").HeaderValue, "nmt_rotated", "re-attaching is how a token rotation lands");
  assert.ok(changes.some((c) => /origin\s+~norg-receptionist/.test(c)), "the dry run says the origin is replaced, not added");
});

test("gate: a receptionist Id that is the customer's default origin is refused", () => {
  const config = distributionConfig();
  assert.throws(
    () => attachGate(config, { ...GATE_OUTPUTS, ReceptionistOriginId: "customer-origin" }, GATE_OPTIONS),
    /is your default origin's Id/,
  );
});

test("gate: detaching removes the function, the receptionist origin, every x-norg header and our carve-outs — and nothing else", () => {
  const theirs = { EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/their-headers" };
  const config = distributionConfig({ FunctionAssociations: { Quantity: 1, Items: [theirs] } });
  config.CacheBehaviors = { Quantity: 1, Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }] };
  // The API writes its headers capitalised; detach must still find them.
  config.Origins.Items[0].CustomHeaders.Items.push({ HeaderName: "X-Norg-Stale", HeaderValue: "left over" });
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);

  detachGate(config, { layout: "gate" });
  const behaviour = config.DefaultCacheBehavior;
  assert.deepEqual(behaviour.FunctionAssociations, { Quantity: 1, Items: [theirs] });
  assert.deepEqual(config.Origins.Items.map((o) => o.Id), ["customer-origin"]);
  assert.deepEqual(config.Origins.Items[0].CustomHeaders, { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] });
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), ["/their-thing/*"]);
  assert.equal(JSON.stringify(config).includes("nmt_secret_token"), false, "detaching must take the token with it");
  assert.equal(behaviour.CachePolicyId, "managed-caching-optimized");
  assert.equal(behaviour.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, "restore nothing else: the dry run says the policy is left in place");
});

test("gate: detaching honours --receptionist-origin-id and refuses to remove the default origin", () => {
  const config = distributionConfig();
  attachGate(config, { ...GATE_OUTPUTS, ReceptionistOriginId: "norg-rx" }, GATE_OPTIONS);
  detachGate(config, { layout: "gate", receptionistOriginId: "norg-rx" });
  assert.deepEqual(config.Origins.Items.map((o) => o.Id), ["customer-origin"]);
  assert.throws(() => detachGate(config, { layout: "gate", receptionistOriginId: "customer-origin" }), /is your default origin/);
});


// ---------------------------------------------------------------------------
// Upgrading a distribution from the retired Lambda layout.
// ---------------------------------------------------------------------------

test("upgrade: our router and its MCP and static carve-outs go; only the dynamic carve-outs remain", () => {
  const config = lambdaLayoutInstall();
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  assert.deepEqual(config.DefaultCacheBehavior.LambdaFunctionAssociations, { Quantity: 0, Items: [] });
  assert.ok(changes.some((c) => /removed 1 NORG Lambda@Edge association/.test(c)));
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), DYNAMIC_ROUTE_EXCLUSIONS);
  assert.ok(config.CacheBehaviors.Items.every((b) => !b.LambdaFunctionAssociations?.Quantity && !b.FunctionAssociations?.Quantity));
});

test("upgrade: the old install's x-norg headers leave the customer's origin, because nothing strips them now", () => {
  // The Lambda router deleted these from each request. With it gone they would
  // reach the customer's server, secret ARN and probe token included.
  const config = lambdaLayoutInstall();
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const customer = config.Origins.Items.find((o) => o.Id === "customer-origin");
  assert.deepEqual(customer.CustomHeaders, { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] });
  assert.ok(changes.some((c) => /removed 2 x-norg-\* header/.test(c)), "the dry run says so");
  const receptionist = config.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.ok(receptionist.CustomHeaders.Items.some((h) => h.HeaderName === "X-Norg-Mirror-Token"), "the receptionist keeps its own");
});

test("upgrade: a foreign origin-request Lambda is refused, not replaced", () => {
  const config = distributionConfig({
    LambdaFunctionAssociations: { Quantity: 1, Items: [{ EventType: "origin-request", LambdaFunctionARN: "arn:aws:lambda:us-east-1:222:function:theirs:3" }] },
  });
  assert.throws(() => attachGate(config, GATE_OUTPUTS, GATE_OPTIONS), /already has an origin-request Lambda@Edge function/);
});

test("detach clears a Lambda-layout install too, and keeps a customer's own Lambda", () => {
  const config = lambdaLayoutInstall();
  const theirs = { EventType: "origin-response", LambdaFunctionARN: "arn:aws:lambda:us-east-1:222:function:theirs:1" };
  config.DefaultCacheBehavior.LambdaFunctionAssociations.Items.push(theirs);
  config.CacheBehaviors.Items.push({ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" });

  const changes = detachGate(config, {});
  assert.deepEqual(config.DefaultCacheBehavior.LambdaFunctionAssociations, { Quantity: 1, Items: [theirs] });
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), ["/their-thing/*"]);
  assert.deepEqual(config.Origins.Items[0].CustomHeaders.Items.map((h) => h.HeaderName), ["x-api-key"]);
  assert.ok(changes.some((c) => /removed 1 NORG Lambda@Edge association/.test(c)));
});

// ---------------------------------------------------------------------------
// Carve-outs.
// ---------------------------------------------------------------------------

test("a customer behaviour on one of OUR patterns is kept, never replaced", () => {
  // The dangerous case: their /api/* points at a different origin. Replacing
  // it with our carve-out would repoint their API at their web server.
  const config = distributionConfig();
  const theirApi = { PathPattern: "/api/*", TargetOriginId: "api-origin", CachePolicyId: "their-policy" };
  config.CacheBehaviors = { Quantity: 1, Items: [theirApi] };
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);

  const apis = config.CacheBehaviors.Items.filter((b) => b.PathPattern === "/api/*");
  assert.equal(apis.length, 1, "no duplicate /api/*");
  assert.equal(apis[0].TargetOriginId, "api-origin", "theirs must survive untouched");

  detachGate(config, {});
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), ["/api/*"]);
});

test("attaching REFUSES rather than exceeding the customer's behaviour quota", () => {
  const config = distributionConfig();
  config.CacheBehaviors = {
    Quantity: 70,
    Items: Array.from({ length: 70 }, (_, i) => ({ PathPattern: `/theirs-${i}/*`, TargetOriginId: "customer-origin" })),
  };
  assert.throws(() => attachGate(config, GATE_OUTPUTS, GATE_OPTIONS), /over CloudFront's limit of 75/);
});

test("isOurs recognises our shapes and nothing on another origin", () => {
  const config = lambdaLayoutInstall();
  for (const b of config.CacheBehaviors.Items) assert.ok(isOurs(b, config), b.PathPattern);
  assert.equal(isOurs({ PathPattern: "*.css", TargetOriginId: "cdn-origin" }, config), false);
  assert.equal(isOurs({ PathPattern: "/api/*", TargetOriginId: "customer-origin", CachePolicyId: "theirs" }, config), false);
  assert.equal(isOurs({ PathPattern: "*/mcp", TargetOriginId: "customer-origin" }, config), false, "an MCP behaviour without our router is theirs");
});

test("the gate's carve-outs are the dynamic group only, all without functions", () => {
  const items = carveOutBehaviours("origin");
  assert.deepEqual(items.map((b) => b.PathPattern), DYNAMIC_ROUTE_EXCLUSIONS);
  assert.ok(items.every((b) => b.LambdaFunctionAssociations.Quantity === 0 && b.FunctionAssociations.Quantity === 0));
});

// ---------------------------------------------------------------------------
// The automatic install: what is deployed and what the dry run assumes.
// ---------------------------------------------------------------------------

test("the stack is deployed with values from the distribution, and the mirror token never reaches it", () => {
  const args = deployArgs(GATE_OPTIONS, "customer-origin");
  assert.ok(args.includes("SiteId=site-1"));
  assert.ok(args.includes("DistributionId=E123"));
  assert.ok(args.includes("CustomerOriginId=customer-origin"));
  assert.ok(args.includes("--no-fail-on-empty-changeset"), "re-running with nothing to change is not an error");
  assert.equal(args.join(" ").includes("nmt_secret_token"), false, "a token in a stack parameter is readable with describe-stacks");
  assert.equal(args.at(args.indexOf("--template-file") + 1).endsWith("attach-gate.yaml"), true);
});

test("GateVersion is always passed, or an upgrade keeps reporting the old version", () => {
  // `aws cloudformation deploy` keeps a parameter's previous value when omitted.
  assert.ok(deployArgs(GATE_OPTIONS, "o").includes(`GateVersion=${GATE_VERSION}`));
});

test("optional stack parameters are passed only when asked for", () => {
  assert.equal(deployArgs(GATE_OPTIONS, "o").some((a) => /^(NorgEnvironment|AlarmTopicArn|ReceptionistOriginId)=/.test(a)), false);
  const args = deployArgs({ ...GATE_OPTIONS, environment: "test", alarmTopicArn: "arn:t", receptionistOriginId: "norg-rx" }, "o");
  for (const expected of ["NorgEnvironment=test", "AlarmTopicArn=arn:t", "ReceptionistOriginId=norg-rx"]) assert.ok(args.includes(expected), expected);
});

test("the stack is named per distribution unless the caller names it", () => {
  assert.equal(stackName({ distributionId: "E123" }), "norg-gate-E123");
  assert.equal(stackName({ distributionId: "E123", stack: "mine" }), "mine");
});

test("an install without a site id is refused before anything is deployed", () => {
  assert.throws(() => deployArgs({ distributionId: "E1", originHeaders: "X-Norg-Mirror-Token=t" }, "o"), /x-norg-site-id/);
});

test("a dry run with no stack yet plans what --apply would create", () => {
  const missing = () => { throw new Error("Stack with id norg-gate-E123 does not exist"); };
  const outputs = plannedOutputs(GATE_OPTIONS, "customer-origin", missing);
  assert.match(outputs.FunctionArn, /created on --apply/);
  const config = distributionConfig();
  assert.doesNotThrow(() => attachGate(config, outputs, GATE_OPTIONS));
  assert.equal(config.Origins.Items.find((o) => o.Id === "norg-receptionist").DomainName, "edge-content.norg.ai");
});

test("a dry run uses an existing stack's values, but the distribution's actual origin", () => {
  const outputs = plannedOutputs(GATE_OPTIONS, "customer-origin", () => ({ ...GATE_OUTPUTS, CustomerOriginId: "old-origin" }));
  assert.equal(outputs.FunctionArn, GATE_OUTPUTS.FunctionArn);
  assert.equal(outputs.CustomerOriginId, "customer-origin", "--apply redeploys the stack with this, so it is no refusal");
});

test("a dry run does not treat any other AWS failure as a missing stack", () => {
  const denied = () => { throw new Error("AccessDenied"); };
  assert.throws(() => plannedOutputs(GATE_OPTIONS, "o", denied), /AccessDenied/);
});

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

test("argument parsing takes both --flag value and --flag=value, and keeps '=' inside a value", () => {
  const parsed = parseArgs([
    "--distribution-id=E1", "--stack", "s1", "--apply", "--yes",
    "--origin-headers=X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=abc=def",
    "--receptionist-origin-id", "norg-rx",
  ]);
  assert.deepEqual(parsed, {
    apply: true,
    detach: false,
    yes: true,
    distributionId: "E1",
    stack: "s1",
    originHeaders: "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=abc=def",
    receptionistOriginId: "norg-rx",
  });
  assert.deepEqual(parseHeaderPairs(parsed.originHeaders), [
    { HeaderName: "X-Norg-Site-Id", HeaderValue: "site-1" },
    { HeaderName: "X-Norg-Mirror-Token", HeaderValue: "abc=def" },
  ]);
  assert.throws(() => parseHeaderPairs("X-Norg-Site-Id"), /expected name=value/);
});

test("--apply and --yes are off unless asked for", () => {
  const parsed = parseArgs(["--distribution-id", "E1"]);
  assert.equal(parsed.apply, false, "a dry run is the default");
  assert.equal(parsed.yes, false);
});

test("--layout gate still works for old runbooks; --layout lambda says it is gone", () => {
  assert.doesNotThrow(() => parseArgs(["--layout", "gate"]));
  assert.throws(() => parseArgs(["--layout", "lambda"]), /gate is the only layout since 0\.6\.15/);
  assert.throws(() => parseArgs(["--layout=worker"]), /gate is the only layout/);
});

test("unknown and retired arguments are rejected, not silently accepted", () => {
  assert.throws(() => parseArgs(["--yolo"]), /unknown argument/);
  assert.throws(() => parseArgs(["--cache-policy=keep"]), /unknown argument/);
});
