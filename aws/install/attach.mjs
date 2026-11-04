/**
 * Install (or remove) the NORG edge gate on an EXISTING CloudFront distribution.
 *
 * Usage:
 *   node aws/install/attach.mjs --distribution-id E123 \
 *        --origin-headers "X-Norg-Site-Id=<id>,X-Norg-Mirror-Token=<token>" [--apply] [--yes]
 *   node aws/install/attach.mjs --distribution-id E123 --detach [--apply] [--yes]
 *
 * One command does the whole install. With --apply it deploys
 * aws/cloudformation/attach-gate.yaml (one CloudFront Function and its alarms),
 * then adds NORG's receptionist as an origin, puts the function on
 * viewer-request, forwards all viewer headers but Host, and adds the dynamic
 * carve-outs. The stack name and the customer origin are worked out from the
 * distribution; pass --stack only to choose your own stack name. Running it
 * again is how an upgrade or a token rotation lands.
 *
 * It leaves your cache policy alone, because humans never reach NORG code. The
 * mirror token the receptionist authenticates with is a secret, so it is never
 * a stack parameter: it goes straight onto the receptionist origin.
 *
 * IT IS A DRY RUN UNLESS YOU PASS --apply. It prints exactly what would change
 * and exits, creating nothing. --apply asks before changing anything unless you
 * also pass --yes.
 *
 * A distribution still on the retired Lambda layout (0.6.14 and earlier) is
 * upgraded in place: our router, its carve-outs and its x-norg-* origin headers
 * are removed. Those headers matter most, because that router was what stripped
 * them from each request before it reached your server.
 *
 * It REFUSES rather than works around a conflict. A viewer-request function or
 * origin-request Lambda@Edge that is not ours is someone else's routing
 * decision, and silently replacing it is how an install breaks a site in a way
 * nobody can attribute.
 *
 * Shells out to the AWS CLI rather than taking an SDK dependency: this repo's
 * build and tests are zero-install, and anyone attaching a distribution already
 * has the CLI configured.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLOUDFRONT_BEHAVIOUR_QUOTA,
  CURATED_ASSET_SUFFIXES,
  DEFAULT_ROUTE_EXCLUSIONS,
  DYNAMIC_ROUTE_EXCLUSIONS,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
  MANAGED_CACHING_DISABLED_ID,
  MCP_PATH_PATTERNS,
  PROTECTED_PATH_PREFIXES,
} from "../../core/exclusions.mjs";
import { GATE_VERSION } from "../function/build.mjs";

const REGION = "us-east-1";
const GATE_TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cloudformation",
  "attach-gate.yaml",
);

// Defaults matching attach-gate.yaml. A stack's own outputs override them.
const DEFAULT_RECEPTIONIST_ORIGIN_ID = "norg-receptionist";
const DEFAULT_RECEPTIONIST_HOST = "edge-content.norg.ai";
const DEFAULT_ENVIRONMENT = "production";
// Our own viewer-request functions, by name: the gate itself and the 0.5.x
// cache-bucket classifier an old install may have left behind. Either is
// replaced on attach and removed on detach; anything else is someone else's.
const OUR_FUNCTION_ARN = /norg-edge-gate|norg-viewer-classifier/;
// The retired Lambda layout's router, by name: the attach-existing stack's
// EdgeRouterFunction physical name and the pre-stack manual installs.
const OUR_LAMBDA_ARN = /EdgeRouter|norg-router/;
const MIRROR_TOKEN_HEADER = "x-norg-mirror-token";
const SITE_ID_HEADER = "x-norg-site-id";

/**
 * Parse argv into an options object.
 *
 * @param {Array<string>} argv Raw arguments.
 * @returns {Object} Parsed options.
 */
function parseArgs(argv) {
  const options = { apply: false, detach: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    // Split on the FIRST "=" only: an --origin-headers value is itself a list
    // of name=value pairs.
    const eq = argv[i].indexOf("=");
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    const next = () => inline ?? argv[++i];
    if (flag === "--distribution-id") options.distributionId = next();
    else if (flag === "--stack") options.stack = next();
    else if (flag === "--site-key") options.siteKey = next();
    else if (flag === "--layout") assertGateLayout(next());
    else if (flag === "--origin-headers") options.originHeaders = next();
    else if (flag === "--receptionist-origin-id") options.receptionistOriginId = next();
    else if (flag === "--norg-environment") options.environment = next();
    else if (flag === "--alarm-topic-arn") options.alarmTopicArn = next();
    else if (flag === "--apply") options.apply = true;
    else if (flag === "--detach") options.detach = true;
    else if (flag === "--yes") options.yes = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

/**
 * Accept the old `--layout gate` so existing runbooks keep working, and refuse
 * anything else with a reason: an operator asking for Lambda must find out it
 * is gone rather than silently get something else.
 *
 * @param {string} layout The requested layout.
 * @returns {void}
 */
function assertGateLayout(layout) {
  if (layout === "gate") return;
  throw new Error(
    `--layout ${layout} is not available: gate is the only layout since 0.6.15. ` +
      "The Lambda layout was removed; drop --layout.",
  );
}

/**
 * Run an AWS CLI command and parse its JSON output.
 *
 * @param {Array<string>} args CLI arguments after `aws`.
 * @param {string} region Region to run it in.
 * @returns {Object} Parsed response.
 */
function aws(args, region = REGION) {
  const output = execFileSync("aws", [...args, "--region", region, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim() ? JSON.parse(output) : {};
}

/**
 * Read a stack's outputs.
 *
 * @param {string} stack Stack name.
 * @returns {Object} Outputs keyed by output name.
 */
function stackOutputs(stack) {
  const { Stacks } = aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  const outputs = {};
  for (const output of Stacks[0].Outputs || []) outputs[output.OutputKey] = output.OutputValue;
  return outputs;
}

/**
 * Parse a "name=value, name=value" list into header pairs.
 *
 * The shape of the stack's OriginCustomHeaders output and of --origin-headers.
 * A value may itself contain "=" (a token might); only the first one splits.
 *
 * @param {string} text The list; blank or undefined gives no pairs.
 * @returns {Array<{HeaderName: string, HeaderValue: string}>} In list order.
 */
function parseHeaderPairs(text) {
  return String(text || "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      if (!name.trim() || !rest.length) throw new Error(`bad header pair "${pair}": expected name=value`);
      return { HeaderName: name.trim(), HeaderValue: rest.join("=") };
    });
}

/**
 * Is this header one of NORG's? Header names are case-insensitive, and the
 * API writes them capitalised (X-Norg-Site-Id) where this CLI writes lowercase.
 *
 * @param {{HeaderName: string}} item A CustomHeaders item.
 * @returns {boolean} True for an x-norg-* header in any case.
 */
function isNorgHeader(item) {
  return String(item.HeaderName).toLowerCase().startsWith("x-norg-");
}

/**
 * The site id from --origin-headers, which the stack needs as a parameter.
 *
 * @param {Object} options Parsed CLI options.
 * @returns {string} The site id.
 */
function siteIdFrom(options) {
  const header = parseHeaderPairs(options.originHeaders).find(
    (item) => item.HeaderName.toLowerCase() === SITE_ID_HEADER,
  );
  if (!header) {
    throw new Error(
      `--origin-headers must include ${SITE_ID_HEADER}: the install is named after the site.\n` +
        'Pass --origin-headers "X-Norg-Site-Id=<id>,X-Norg-Mirror-Token=<token>" as NORG issued them.',
    );
  }
  return header.HeaderValue;
}

/**
 * The stack this install uses: the caller's, or one per distribution.
 *
 * @param {Object} options Parsed CLI options.
 * @returns {string} Stack name.
 */
function stackName(options) {
  return options.stack || `norg-gate-${options.distributionId}`;
}

/**
 * The `aws cloudformation deploy` arguments for the gate stack.
 *
 * Takes only non-secret values, and never --origin-headers wholesale: a token
 * handed to CloudFormation would sit in the stack's parameter list. GateVersion
 * is always passed, because deploy keeps a parameter's previous value when it
 * is left out, so an upgrade would otherwise keep reporting the old version.
 *
 * @param {Object} options Parsed CLI options.
 * @param {string} customerOriginId The default behaviour's origin.
 * @returns {Array<string>} CLI arguments after `aws`.
 */
function deployArgs(options, customerOriginId) {
  const overrides = [
    `SiteId=${siteIdFrom(options)}`,
    `DistributionId=${options.distributionId}`,
    `CustomerOriginId=${customerOriginId}`,
    `GateVersion=${GATE_VERSION}`,
  ];
  if (options.environment) overrides.push(`NorgEnvironment=${options.environment}`);
  if (options.receptionistOriginId) overrides.push(`ReceptionistOriginId=${options.receptionistOriginId}`);
  if (options.alarmTopicArn) overrides.push(`AlarmTopicArn=${options.alarmTopicArn}`);
  return [
    "cloudformation", "deploy",
    "--region", REGION,
    "--stack-name", stackName(options),
    "--template-file", GATE_TEMPLATE,
    "--no-fail-on-empty-changeset",
    "--parameter-overrides", ...overrides,
  ];
}

/**
 * What the stack's outputs will be, for a dry run that must create nothing.
 *
 * An existing stack's values are used, except the customer origin, because
 * --apply deploys the stack with the distribution's actual origin. A stack that
 * does not exist yet gets the values --apply would give it.
 *
 * @param {Object} options Parsed CLI options.
 * @param {string} customerOriginId The default behaviour's origin.
 * @param {function(string): Object} read Reads a stack's outputs.
 * @returns {Object} Outputs for attachGate.
 */
function plannedOutputs(options, customerOriginId, read = stackOutputs) {
  try {
    return { ...read(stackName(options)), CustomerOriginId: customerOriginId };
  } catch (error) {
    if (!/does not exist/i.test(`${error.message} ${error.stderr || ""}`)) throw error;
  }
  const siteId = siteIdFrom(options);
  return {
    FunctionArn: `(created on --apply: norg-edge-gate-${siteId})`,
    ReceptionistHost: DEFAULT_RECEPTIONIST_HOST,
    ReceptionistOriginId: options.receptionistOriginId || DEFAULT_RECEPTIONIST_ORIGIN_ID,
    CustomerOriginId: customerOriginId,
    OriginCustomHeaders: `${SITE_ID_HEADER}=${siteId}, x-norg-env=${options.environment || DEFAULT_ENVIRONMENT}`,
  };
}

/**
 * Refuse a carve-out that would shadow a path NORG serves itself.
 *
 * @param {string} pattern CloudFront path pattern.
 * @returns {void}
 */
function assertDoesNotShadowNorg(pattern) {
  if (pattern.startsWith("*")) return;
  const prefix = pattern.replace(/\*+$/, "");
  const clash = PROTECTED_PATH_PREFIXES.find(
    (p) => p.startsWith(prefix) || prefix.startsWith(p),
  );
  if (clash) {
    throw new Error(
      `carve-out "${pattern}" shadows NORG-served path "${clash}" — ` +
        "CloudFront would stop running the gate for it",
    );
  }
}

const ALL_METHODS = { Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
  CachedMethods: { Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"] } };

/**
 * The behaviours the gate adds: the dynamic paths, straight to the origin.
 *
 * Not cached (a 24 h TTL on /cart would serve one visitor's page to the next)
 * and every method allowed, because an origin group never fails a POST over and
 * these are the paths that take them. There are no MCP carve-outs, because the
 * gate treats MCP descriptors as NORG surfaces itself, and no static ones,
 * because the function returns a static path untouched for next to nothing.
 *
 * @param {string} targetOriginId Origin the default behaviour points at.
 * @returns {Array<Object>} Behaviour items in match order.
 */
function carveOutBehaviours(targetOriginId) {
  return DYNAMIC_ROUTE_EXCLUSIONS.map((pattern) => {
    assertDoesNotShadowNorg(pattern);
    return {
      PathPattern: pattern,
      TargetOriginId: targetOriginId,
      ViewerProtocolPolicy: "redirect-to-https",
      Compress: true,
      AllowedMethods: ALL_METHODS,
      CachePolicyId: MANAGED_CACHING_DISABLED_ID,
      OriginRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
    };
  });
}

// Every pattern an install of ours has ever written, including the retired
// Lambda layout's MCP and static carve-outs, so an upgrade or detach removes them.
const OUR_PATTERNS = new Set([
  ...MCP_PATH_PATTERNS,
  ...DYNAMIC_ROUTE_EXCLUSIONS,
  ...DEFAULT_ROUTE_EXCLUSIONS,
  ...CURATED_ASSET_SUFFIXES.map((suffix) => `*${suffix}`),
]);

/**
 * Is this behaviour one an install of ours wrote, not the customer's own?
 *
 * There is no tag field on a cache behaviour, so ours are recognised by shape.
 * Every one of ours points at the default behaviour's origin; a behaviour on a
 * different origin is never ours, which is the case that matters (their API
 * lives there). Beyond that: an MCP behaviour is ours if it runs our old router;
 * a dynamic one if it carries the managed CachingDisabled + AllViewer pair with
 * no Lambda; a static one if it has no functions at all. A customer's own
 * function-free `*.css` behaviour on the same origin is indistinguishable and
 * would be treated as ours — a known limit, stated in the README.
 *
 * @param {Object} behaviour A CacheBehaviors item.
 * @param {Object} config Distribution config (for the default origin).
 * @returns {boolean} True when an install of ours would have written this.
 */
function isOurs(behaviour, config) {
  if (!behaviour || !OUR_PATTERNS.has(behaviour.PathPattern)) return false;
  if (behaviour.TargetOriginId !== config.DefaultCacheBehavior.TargetOriginId) return false;

  const lambdas = behaviour.LambdaFunctionAssociations?.Items || [];
  if (MCP_PATH_PATTERNS.includes(behaviour.PathPattern)) {
    return lambdas.some((l) => OUR_LAMBDA_ARN.test(String(l.LambdaFunctionARN)));
  }
  if (lambdas.length || behaviour.FunctionAssociations?.Items?.length) return false;
  if (DYNAMIC_ROUTE_EXCLUSIONS.includes(behaviour.PathPattern)) {
    return (
      behaviour.CachePolicyId === MANAGED_CACHING_DISABLED_ID &&
      behaviour.OriginRequestPolicyId === MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID
    );
  }
  return true;
}

/**
 * Add the carve-outs, refusing rather than exceeding the customer's quota.
 *
 * Their behaviour budget is theirs; silently spending the last of it is the
 * kind of change that surfaces weeks later as "we cannot add a behaviour".
 *
 * A behaviour the customer already has for one of our patterns is THEIRS and
 * stays exactly as it is. This matters most for /api/*, which very often points
 * at a different origin: replacing it would repoint their API at their web server.
 *
 * @param {Object} config Distribution config, mutated in place.
 * @returns {Array<string>} Summary lines.
 */
function addCarveOuts(config) {
  const existing = config.CacheBehaviors?.Items || [];
  const wanted = carveOutBehaviours(config.DefaultCacheBehavior.TargetOriginId);
  const theirs = existing.filter((b) => !isOurs(b, config));
  const theirPatterns = new Set(theirs.map((b) => b.PathPattern));
  const ours = wanted.filter((b) => !theirPatterns.has(b.PathPattern));
  const skipped = wanted.length - ours.length;

  const total = theirs.length + ours.length + 1; // +1 for the default behaviour
  if (total > CLOUDFRONT_BEHAVIOUR_QUOTA) {
    throw new Error(
      `this distribution has ${theirs.length} cache behaviours; adding ${ours.length} ` +
        `carve-outs would reach ${total}, over CloudFront's limit of ` +
        `${CLOUDFRONT_BEHAVIOUR_QUOTA}.\nRequest a quota increase, or remove some ` +
        "behaviours first.",
    );
  }

  // Ours go FIRST: CloudFront matches in order and the first match wins, so a
  // broad customer behaviour listed above them would swallow the carve-outs.
  const items = [...ours, ...theirs];
  config.CacheBehaviors = { Quantity: items.length, Items: items };
  return [
    `behaviours      +${ours.length} (dynamic no-cache, straight to your origin on every method; no MCP or static carve-outs)` +
      (skipped ? `, ${skipped} skipped because you already have them` : "") +
      ` — ${theirs.length} of yours kept, ${total}/${CLOUDFRONT_BEHAVIOUR_QUOTA} used`,
  ];
}

/**
 * Put the gate function on the default behaviour's viewer-request slot.
 *
 * CloudFront allows ONE function per event type per behaviour, so an existing
 * viewer-request function is either ours (replaced: that is how an upgrade
 * lands) or someone else's (refused: replacing it is how an install breaks a
 * site in a way nobody can attribute). viewer-response is never touched.
 *
 * @param {Object} behaviour The default cache behaviour, mutated in place.
 * @param {string} functionArn The gate's ARN from the stack.
 * @returns {string} Summary line.
 */
function associateGate(behaviour, functionArn) {
  const items = behaviour.FunctionAssociations?.Items || [];
  const viewerRequest = items.find((item) => item.EventType === "viewer-request");
  if (viewerRequest && !OUR_FUNCTION_ARN.test(String(viewerRequest.FunctionARN))) {
    throw new Error(
      "this distribution already has a viewer-request CloudFront Function " +
        `(${viewerRequest.FunctionARN}).\n` +
        "CloudFront allows one per behaviour, and replacing it would silently take " +
        "over someone else's routing. Remove it first, or attach to a staging distribution.",
    );
  }
  const kept = items.filter((item) => item.EventType !== "viewer-request");
  const next = [...kept, { EventType: "viewer-request", FunctionARN: functionArn }];
  behaviour.FunctionAssociations = { Quantity: next.length, Items: next };
  const replaced = viewerRequest ? ` (replaces ${viewerRequest.FunctionARN})` : "";
  return `viewer-request  -> ${functionArn} (CloudFront Function)${replaced}`;
}

/**
 * Take the retired Lambda layout's router off the default behaviour.
 *
 * Ours goes, because the gate replaces it. Someone else's origin-request Lambda
 * is refused: it would run under the gate's origin group, and nobody could
 * attribute what happened next.
 *
 * @param {Object} behaviour The default cache behaviour, mutated in place.
 * @returns {?string} Summary line, or null when there was nothing to remove.
 */
function removeOurLambda(behaviour) {
  const items = behaviour.LambdaFunctionAssociations?.Items || [];
  const foreign = items.find(
    (item) => item.EventType === "origin-request" && !OUR_LAMBDA_ARN.test(String(item.LambdaFunctionARN)),
  );
  if (foreign) {
    throw new Error(
      "this distribution already has an origin-request Lambda@Edge function " +
        `(${foreign.LambdaFunctionARN}).\n` +
        "The gate rewrites the request before it; replacing or running under someone " +
        "else's routing is refused. Remove it first.",
    );
  }
  return dropOurLambda(behaviour);
}

/**
 * Remove our Lambda association from a behaviour, keeping any other.
 *
 * @param {Object} behaviour A cache behaviour, mutated in place.
 * @returns {?string} Summary line, or null when there was nothing to remove.
 */
function dropOurLambda(behaviour) {
  const items = behaviour.LambdaFunctionAssociations?.Items || [];
  const kept = items.filter((item) => !OUR_LAMBDA_ARN.test(String(item.LambdaFunctionARN)));
  const removed = items.length - kept.length;
  behaviour.LambdaFunctionAssociations = { Quantity: kept.length, Items: kept };
  return removed ? `lambda          -> removed ${removed} NORG Lambda@Edge association(s) left by the Lambda layout` : null;
}

/**
 * Remove x-norg-* headers from an origin, keeping the customer's own.
 *
 * @param {Object} origin An Origin item, mutated in place.
 * @returns {number} How many headers were removed.
 */
function stripNorgHeaders(origin) {
  const items = origin.CustomHeaders?.Items || [];
  const kept = items.filter((item) => !isNorgHeader(item));
  origin.CustomHeaders = { Quantity: kept.length, Items: kept };
  return items.length - kept.length;
}

/**
 * The receptionist origin: NORG's HTTPS endpoint with its install headers.
 *
 * The headers are what authenticate this distribution to the receptionist:
 * whatever the stack published (the site id and environment) plus whatever the
 * caller passed in --origin-headers, which MUST include the mirror token. The
 * token is a secret and is not a stack parameter; an attach without it would
 * install a receptionist that 404s every request — the site would keep working
 * and the mirror would silently never serve, which is the failure this whole
 * repository is built to avoid.
 *
 * @param {Object} outputs Stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {Object} A CloudFront Origin item.
 */
function receptionistOrigin(outputs, options) {
  const byName = new Map();
  for (const item of [...parseHeaderPairs(outputs.OriginCustomHeaders), ...parseHeaderPairs(options.originHeaders)]) {
    byName.set(item.HeaderName.toLowerCase(), item); // the caller's value wins on a clash
  }
  if (!byName.has(MIRROR_TOKEN_HEADER)) {
    throw new Error(
      `--origin-headers must include ${MIRROR_TOKEN_HEADER}: without it the receptionist ` +
        "answers 404 to everything and the install silently serves nothing.\n" +
        'Pass --origin-headers "X-Norg-Site-Id=<id>,X-Norg-Mirror-Token=<token>" as NORG issued them.',
    );
  }
  const items = [...byName.values()];
  return {
    Id: outputs.ReceptionistOriginId || DEFAULT_RECEPTIONIST_ORIGIN_ID,
    DomainName: outputs.ReceptionistHost,
    OriginPath: "",
    CustomHeaders: { Quantity: items.length, Items: items },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
      // CloudFront's defaults. The receptionist answers a rendered page from
      // storage; a render it has to start is answered 404 and the viewer fails
      // over to the customer's origin, so a long wait buys nothing here.
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
  };
}

/**
 * Refuse stack outputs the gate cannot work with.
 *
 * The function's origin group names the customer origin by Id. If the stack was
 * told a different Id from the one the default behaviour uses, every agent
 * request would fail at the edge (503) while humans saw nothing wrong.
 *
 * @param {Object} behaviour The default cache behaviour.
 * @param {Object} outputs Stack outputs.
 * @returns {void}
 */
function assertUsableOutputs(behaviour, outputs) {
  for (const key of ["FunctionArn", "ReceptionistHost", "CustomerOriginId"]) {
    if (!outputs[key]) throw new Error(`stack output ${key} is missing — is --stack an attach-gate.yaml stack?`);
  }
  if (behaviour.TargetOriginId !== outputs.CustomerOriginId) {
    throw new Error(
      `the stack's CustomerOriginId is "${outputs.CustomerOriginId}" but the default ` +
        `behaviour points at "${behaviour.TargetOriginId}". The function would fail over ` +
        "to an origin that does not exist. Update the stack parameter to match.",
    );
  }
}

/**
 * Point the default behaviour's origin request policy at the one the gate needs.
 *
 * The gate's headers (x-norg-gate, x-norg-ua, x-norg-viewer-ip, the version) are
 * viewer headers by the time the origin request is built; this managed policy
 * forwards all of them, every query string and every cookie, and keeps the
 * origin's own Host — the receptionist's is set by the function.
 *
 * @param {Object} behaviour The default cache behaviour, mutated in place.
 * @returns {string} Summary line.
 */
function setOriginRequestPolicy(behaviour) {
  if (behaviour.OriginRequestPolicyId === MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID) {
    return "origin request  AllViewerExceptHostHeader (already)";
  }
  const previous = behaviour.OriginRequestPolicyId || "(none)";
  behaviour.OriginRequestPolicyId = MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID;
  return `origin request  ${previous} -> AllViewerExceptHostHeader ` +
    "(the gate's headers and the full query string reach the receptionist)";
}

/**
 * Put the receptionist on the distribution and clear NORG headers off the rest.
 *
 * Headers left on the customer's origin by the retired Lambda layout must go:
 * that router stripped them from each request, and without it they would reach
 * the customer's server. Their own headers on that origin are not touched.
 *
 * @param {Object} config Distribution config, mutated in place.
 * @param {Object} receptionist The receptionist Origin item.
 * @returns {Array<string>} Summary lines.
 */
function installReceptionist(config, receptionist) {
  const all = config.Origins?.Items || [];
  const origins = all.filter((item) => item.Id !== receptionist.Id);
  const stripped = origins.reduce((count, origin) => count + stripNorgHeaders(origin), 0);
  const replaced = origins.length !== all.length;
  origins.push(receptionist);
  config.Origins = { Quantity: origins.length, Items: origins };
  const lines = [
    `origin          ${replaced ? "~" : "+"}${receptionist.Id} (${receptionist.DomainName}, https-only, ` +
      `${receptionist.CustomHeaders.Quantity} custom headers incl. the mirror token; nothing is written on your own origin)`,
  ];
  if (stripped) lines.push(`origin headers  -> removed ${stripped} x-norg-* header(s) left on your origin by the Lambda layout`);
  return lines;
}

/**
 * Apply the gate to a distribution config, in place.
 *
 * @param {Object} config Distribution config.
 * @param {Object} outputs attach-gate stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function attachGate(config, outputs, options) {
  const behaviour = config.DefaultCacheBehavior;
  assertUsableOutputs(behaviour, outputs);
  const receptionist = receptionistOrigin(outputs, options);
  if (receptionist.Id === behaviour.TargetOriginId) {
    throw new Error(`the receptionist origin Id "${receptionist.Id}" is your default origin's Id; set ReceptionistOriginId on the stack`);
  }

  const lambdaLine = removeOurLambda(behaviour);
  return [
    ...(lambdaLine ? [lambdaLine] : []),
    associateGate(behaviour, outputs.FunctionArn),
    setOriginRequestPolicy(behaviour),
    `cache policy    ${behaviour.CachePolicyId || "(legacy ForwardedValues)"} left as it is — humans never reach NORG code, so your HTML caching is unchanged`,
    ...installReceptionist(config, receptionist),
    ...addCarveOuts(config),
  ];
}

/**
 * Remove the gate from a distribution config, in place.
 *
 * Reverses attachGate and restores nothing else: the origin request policy
 * stays as attach left it (say so), the cache policy was never touched. Also
 * clears a retired Lambda-layout install, so there is one way to uninstall.
 *
 * @param {Object} config Distribution config.
 * @param {Object} options Parsed CLI options (for the receptionist origin Id).
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function detachGate(config, options) {
  const behaviour = config.DefaultCacheBehavior;
  const receptionistId = options.receptionistOriginId || DEFAULT_RECEPTIONIST_ORIGIN_ID;
  if (receptionistId === behaviour.TargetOriginId) {
    throw new Error(`"${receptionistId}" is your default origin, not the receptionist; pass --receptionist-origin-id`);
  }

  const functions = (behaviour.FunctionAssociations?.Items || []).filter(
    (item) => !(item.EventType === "viewer-request" && OUR_FUNCTION_ARN.test(String(item.FunctionARN))),
  );
  behaviour.FunctionAssociations = { Quantity: functions.length, Items: functions };
  const lambdaLine = dropOurLambda(behaviour);

  const keptBehaviours = (config.CacheBehaviors?.Items || []).filter((b) => !isOurs(b, config));
  config.CacheBehaviors = { Quantity: keptBehaviours.length, Items: keptBehaviours };

  const origins = (config.Origins?.Items || []).filter((item) => item.Id !== receptionistId);
  origins.forEach(stripNorgHeaders);
  config.Origins = { Quantity: origins.length, Items: origins };

  return [
    "viewer-request  -> NORG gate function removed (your other functions kept)",
    ...(lambdaLine ? [lambdaLine] : []),
    `origin          -> ${receptionistId} removed; x-norg-* headers removed everywhere`,
    "carve-outs      -> removed (yours kept)",
    "origin request  AllViewerExceptHostHeader left in place (set your own back if you had one)",
    "cache policy    never changed by the gate",
  ];
}

/**
 * Ask the operator to confirm before touching a live distribution.
 *
 * @param {Object} options Parsed CLI options.
 * @returns {Promise<boolean>} True when --yes was passed or the operator typed yes.
 */
async function confirm(options) {
  if (options.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nApply this to ${options.distributionId}? (yes/no) `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

/**
 * Write a distribution config back, guarded by the ETag it was read with.
 *
 * The config goes via a file because it exceeds the argv limit. It holds the
 * mirror token, so the directory goes away either way. --if-match makes a
 * concurrent change fail loudly rather than being silently overwritten.
 *
 * @param {string} distributionId Distribution being changed.
 * @param {Object} config The new config.
 * @param {string} etag ETag from the read.
 * @returns {void}
 */
function writeDistribution(distributionId, config, etag) {
  const dir = mkdtempSync(join(tmpdir(), "norg-edge-"));
  const file = join(dir, "distribution-config.json");
  try {
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    aws([
      "cloudfront", "update-distribution",
      "--id", distributionId,
      "--if-match", etag,
      "--distribution-config", `file://${file}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Warn about the site key flag older runbooks pass; it is accepted and ignored.
 *
 * @param {Object} options Parsed CLI options, mutated to drop the key.
 * @returns {void}
 */
function warnAboutSiteKey(options) {
  if (options.siteKey || process.env.NORG_SITE_KEY) {
    console.error("note: the gate does not use a site key. It authenticates with the mirror token in --origin-headers.");
  }
  delete options.siteKey;
}

/**
 * Print what is about to change.
 *
 * @param {Object} options Parsed CLI options.
 * @param {Object} config Distribution config.
 * @param {Array<string>} changes Summary lines.
 * @returns {void}
 */
function printPlan(options, config, changes) {
  console.log(`\nDistribution ${options.distributionId} (${config.Comment || "no comment"})`);
  if (!options.detach) console.log(`Stack ${stackName(options)} (created or updated on --apply)`);
  console.log("Changes:\n");
  for (const change of changes) console.log(`  ${change}`);
}

/**
 * Plan the change, and on --apply confirm and make it.
 *
 * @param {Object} options Parsed CLI options.
 * @returns {Promise<void>} Resolves when the command completes.
 */
async function run(options) {
  const { DistributionConfig: config, ETag: etag } = aws(["cloudfront", "get-distribution-config", "--id", options.distributionId]);
  const customerOriginId = config.DefaultCacheBehavior.TargetOriginId;
  const plan = structuredClone(config);
  const changes = options.detach
    ? detachGate(plan, options)
    : attachGate(plan, plannedOutputs(options, customerOriginId), options);
  printPlan(options, config, changes);

  if (!options.apply) {
    console.log("\nDry run. Nothing was created or changed. Re-run with --apply to make these changes.");
    return;
  }
  console.log("\nA distribution update takes 5-15 minutes to propagate. So does reverting.");
  if (!(await confirm(options))) {
    console.log("Aborted. Nothing was changed.");
    return;
  }

  if (options.detach) {
    writeDistribution(options.distributionId, plan, etag);
    console.log(`\nDetached. Once the distribution shows Deployed, delete the function's stack:\n  aws cloudformation delete-stack --region ${REGION} --stack-name ${stackName(options)}`);
    return;
  }
  console.log(`\nDeploying stack ${stackName(options)}...`);
  execFileSync("aws", deployArgs(options, customerOriginId), { stdio: "inherit" });
  attachGate(config, stackOutputs(stackName(options)), options);
  writeDistribution(options.distributionId, config, etag);
  console.log(`\nApplied. Watch rollout with:\n  aws cloudfront get-distribution --id ${options.distributionId} --query 'Distribution.Status'`);
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when the command completes.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  warnAboutSiteKey(options);
  if (!options.distributionId) throw new Error("--distribution-id is required");
  await run(options);
}

// Only run when invoked directly, so the pure functions above can be tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  addCarveOuts,
  attachGate,
  carveOutBehaviours,
  deployArgs,
  detachGate,
  isOurs,
  parseArgs,
  parseHeaderPairs,
  plannedOutputs,
  stackName,
};
