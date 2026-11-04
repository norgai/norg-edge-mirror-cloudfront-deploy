/**
 * Build the CloudFront gate into the deployable files.
 *
 * Usage: node aws/build.mjs   (or: npm run build:aws)
 *
 * Writes aws/src/edge-gate.js, inlines it into
 * aws/cloudformation/attach-gate.yaml, and digests it in aws/src/DIGESTS.json.
 * All three are COMMITTED: the attach CLI deploys exactly those files and NORG's
 * backend pins them by SHA-256. CI rebuilds and fails on any diff, so a source
 * edit can never ship without its artifact.
 *
 * esbuild is invoked through npx with a PINNED version rather than as a
 * package.json dependency, so the build is zero-install and deterministic.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_PLACEHOLDERS, GATE_VERSION, buildGate } from "./function/build.mjs";

// Names that must NEVER appear in an artifact shipping into a customer's AWS
// account. Mirrors the Cloudflare build's list and content-craft's deploy-time
// guard, which refuses to upload a leaking artifact.
const FORBIDDEN_NAMES = [
  "CRAWLER_EVENT_SECRET",
  "WORKER_AUTH_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "INTERNAL_API_KEY",
  "EDGE_BUCKET",
];

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src");
const templatePath = join(here, "cloudformation", "attach-gate.yaml");

/**
 * Refuse to publish an artifact carrying a NORG-internal secret name.
 *
 * @param {string} name Artifact name, for the message.
 * @param {string} contents Artifact contents.
 * @returns {void}
 */
function assertNoForbiddenNames(name, contents) {
  for (const forbidden of FORBIDDEN_NAMES) {
    if (contents.includes(forbidden)) {
      throw new Error(
        `refusing to publish: ${name} contains forbidden name "${forbidden}" — ` +
          "this must never reach a customer account",
      );
    }
  }
}

/**
 * The CloudFormation parameter each gate placeholder is filled from.
 *
 * attach-gate.yaml inlines the function through Fn::Sub, so a placeholder
 * becomes "${Parameter}" and CloudFormation fills it at create time. Every one
 * of these parameters has an AllowedPattern excluding quotes and backslashes:
 * the value lands inside a JavaScript string literal and must not escape it.
 * SiteId is deliberately absent: the function no longer carries the site in
 * the path (the receptionist reads it from its origin's X-Norg-Site-Id header).
 */
const GATE_PLACEHOLDER_PARAMETERS = {
  __RECEPTIONIST_HOST__: "ReceptionistHost",
  __RECEPTIONIST_ORIGIN_ID__: "ReceptionistOriginId",
  __CUSTOMER_ORIGIN_ID__: "CustomerOriginId",
  __GATE_VERSION__: "GateVersion",
};

/**
 * Inline the built gate into attach-gate.yaml's FunctionCode block.
 *
 * The code is a YAML literal block scalar under `!Sub |`, so every line is
 * indented eight spaces and the markers sit OUTSIDE the scalar (a marker
 * inside it would ship as function code). The GateVersion parameter's default
 * is rewritten in the same pass so the two cannot drift.
 *
 * @param {string} gateCode The built artifact, placeholders intact.
 * @returns {void}
 */
function embedGateFunction(gateCode) {
  for (const placeholder of GATE_PLACEHOLDERS) {
    if (!(placeholder in GATE_PLACEHOLDER_PARAMETERS)) {
      throw new Error(`gate placeholder ${placeholder} has no template parameter to fill it`);
    }
  }
  let code = gateCode;
  for (const [placeholder, parameter] of Object.entries(GATE_PLACEHOLDER_PARAMETERS)) {
    code = code.replaceAll(placeholder, `\${${parameter}}`);
  }
  const indented = code.trimEnd().split("\n").map((line) => `        ${line}`).join("\n");

  const template = readFileSync(templatePath, "utf8");
  let updated = template.replace(
    /(      FunctionCode: !Sub \|\n)[\s\S]*?(\n      # END GENERATED FUNCTION CODE)/,
    `$1${indented}$2`,
  );
  if (!updated.includes(indented)) throw new Error("failed to embed the gate function into attach-gate.yaml");
  updated = updated.replace(
    /(  GateVersion:\n(?:    .*\n)*?    Default: )\S+/,
    `$1${GATE_VERSION}`,
  );
  if (!updated.includes(`    Default: ${GATE_VERSION}\n`)) throw new Error("failed to set the GateVersion default");
  writeFileSync(templatePath, updated);
}

// CloudFormation refuses a template body over 51,200 bytes. Fail here, at build
// time, rather than at a customer's first `aws cloudformation deploy`.
const CFN_TEMPLATE_BODY_MAX_BYTES = 51_200;

/**
 * Refuse a template CloudFormation would refuse.
 *
 * @returns {number} The template's size in bytes.
 */
function assertTemplateFits() {
  const bytes = statSync(templatePath).size;
  if (bytes > CFN_TEMPLATE_BODY_MAX_BYTES) {
    throw new Error(
      `refusing to publish: attach-gate.yaml is ${bytes} bytes, over CloudFormation's ` +
        `${CFN_TEMPLATE_BODY_MAX_BYTES}-byte template-body limit`,
    );
  }
  return bytes;
}

/**
 * Digest the deployable artifact in full, for operators and NORG's pin to check.
 *
 * @returns {void}
 */
function writeDigests() {
  const digests = {
    gate_version: GATE_VERSION,
    algorithm: "sha256",
    files: {
      "edge-gate.js": createHash("sha256").update(readFileSync(join(srcDir, "edge-gate.js"))).digest("hex"),
    },
  };
  writeFileSync(join(srcDir, "DIGESTS.json"), `${JSON.stringify(digests, null, 2)}\n`);
}

mkdirSync(srcDir, { recursive: true });
const gate = buildGate();
assertNoForbiddenNames("edge-gate.js", gate.body);
embedGateFunction(gate.body);
const templateBytes = assertTemplateFits();
writeDigests();

console.log("built aws/src/ (the release version lives on the GitHub release tag)");
console.log(`  edge-gate.js      ${gate.size} bytes (gate version ${GATE_VERSION})`);
console.log(`  attach-gate.yaml  ${templateBytes} bytes (limit ${CFN_TEMPLATE_BODY_MAX_BYTES})`);
console.log("  DIGESTS.json      full sha256");
