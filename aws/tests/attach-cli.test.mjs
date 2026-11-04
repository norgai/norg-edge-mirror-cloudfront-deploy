/**
 * The attach CLI run for real, against a stand-in `aws` on PATH.
 *
 * @description Pins the one-command install: what it calls, and in what order.
 *
 * The unit tests cover each decision. This covers the wiring between them, which
 * is where a dry run that deploys something, or an attach that runs before its
 * stack exists, would hide. The stand-in records every call and copies the config
 * handed to update-distribution, since the CLI deletes that file straight after.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "install", "attach.mjs");
const SITE_ID = "11111111-1111-1111-1111-111111111111";
const HEADERS = `X-Norg-Site-Id=${SITE_ID},X-Norg-Mirror-Token=nmt_secret_token`;

const DISTRIBUTION = {
  ETag: "ETAG1",
  DistributionConfig: {
    Comment: "customer site",
    Origins: { Quantity: 1, Items: [{ Id: "web", DomainName: "origin.example.com", CustomHeaders: { Quantity: 0, Items: [] } }] },
    DefaultCacheBehavior: {
      TargetOriginId: "web",
      CachePolicyId: "their-policy",
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
    },
  },
};

// Stands in for the AWS CLI. The stack "exists" only once deploy has run, or
// from the start if the test wrote the stack-exists file.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_AWS_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const verb = args[0] + " " + args[1];
const stackFile = path.join(dir, "stack-exists");
if (verb === "cloudfront get-distribution-config") {
  process.stdout.write(fs.readFileSync(path.join(dir, "distribution.json")));
} else if (verb === "cloudformation deploy") {
  fs.writeFileSync(stackFile, "1");
} else if (verb === "cloudformation describe-stacks") {
  if (!fs.existsSync(stackFile)) {
    process.stderr.write("An error occurred (ValidationError): Stack with id x does not exist\\n");
    process.exit(254);
  }
  const outputs = {
    FunctionArn: "arn:aws:cloudfront::111:function/norg-edge-gate-site",
    ReceptionistHost: "edge-content.norg.ai",
    ReceptionistOriginId: "norg-receptionist",
    CustomerOriginId: "web",
    OriginCustomHeaders: "x-norg-site-id=site, x-norg-env=production",
  };
  const Outputs = Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
  process.stdout.write(JSON.stringify({ Stacks: [{ Outputs }] }));
} else if (verb === "cloudfront update-distribution") {
  const file = args[args.indexOf("--distribution-config") + 1].replace("file://", "");
  fs.copyFileSync(file, path.join(dir, "written-config.json"));
  process.stdout.write("{}");
} else {
  process.stderr.write("unexpected call: " + args.join(" ") + "\\n");
  process.exit(1);
}
`;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "norg-attach-cli-"));
  writeFileSync(join(dir, "aws"), FAKE_AWS);
  chmodSync(join(dir, "aws"), 0o755);
  writeFileSync(join(dir, "distribution.json"), JSON.stringify(DISTRIBUTION));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run the CLI with the stand-in `aws` first on PATH.
 *
 * @param {Array<string>} args CLI arguments.
 * @returns {Object} The spawnSync result.
 */
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AWS_DIR: dir, NORG_SITE_KEY: "" },
  });
}

/**
 * The stand-in's calls so far, as "service verb" pairs.
 *
 * @returns {Array<string>} One entry per call, in order.
 */
function calls() {
  return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .map((args) => `${args[0]} ${args[1]}`);
}

test("a dry run deploys nothing and changes nothing, even with no stack yet", () => {
  const result = runCli(["--distribution-id", "E123", "--origin-headers", HEADERS]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), ["cloudfront get-distribution-config", "cloudformation describe-stacks"]);
  assert.match(result.stdout, /Dry run\. Nothing was created or changed/);
  assert.match(result.stdout, /created on --apply/);
});

test("--apply --yes is the whole install: stack first, then the distribution, with its ETag", () => {
  const result = runCli(["--distribution-id", "E123", "--origin-headers", HEADERS, "--apply", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [
    "cloudfront get-distribution-config",
    "cloudformation describe-stacks",
    "cloudformation deploy",
    "cloudformation describe-stacks",
    "cloudfront update-distribution",
  ]);
  const raw = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const deploy = raw.find((args) => args[1] === "deploy");
  assert.ok(deploy.includes("CustomerOriginId=web"), "the origin is read from the distribution, not asked for");
  assert.ok(deploy.includes("norg-gate-E123"), "the stack name is worked out");
  assert.equal(deploy.join(" ").includes("nmt_secret_token"), false, "the token must never reach the stack");
  const update = raw.find((args) => args[1] === "update-distribution");
  assert.equal(update[update.indexOf("--if-match") + 1], "ETAG1", "a concurrent change must fail loudly");
});

test("the distribution gets the real function ARN, not the dry run's placeholder", () => {
  runCli(["--distribution-id", "E123", "--origin-headers", HEADERS, "--apply", "--yes"]);
  const written = JSON.parse(readFileSync(join(dir, "written-config.json"), "utf8"));
  const [association] = written.DefaultCacheBehavior.FunctionAssociations.Items;
  assert.equal(association.FunctionARN, "arn:aws:cloudfront::111:function/norg-edge-gate-site");
  const receptionist = written.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.ok(receptionist.CustomHeaders.Items.some((h) => h.HeaderValue === "nmt_secret_token"));
  assert.equal(written.DefaultCacheBehavior.CachePolicyId, "their-policy", "the cache policy is left alone");
});

test("--apply without --yes and no answer changes nothing", () => {
  const result = runCli(["--distribution-id", "E123", "--origin-headers", HEADERS, "--apply"]);
  assert.match(result.stdout, /Apply this to E123\?/);
  assert.deepEqual(calls().filter((c) => /deploy|update-distribution/.test(c)), []);
});

test("--detach needs no stack or headers, and names the stack to delete", () => {
  const result = runCli(["--distribution-id", "E123", "--detach", "--apply", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), ["cloudfront get-distribution-config", "cloudfront update-distribution"]);
  assert.match(result.stdout, /delete-stack --region us-east-1 --stack-name norg-gate-E123/);
});

test("an install with no mirror token stops before anything is deployed", () => {
  const result = runCli(["--distribution-id", "E123", "--origin-headers", `X-Norg-Site-Id=${SITE_ID}`, "--apply", "--yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /x-norg-mirror-token/);
  assert.deepEqual(calls().filter((c) => /deploy|update-distribution/.test(c)), []);
});
