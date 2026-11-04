/**
 * Guards on the CloudFormation templates.
 *
 * @description Pins the supply-chain properties of the install template.
 *
 * This template installs code into a CUSTOMER's AWS account and attaches it to
 * their whole site. The checks here are about that, not about YAML syntax.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cfnDir = join(dirname(fileURLToPath(import.meta.url)), "..", "cloudformation");

/**
 * Extract one parameter's YAML block from a template.
 *
 * @param {string} template Template source.
 * @param {string} name Parameter name.
 * @returns {string} The block's body, excluding the name line.
 */
function parameterBlock(template, name) {
  const match = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(template);
  assert.ok(match, `parameter ${name} not found`);
  return match[1];
}


const GATE_TEMPLATE = "attach-gate.yaml";
const GATE_PARAMETERS = [
  "SiteId", "DistributionId", "CustomerOriginId", "ReceptionistHost",
  "ReceptionistOriginId", "NorgEnvironment", "GateVersion", "AlarmTopicArn",
];
const GATE_OUTPUTS = [
  "FunctionArn", "FunctionName", "ReceptionistHost", "ReceptionistOriginId",
  "CustomerOriginId", "GateVersion", "OriginCustomHeaders",
];
// Placeholder -> the parameter Fn::Sub fills it from. Mirrors aws/build.mjs.
const GATE_SUBSTITUTIONS = {
  __RECEPTIONIST_HOST__: "ReceptionistHost",
  __RECEPTIONIST_ORIGIN_ID__: "ReceptionistOriginId",
  __CUSTOMER_ORIGIN_ID__: "CustomerOriginId",
  __GATE_VERSION__: "GateVersion",
};

/**
 * The FunctionCode block scalar's lines, de-indented.
 *
 * @param {string} template Template text.
 * @returns {{lines: Array<string>, code: string}} The embedded code.
 */
function embeddedFunctionCode(template) {
  const block = /      FunctionCode: !Sub \|\n([\s\S]*?)\n      # END GENERATED FUNCTION CODE/.exec(template);
  assert.ok(block, "no generated function-code block");
  const lines = block[1].split("\n");
  for (const line of lines) assert.match(line, /^ {8}\S/, `block scalar line not indented eight spaces: ${JSON.stringify(line.slice(0, 40))}`);
  return { lines, code: lines.map((l) => l.slice(8)).join("\n") };
}

test(`${GATE_TEMPLATE}: has exactly the documented parameters and outputs, with the install values required`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const declared = [...template.matchAll(/^  ([A-Za-z]+):\n(?=    Type: String)/gm)].map((m) => m[1]);
  assert.deepEqual(declared, GATE_PARAMETERS);
  for (const required of ["SiteId", "DistributionId", "CustomerOriginId"]) {
    assert.equal(/^\s+Default:/m.test(parameterBlock(template, required)), false, `${required} must be supplied, never defaulted`);
  }
  const outputs = /^Outputs:\n([\s\S]*)$/m.exec(template)[1];
  assert.deepEqual([...outputs.matchAll(/^  ([A-Za-z]+):\n/gm)].map((m) => m[1]), GATE_OUTPUTS);
});

test(`${GATE_TEMPLATE}: no Lambda, IAM, secret, schedule or S3 artifact — one function and two alarms`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const types = [...template.matchAll(/^    Type: (AWS::[A-Za-z:]+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(types, ["AWS::CloudFront::Function", "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm"]);
  for (const marker of ["AWS::Lambda", "AWS::IAM", "AWS::SecretsManager", "AWS::Events", "ArtifactBucket", "SiteKey", "LambdaFunctionAssociations"]) {
    assert.equal(template.includes(marker), false, `${GATE_TEMPLATE} carries ${marker}`);
  }
});

test(`${GATE_TEMPLATE}: the function is published on every change and runs on the 2.0 runtime`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const fn = /^  EdgeGateFunction:\n((?:    .*\n|\n)*)/m.exec(template);
  assert.ok(fn, "no EdgeGateFunction resource");
  assert.match(fn[1], /AutoPublish: true/, "an unpublished edit leaves the edge on the old code with no error");
  assert.match(fn[1], /Runtime: cloudfront-js-2\.0/, "the origin-modification helpers need runtime 2.0");
  assert.match(fn[1], /Name: !Sub "norg-edge-gate-\$\{SiteId\}"/);
});

test(`${GATE_TEMPLATE}: the inlined code IS aws/src/edge-gate.js with each placeholder swapped for its parameter`, async () => {
  const { GATE_PLACEHOLDERS } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const artifact = readFileSync(join(cfnDir, "..", "src", "edge-gate.js"), "utf8").trimEnd();
  const { code } = embeddedFunctionCode(template);

  assert.deepEqual(Object.keys(GATE_SUBSTITUTIONS).sort(), [...GATE_PLACEHOLDERS].sort(), "every placeholder has a parameter");
  let expected = artifact;
  for (const [placeholder, parameter] of Object.entries(GATE_SUBSTITUTIONS)) expected = expected.replaceAll(placeholder, `\${${parameter}}`);
  assert.equal(code, expected, "run: node aws/build.mjs");
  assert.ok(code.startsWith("import cf from 'cloudfront';"));
  // Everything Fn::Sub will touch is one of our five parameters: no stray
  // "${" from the minifier, no "${!" literal escape, no pseudo-parameter.
  const substituted = [...code.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(substituted)].sort(), [...new Set(Object.values(GATE_SUBSTITUTIONS))].sort());
  assert.equal(/__[A-Z_]+__/.test(code), false, "an unsubstituted placeholder would deploy as a literal");
  assert.equal(/catch\s*\{/.test(code), false, "CloudFront's runtime rejects an optional catch binding");
});

test(`${GATE_TEMPLATE}: every parameter inlined into the code cannot break out of its string literal`, () => {
  // The values land inside JavaScript double-quoted strings. A quote mark, a
  // backslash or a newline in a value would end the literal and run as code.
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const parameter of new Set(Object.values(GATE_SUBSTITUTIONS))) {
    const block = parameterBlock(template, parameter);
    const pattern = /AllowedPattern: (\S+)/.exec(block) || /AllowedValues: \[([^\]]+)\]/.exec(block);
    assert.ok(pattern, `${parameter} must constrain its value`);
    if (block.includes("AllowedPattern")) {
      const re = new RegExp(pattern[1]);
      for (const hostile of ['a"b', "a\\b", "a\nb", "a${b}", "a`b"]) {
        assert.equal(re.test(hostile), false, `${parameter} accepts ${JSON.stringify(hostile)}`);
      }
    }
  }
});

test(`${GATE_TEMPLATE}: the substituted function stays under CloudFront's 10 KB limit at the longest allowed values`, async () => {
  const { GATE_SIZE_LIMIT } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const { code } = embeddedFunctionCode(template);
  const longest = {
    ReceptionistHost: `${"a".repeat(63)}.`.repeat(3) + "a".repeat(61), // 253, the DNS maximum
    ReceptionistOriginId: "o".repeat(128),
    CustomerOriginId: "c".repeat(128),
    GateVersion: "v".repeat(32),
  };
  const worst = code.replace(/\$\{([^}]*)\}/g, (_, name) => longest[name]);
  assert.ok(Buffer.byteLength(worst) <= 10_240, `substituted code is ${Buffer.byteLength(worst)} bytes, over CloudFront's limit`);
  assert.ok(Buffer.byteLength(worst) <= GATE_SIZE_LIMIT, `substituted code is ${Buffer.byteLength(worst)} bytes, over the ${GATE_SIZE_LIMIT}-byte gate`);
});

test(`${GATE_TEMPLATE}: the GateVersion default is the version the build stamps`, async () => {
  const { GATE_VERSION } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  assert.match(parameterBlock(template, "GateVersion"), new RegExp(`Default: ${GATE_VERSION.replaceAll(".", "\\.")}\\n`));
});

test(`${GATE_TEMPLATE}: both function-error metrics have alarms scoped to the distribution`, () => {
  // CloudFront publishes function metrics per distribution, in us-east-1,
  // under Region=Global. Without all three dimensions the alarm watches nothing.
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const [name, metric] of [["GateExecutionErrorsAlarm", "FunctionExecutionErrors"], ["GateValidationErrorsAlarm", "FunctionValidationErrors"]]) {
    const block = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(template);
    assert.ok(block, `no ${name}`);
    assert.match(block[1], /Namespace: AWS\/CloudFront/);
    assert.match(block[1], new RegExp(`MetricName: ${metric}`));
    assert.match(block[1], /Name: DistributionId\n\s+Value: !Ref DistributionId/);
    assert.match(block[1], /Name: FunctionName\n\s+Value: !Sub "norg-edge-gate-\$\{SiteId\}"/, "the dimension must name the function exactly as the resource does");
    assert.match(block[1], /Name: Region\n\s+Value: Global/);
    assert.match(block[1], /TreatMissingData: notBreaching/);
  }
});

test(`${GATE_TEMPLATE}: the mirror token is not a parameter, not an output, and the Description says so`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  assert.equal(/^  MirrorToken:/m.test(template), false);
  const outputs = /^Outputs:\n([\s\S]*)$/m.exec(template)[1];
  assert.equal(/mirror-token=/i.test(outputs), false, "OriginCustomHeaders must not carry a token slot");
  const description = /^Description: >-\n((?:  .*\n)+)/m.exec(template);
  assert.ok(description, "no Description");
  assert.match(description[1], /X-Norg-Mirror-Token/);
  assert.match(description[1], /X-Norg-Site-Id/);
  assert.ok(description[1].replace(/\s+/g, " ").length <= 1024, "CloudFormation caps Description at 1024 characters");
});

test(`${GATE_TEMPLATE}: no NORG-internal secret name, no credential-shaped literal, under the template-body limit`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const forbidden of ["CRAWLER_EVENT_SECRET", "WORKER_AUTH_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "INTERNAL_API_KEY", "EDGE_BUCKET"]) {
    assert.equal(template.includes(forbidden), false, `${GATE_TEMPLATE} leaks ${forbidden}`);
  }
  assert.equal(/nek_live_|nmt_/.test(template), false);
  assert.equal(/AKIA[0-9A-Z]{16}/.test(template), false);
  assert.ok(Buffer.byteLength(template) <= 51_200);
});

test(`${GATE_TEMPLATE}: the artifact is digested in full`, async () => {
  const { createHash } = await import("node:crypto");
  const srcDir = join(cfnDir, "..", "src");
  const digests = JSON.parse(readFileSync(join(srcDir, "DIGESTS.json"), "utf8"));
  const { GATE_VERSION } = await import("../function/build.mjs");
  assert.equal(digests.gate_version, GATE_VERSION);
  for (const name of ["edge-gate.js"]) {
    const actual = createHash("sha256").update(readFileSync(join(srcDir, name))).digest("hex");
    assert.equal(digests.files[name], actual, `${name} digest is stale — run: node aws/build.mjs`);
  }
});

test("the release version is not in the digests: it lives on the GitHub release tag", () => {
  const digests = JSON.parse(readFileSync(join(cfnDir, "..", "src", "DIGESTS.json"), "utf8"));
  assert.equal("version" in digests, false);
});
