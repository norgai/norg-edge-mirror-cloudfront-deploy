# NORG Edge Router — AWS CloudFront

Install NORG's edge-mirroring router on **your own** CloudFront distribution.
Everything runs in your AWS account; NORG never receives AWS credentials.

It runs **no Lambda**: one CloudFront Function, a few hundred microseconds at
the edge, with no cold start, no regional concurrency quota, no Secrets Manager
secret and no heartbeat. NORG's receptionist is added to your distribution as
an ordinary HTTPS origin. Measured on NORG's own test distribution, an AI agent
is answered in 0.06–0.21 s warm and 0.5–1.6 s on a cold edge location; a person
in a browser never touches NORG code at all.

> **Moving from the Lambda layout?** It was removed in `cloudfront-v0.6.15`. See
> [Upgrading from the Lambda layout](#upgrading-from-the-lambda-layout).

---

## What this does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged, and your cache policy applies exactly as before |
| Googlebot, Bingbot, and other web-index crawlers | Your site, unchanged |
| A verified AI agent (GPTBot, ClaudeBot, PerplexityBot, …) on a page NORG has rendered | The NORG render, served **at your own URL** — no redirect |
| Anyone else NORG does not answer | Your own page, through CloudFront's origin failover |

Three rules are built in and have no off switch:

1. **It must never break your site.** A NORG refusal or fault ends at your
   origin.
2. **Search engines always see exactly what humans see.** Serving Googlebot
   different content is cloaking and would put your rankings at risk.
3. **Nothing happens without authentication.** The receptionist only serves a
   distribution that presents your site's mirror token.

---

## Before you start

- [ ] **A site already served through CloudFront.** The installer attaches to an
      existing distribution. Not on CloudFront yet? Create a distribution for
      your site first; this repo no longer ships a template that does it.
- [ ] **A `SITE_ID` and a mirror token.** NORG issues both.
- [ ] **The AWS CLI**, configured with permission to deploy a CloudFormation
      stack, create CloudFront Functions and CloudWatch alarms, and update the
      distribution.
- [ ] **Node.js**, to run the installer. Nothing to install.
- [ ] **No other viewer-request CloudFront Function or origin-request
      Lambda@Edge on your default behaviour.** The installer refuses rather than
      replaces them.

---

## Install

One command does the whole install. First, see exactly what it would do. This
creates and changes nothing:

```bash
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --origin-headers "X-Norg-Site-Id=<your-site-id>,X-Norg-Mirror-Token=<your-token>"
```

Then add `--apply`:

```bash
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --origin-headers "X-Norg-Site-Id=<your-site-id>,X-Norg-Mirror-Token=<your-token>" \
  --apply
```

It asks you to confirm, then:

1. Deploys [`attach-gate.yaml`](cloudformation/attach-gate.yaml) as the stack
   `norg-gate-<distribution-id>`: the function and its two alarms. The origin it
   fails over to is read from your default behaviour.
2. Adds the receptionist origin, associates the function on viewer-request,
   sets the origin request policy, and adds the dynamic carve-outs.

| Flag | What it does |
|---|---|
| `--apply` | Make the changes. Without it, the command is a dry run. |
| `--yes` | Skip the confirmation, for use in automation. |
| `--stack <name>` | Use your own stack name. |
| `--norg-environment <production\|test>` | Defaults to `production`. |
| `--alarm-topic-arn <arn>` | Send the two alarms to an SNS topic. |
| `--receptionist-origin-id <id>` | Change this only if your distribution already uses `norg-receptionist`. |

**To upgrade or rotate the token,** run the same command again. It updates the
stack and replaces our own function and origin.

**To remove it:**

```bash
node aws/install/attach.mjs --distribution-id EXXXXXXXXXXXX --detach --apply
```

That takes off the function association, the receptionist origin, every
`x-norg-*` header and our carve-outs, and restores nothing else. Your cache
policy was never changed; the origin request policy stays
`AllViewerExceptHostHeader`. Once the distribution shows `Deployed`, delete the
stack with the command it prints.

### What it changes on your distribution

- **Viewer-request function:** the gate, on your default behaviour.
- **Origin request policy:** `AllViewerExceptHostHeader`, so the gate's headers
  and the full query string reach the receptionist.
- **A new origin:** the receptionist, https-only, carrying `X-Norg-Site-Id` and
  `X-Norg-Mirror-Token`.
- **Dynamic carve-outs:** `/api/*`, `/wp-json/*`, `/wp-admin/*`, `/wp-login.php`,
  `/cart*` and `/checkout*` go straight to your origin on every method, because
  an origin group never fails a POST over and those are the paths that take
  them. A behaviour you already have for one of these patterns stays as it is.

What it leaves alone: your cache policy, your own origin, and any
viewer-response function.

**The mirror token is not a stack parameter.** A secret handed to CloudFormation
would sit in the stack's parameter list for anyone with `describe-stacks`; on the
origin it is visible only to someone who already has
`cloudfront:GetDistributionConfig` on your account.

---

## How a request flows

The function runs at **viewer request**, before CloudFront's cache, on your
default behaviour. For every request it makes one decision:

1. **NORG-owned path** (`/llms.txt`, `/.well-known/mcp.json`, `*/mcp`,
   `*/sse`, `/.norg/*`, a page's `index.md` sibling, …) → hand to NORG, for
   everyone.
2. **Static file** (`.css`, `.js`, images, fonts, documents) → your origin,
   untouched.
3. **Googlebot, Bingbot and the other web-index crawlers** → your origin,
   untouched. Rule 2 holds: search engines see what humans see.
4. **An ordinary browser** (no `?agent=true`, no `Signature-Agent` header) →
   your origin, untouched. Not a byte of the request changes, and your cache
   policy applies exactly as before.
5. **Anything but GET or HEAD** → your origin. CloudFront only fails an
   origin group over on GET, HEAD and OPTIONS, so a webhook or app POST must
   never be sent to the receptionist in the first place.
6. **Everything else** — AI agents, unknown clients, a browser asking for the
   agent view — is *handed to NORG*: the function stamps `x-norg-gate`,
   `x-norg-gate-version`, `x-norg-ua` and `x-norg-viewer-ip` onto the request
   and switches it onto an **origin group**: NORG's receptionist first, your
   own origin second. The receptionist answers the NORG render for a verified
   AI agent and **404 for anyone else**, and on a 404 CloudFront fails over to
   your origin. The path is never rewritten — the failover delivers exactly
   the URL the visitor asked for — and the receptionist knows which site it is
   from the `X-Norg-Site-Id` header on its origin, not from the path.

Every branch returns the request. The whole body is guarded: a bug in the
function can only let a request through to your origin, never break the site.
(A CloudFront Function that throws answers 503, which is why the stack's two
alarms watch exactly that.)

---

## Verifying the install

Wait for `Status: Deployed` (5–15 minutes), then:

```bash
# The function is on your default behaviour.
aws cloudfront get-distribution-config --id EXXXXXXXXXXXX \
  --query 'DistributionConfig.DefaultCacheBehavior.FunctionAssociations'

# A normal visitor is untouched: expect no output.
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" \
  https://your-domain.com/some-page/ | grep -i x-norg-edge
```

A plain `curl -A GPTBot` from your laptop will **not** get a NORG render, and
that is correct: agents are verified by source IP against the ranges their
operators publish, so a spoofed user agent is refused and ends at your origin.

---

## Upgrading from the Lambda layout

Run the [install command](#install) on the distribution. The dry run lists what
it will remove:

- our router's Lambda@Edge association;
- its MCP and static carve-outs;
- its `x-norg-*` headers on your origin. The router stripped these from each
  request, so they would reach your server once it is gone.

Then, after the distribution shows `Deployed`:

- Delete the old `attach-existing` stack. A Lambda@Edge replica can take about
  30 minutes before it can be deleted, so a first attempt may need retrying.
- **Check your cache policy.** The Lambda layout set your default behaviour to
  `CachingDisabled`, and the gate leaves your cache policy alone. If you want
  your HTML cached again, set your own policy back.

A distribution created by the old `new-distribution` template is managed by that
stack, so make changes to it with care: the stack may undo edits made outside it.

---

## Differences from the Cloudflare install

| | Cloudflare | CloudFront gate |
|---|---|---|
| **What runs at the edge** | The full worker | One small function that decides who to hand to NORG |
| **Bot verification** | Operator CIDR ranges, falling back to Cloudflare's verified-bot signal | By the receptionist, from the viewer IP the function forwards |
| **Your HTML cache** | Worker runs before the cache | Unchanged; humans never reach NORG code |
| **Config** | Worker bindings | Origin custom headers on the receptionist origin |
| **Rollback speed** | Delete a route — seconds | 5–15 minutes to propagate |

---

## Operational notes

- **us-east-1, always.** The stack's alarms read AWS/CloudFront metrics, which
  CloudWatch publishes only there. The installer handles this.
- **Rollback is not instant.** Any distribution change takes 5–15 minutes to
  propagate, including detaching. If the site matters, attach to a
  [CloudFront continuous-deployment](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/continuous-deployment.html)
  staging distribution first and shift traffic gradually.
- **Give the alarms somewhere to go.** The two alarms fire when the function
  throws or returns something invalid, which answers visitors with a 503. Pass
  `--alarm-topic-arn`.
- **Verify what you deployed.** The function is inlined in the template, and
  digested in [`aws/src/DIGESTS.json`](src/DIGESTS.json):

  ```bash
  sha256sum aws/src/edge-gate.js
  cat aws/src/DIGESTS.json
  ```

- **A known limit on removing carve-outs.** A cache behaviour has no tag field,
  so ours are recognised by shape. If you have your own function-free `*.css`
  behaviour on the same origin as your default behaviour, it looks like the old
  Lambda layout's and would be removed on upgrade or detach.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The installer refuses with "already has a viewer-request CloudFront Function" | Someone else's function is on your default behaviour. CloudFront allows one per event type. Remove it first, or attach to a staging distribution. |
| The installer refuses with "already has an origin-request Lambda@Edge function" | The same, for a Lambda that isn't ours. |
| The installer refuses with "must include x-norg-mirror-token" | Without the token the receptionist answers 404 to everything and the install silently serves nothing, so it won't proceed. |
| The installer fails on the ETag | The distribution changed while it ran. Run it again. |
| Agents always get your own page | The token on the receptionist origin is wrong, the page isn't rendered yet, or the agent's source IP isn't in its operator's published ranges. |
| 503 on every request | The function threw or returned something invalid. Check the two alarms, and tell NORG. |

---

## Development

```bash
node --test aws/tests/*.test.mjs aws/function/*.test.mjs   # nothing to install
node aws/build.mjs                                         # rebuild aws/src/ and the template
```

`aws/src/` is committed because the installer deploys exactly those files and
NORG pins them by SHA-256, so CI rebuilds them and fails on any difference.
`aws/build.mjs` builds the function and inlines it into
`cloudformation/attach-gate.yaml`, so an edit to `edge-gate.core.js` without a
rebuild fails CI the same way.

| Path | What it is |
|---|---|
| `function/edge-gate.core.js` | The CloudFront Function, and `function/build.mjs` builds it |
| `cloudformation/attach-gate.yaml` | The install stack |
| `install/attach.mjs` | Installs on, upgrades and removes from a distribution |
| `src/` | Committed build artifacts: `edge-gate.js` and `DIGESTS.json` |
| `tests/attach-cli.test.mjs` | Runs the installer end to end against a stand-in `aws` command |
