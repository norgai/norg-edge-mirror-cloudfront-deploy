# NORG Edge Router — AWS CloudFront

Install NORG's edge-mirroring router on **your own** CloudFront distribution.
Everything runs in your AWS account; NORG never receives AWS credentials.

This is the CloudFront port of NORG's Cloudflare Worker.
Same product, same rules, same NORG back-channel — but AWS is a different
platform, and some of the differences are visible to you. They are listed in
[Differences from the Cloudflare install](#differences-from-the-cloudflare-install),
and it is worth reading that section *before* you install rather than after.

---

## What this does

Installed on your distribution, it inspects every request and decides who's
asking:

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, byte-for-byte unchanged |
| Googlebot, Bingbot, and other web-index crawlers | Your site, byte-for-byte unchanged |
| An AI agent (GPTBot, ClaudeBot, PerplexityBot, …) asking for a page NORG has already rendered | The NORG render, served **at your own URL** — no redirect, the address bar never changes |
| An AI agent asking for a page NORG hasn't rendered yet | Your own page, stripped to the token-dense facts, while NORG is asked in the background to render it |

Three rules are built in and have no off switch:

1. **It must never break your site.** Every failure path — NORG's API down, its
   storage unreachable, a bug in the router itself — ends at your origin.
2. **Search engines always see exactly what humans see.** Serving Googlebot
   different content is cloaking and would put your rankings at risk.
3. **Nothing happens without an authenticated feed.** Until NORG has
   authenticated the install, the router changes nothing at all. There is no
   local bot list to fall back on.

---

## Which install shape do you need?

|  | Your site is **already** served through CloudFront | Your site is **not** on CloudFront yet |
|---|---|---|
| Use | [`attach-existing.yaml`](cloudformation/attach-existing.yaml) + the attach CLI | [`new-distribution.yaml`](cloudformation/new-distribution.yaml) |
| DNS change | None | Yes — you repoint to the new distribution when ready |
| Touches production | Yes, it modifies your live distribution | No, until you cut DNS |
| Page caching | **None** — the CLI switches your default behaviour to CloudFront's managed `CachingDisabled` | None; only assets are cached |

Both require **us-east-1**. Lambda@Edge functions can only live there; the
distribution itself is global either way.

---

## Before you start

- [ ] **A `SITE_ID` and a `NORG_SITE_KEY`.** NORG issues both when you register
      the site. The key is shown **once** — NORG stores only a hash, so if you
      lose it, ask NORG to rotate it.
- [ ] **An origin hostname distinct from your public domain.** CloudFront must
      fetch your real pages from somewhere that is not the distribution itself,
      or requests loop.
- [ ] **Permission to create IAM roles, Lambda functions, CloudFront functions
      and policies** in us-east-1.
- [ ] **The artifact location NORG gives you** — S3 bucket, object keys, and
      (recommended) object versions. These parameters have **no defaults on
      purpose**: S3 bucket names are globally unique across all AWS accounts and
      these templates go to every customer, so a default naming a bucket could be claimed
      by someone else and would install their code into your account. Verify the
      bucket NORG names is one they own, or mirror the objects into your own
      bucket and point the parameters at that — which is fully supported and the
      right call if your policy forbids deploying third-party code.
- [ ] For the attach path: **no other origin-request Lambda@Edge function on
      the behaviour you're attaching to.** The installer refuses rather than
      replacing someone else's routing. Your own viewer-request, viewer-response
      and origin-response functions are left exactly as they are.
- [ ] For the attach path: **you are content for CloudFront to stop caching
      your HTML.** Every page request will reach the router and your origin
      will answer it, as it did before you had a CDN. Assets stay cached. The
      dry run states this before you confirm.

---

## Install: existing distribution

```bash
# 1. Create the functions and policies (no distribution is touched yet).
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name norg-edge \
  --template-file aws/cloudformation/attach-existing.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides SiteId=<your-site-id> SiteKey=<your-site-key> \
                        ProbeToken=<your-probe-token>
# The stack puts SiteKey into a Secrets Manager secret and passes only its ARN
# to the functions. To keep the key out of CloudFormation entirely, create the
# secret yourself and pass SecretArn=<arn> instead of SiteKey.

# 2. See exactly what would change on your live distribution. This is a DRY RUN.
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge

# 3. Apply it.
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge \
  --apply
```

To remove it: the same command with `--detach --apply`.

### What attaching changes about your caching

One thing, and the dry run says it in these words: your default behaviour's
cache policy becomes CloudFront's managed `CachingDisabled`, so **HTML is no
longer cached at the edge**. Every page request reaches the router; the router
answers an ordinary browser before making any lookup, and CloudFront fetches
your origin exactly as it would without us. Assets, framework prefixes and the
dynamic routes keep their own carve-out behaviours and are not affected.

Why not cache the human page and keep agents out of the cache? Because that
takes a cache key you can get wrong, a guard to keep origin bytes out of the
agent bucket, and an install-time decision about *your* policy's minimum TTL —
and a mistake in any of them serves the wrong page to the wrong visitor,
silently. Not caching the page removes the whole class of failure. What it
costs is one Lambda@Edge invocation per page request, priced below, and one
side effect worth knowing: CloudFront only compresses responses on a
behaviour whose cache policy enables it, and `CachingDisabled` does not, so
your origin's own compression is what reaches the browser (the viewer's
`Accept-Encoding` is forwarded) and a NORG mirror is served uncompressed.

### The quota the dry run prints

Every page request is an invocation, and Lambda@Edge concurrency is a
per-region quota shared with every other Lambda in your account. Past it,
CloudFront answers **every page request in that region with a 503**. The
attach CLI reads the quota in all thirteen regions Lambda@Edge runs in and
prints them; a region under 100 is flagged, because each instance serves ten
requests a second, so 100 is a ceiling of a thousand page requests a second.
New accounts often start at 10. Request an increase for quota `L-B99A9384`
(service `lambda`) in the flagged regions before attaching a busy site.

---

## Gate layout (no Lambda)

The install above runs a Lambda@Edge function on every page request. There is a
second, lighter layout for an existing distribution that runs **no Lambda at
all**: one CloudFront Function — a few hundred microseconds at the edge, no
cold start, no regional concurrency quota, no Secrets Manager secret, no
heartbeat — plus NORG's receptionist added to your distribution as an ordinary
HTTPS origin. Measured on NORG's own test distribution, an AI agent is answered
in 0.06–0.21 s warm and 0.5–1.6 s on a cold edge location; a person in a
browser never touches NORG code at all.

### How a request flows

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

What is **not** in the gate layout, on purpose: no caching change (humans never
reach NORG code, so your HTML stays cached however you have it), no MCP
carve-outs (the function treats MCP descriptors as NORG surfaces itself; the
old carve-outs broke on origins that reject a forwarded `Host`), no static
carve-outs (returning a static path untouched costs the function nothing). The
dynamic carve-outs stay — `/api/*`, `/wp-json/*`, `/wp-admin/*`,
`/wp-login.php`, `/cart*`, `/checkout*` go straight to your origin on every
method — because those are the paths that take POSTs.

### The two artifacts

| Artifact | What it is | Where it goes |
|---|---|---|
| [`aws/src/edge-gate.js`](src/edge-gate.js) | The built function (`aws/function/edge-gate.core.js`, minified, es2015, ≈2.2 KB against CloudFront's 10 KB limit), with four `__PLACEHOLDERS__` the installer fills: receptionist host, the two origin ids, the version | Inlined into the template below; digested in [`aws/src/DIGESTS.json`](src/DIGESTS.json) as `edge-gate.js` |
| [`aws/cloudformation/attach-gate.yaml`](cloudformation/attach-gate.yaml) | The stack: the function (`AWS::CloudFront::Function`, `AutoPublish: true`, runtime `cloudfront-js-2.0`) with the code inlined through `Fn::Sub`, and two alarms on `FunctionExecutionErrors` / `FunctionValidationErrors` | `aws cloudformation deploy`, us-east-1 |

There is no S3 artifact and no IAM role: the function's code is in the template
you deploy, so what you read is what runs. The template's parameters are
`SiteId`, `DistributionId` (alarms are scoped per distribution), `CustomerOriginId`
(the origin your default behaviour points at — the function fails over to it by
Id, and the attach CLI refuses a mismatch), `ReceptionistHost`
(`edge-content.norg.ai`), `ReceptionistOriginId` (`norg-receptionist`),
`NorgEnvironment`, `GateVersion` and an optional `AlarmTopicArn`.

**The mirror token is not a stack parameter.** The receptionist authenticates
your distribution by two origin custom headers on the receptionist origin,
`X-Norg-Site-Id` and `X-Norg-Mirror-Token`. NORG's API writes both when it edits
the distribution; by hand, you pass them to the attach CLI. A secret handed to
CloudFormation would sit in the stack's parameter list for anyone with
`describe-stacks`; on the origin it is visible only to someone who already has
`cloudfront:GetDistributionConfig` on your account.

### Install

```bash
# 1. The function and its alarms (no distribution is touched yet).
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name norg-gate \
  --template-file aws/cloudformation/attach-gate.yaml \
  --parameter-overrides SiteId=<your-site-id> DistributionId=EXXXXXXXXXXXX \
                        CustomerOriginId=<the Id of your default behaviour's origin>

# 2. Dry run: adds the receptionist origin, associates the function, adds the
#    dynamic carve-outs. Prints every change and exits.
node aws/install/attach.mjs --layout gate \
  --distribution-id EXXXXXXXXXXXX --stack norg-gate \
  --origin-headers "X-Norg-Site-Id=<your-site-id>,X-Norg-Mirror-Token=<your-token>"

# 3. Apply it.
node aws/install/attach.mjs --layout gate ... --apply
```

To remove it: `node aws/install/attach.mjs --layout gate --distribution-id EXXXXXXXXXXXX --detach --apply`
takes off the function association, the receptionist origin, every `x-norg-*`
header and our carve-outs, and restores nothing else — your cache policy was
never changed; the origin request policy stays `AllViewerExceptHostHeader`
(the one change attach makes to it, so the gate's headers and the full query
string reach the receptionist). The CLI refuses, rather than replaces, a
viewer-request CloudFront Function or an origin-request Lambda that is not
ours; our own are replaced, which is how an upgrade or a token rotation lands.

---

## Install: new distribution

Deploy [`new-distribution.yaml`](cloudformation/new-distribution.yaml) in
us-east-1. It creates the distribution, both functions, the policies and the
heartbeat schedule.

**Test on the `*.cloudfront.net` name first, before you point any DNS at it.**
Leave `AlternateDomainNames` blank for the first deploy; add it and an ACM
certificate once the checks below pass.

---

## Configuration

Config reaches the router as **CloudFront origin custom headers**, because
Lambda@Edge supports no environment variables at all. The router deletes them
from the request as it reads them, so they never reach your own web server or
its access logs — on every path, including the failure ones.

**The site key is not among them.** It lives in Secrets Manager and the router
fetches it at the edge, so it is not readable from your distribution's
configuration, and rotating it is one operation rather than two. What the
distribution carries is the secret's ARN, which is an address, not a credential.
The stack replicates the secret to the twelve other regions Lambda@Edge runs in
(`ReplicateSecret`, default on), and the router reads the replica in the region
that ran it rather than round-tripping to Virginia; an install without replicas
falls back to the primary. A human request never fetches it at all.

| Header | Default | Meaning |
|---|---|---|
| `x-norg-site-id` | *(required)* | `edge_sites.id` — identifies this install to NORG |
| `x-norg-secret-arn` | *(required)* | ARN of the Secrets Manager secret holding the site key |
| `x-norg-probe-token` | *(optional)* | Authorises the health probe and nothing else |
| `x-norg-api-url` | NORG's production API | Point at a different NORG environment |
| `x-norg-content-base` | NORG's edge-content service | Point at a different render source |
| `x-norg-env` | `unknown` | `production` or `test` — a test-bound install serves TEST content |
| `x-norg-strip-fallback` | `true` | `false` disables the stripped-origin fallback |
| `x-norg-disabled` | `false` | The kill switch (stack parameter `EdgeDisabled`). Every request passes straight through. **Not instant** — see Operational notes |
| `x-norg-lazy-render` | `true` | `false` serves the strip without asking NORG to render |
| `x-norg-events-verbose` | *(off)* | `true` also reports plain origin passthroughs |

### Carve-outs: what the router is never invoked for

There are now three groups of generated behaviours, matched in this order:

1. **MCP paths** (`/.well-known/mcp.json`, `*/mcp`, `*/sse`) — the full router,
   never cached, and the **only** behaviours with `IncludeBody: true`.
   Everywhere else the router receives no request body at all (see
   Operational notes).
2. **Dynamic paths** (`/api/*`, `/wp-json/*`, `/wp-admin/*`, `/wp-login.php`,
   `/cart`, `/cart/*`, `/checkout`, `/checkout/*`) — no Lambda and **no cache**:
   CloudFront's managed `CachingDisabled` + `AllViewerExceptHostHeader`, every
   method allowed. Your origin sees exactly what it would have without the
   router — including its *own* `Host`, which is why it is not plain
   `AllViewer`: that forwards the viewer's `Host`, and a host-routed origin
   (Vercel, API Gateway) answers it with 403. A 24-hour
   default TTL on `/cart` would serve one visitor's page to the next, which is
   why these do not share the static policy. `/account*` and `/login*` are
   deliberately absent — they also match marketing slugs like `/accounting`.
3. **Static assets** — no Lambda, cached 24 h by default.

**If you already have a behaviour for one of these patterns, yours is kept and
ours is skipped** — most importantly `/api/*`, which often points at a
different origin. The one exception is an MCP pattern, where the router *is*
the point, so a collision is refused. Detaching removes only behaviours that
match our shape on your default origin; a function-free `*.css` behaviour of
your own on the same origin is indistinguishable and would be removed with
ours — copy your patterns out first if that describes you.

The distribution ships with cache behaviours that carry **no Lambda
association**, so the router is never invoked — and never billed — for paths
that could never be a mirrored page. This is the same mechanism NORG uses on
Cloudflare, where each exclusion becomes a route with no Worker attached.

Two groups, both generated by `npm run build:aws` so they cannot drift:

- **Framework asset prefixes** — `/_next/*` and `/_vercel/*` by default, which
  is what NORG's own platform detection selects for a Next.js/Vercel origin.
  Serving a different stack? Replace them in the template's generated block
  (Shopify and WordPress equivalents are in `core/exclusions.mjs`).
- **Every static-asset extension** the router would have waved through anyway —
  `*.css`, `*.js`, `*.woff2`, and 46 more, from the same list the router itself
  uses.

On a typical Next.js page (~30 asset requests plus the document) this removes
roughly 95% of router invocations.

Two things worth knowing:

- **`.xml`, `.txt` and `.json` are deliberately absent** from the asset list.
  NORG's own surfaces use them — `/llms.txt`, `/tree.json`, `/openapi.json` — so
  a blanket rule would stop serving them. The build **fails** if a carve-out
  would shadow a NORG path.
- **Path patterns are case-sensitive.** `*.jpg` does not match `LOGO.JPG`; those
  fall through to the router, which lowercases and handles them correctly. A
  cost miss, never a correctness one.

Attaching to an existing distribution adds a curated ten suffixes instead of all
49, because the 75-behaviour budget is yours; the CLI refuses rather than
exceeding it.

### What your origin sees as `Host`

CloudFront requires an origin-request function to send the origin its **own**
hostname, so your origin always sees the origin domain — never the hostname the
visitor typed. This is not configurable: a mismatch is rejected with a 403
before your origin is contacted.

It matters if your origin is host-aware. Absolute URLs, canonical tags, cookie
domains and especially **auth middleware** will be built from the origin's
hostname. An auth layer that redirects to its own host will bounce visitors off
the CloudFront domain entirely.

**So the router forwards the visitor's hostname separately**, as
`X-Norg-Public-Host`, on every request it hands to your origin:

```
Host:                origin.example.com     <- required by CloudFront
X-Norg-Public-Host:  www.example.com        <- what the visitor actually typed
```

Read that header wherever you build an absolute URL and the problem goes away
without changing how you are addressed. It matters most for `sitemap.xml` and
`robots.txt`: a sitemap built from the origin's hostname advertises URLs on a
domain the crawler did not ask for, and a crawler scoped to your public host
discards every one of them — leaving it with your homepage alone.

The router always sets this header itself, so a value sent by a visitor is
overwritten and never reaches you. Treat it as trustworthy for that reason,
and only for requests that arrive through the distribution. Vercel-hosted
origins in particular need it, because Vercel overwrites `X-Forwarded-Host`
when the `Host` it receives differs from the TLS SNI.

Auth redirects are the one case this does not solve by itself: the fix there is
still at the origin — serve the CloudFront-facing hostname directly, or stop
emitting host-absolute redirects.

> **Where the site key is visible.** In Secrets Manager, and nowhere else in
> your account. Reading it needs `secretsmanager:GetSecretValue` on that one
> secret, and every read is recorded in CloudTrail. The router's and the
> heartbeat's execution roles are scoped to that ARN alone. It is a credential
> for this one site, and revoking it degrades the install to "always serve
> origin" — a safe stop, not an outage.
>
> Before 0.4.0 it sat in the distribution's configuration and again in the
> heartbeat's environment, readable to anyone with `cloudfront:GetDistributionConfig`
> or `lambda:GetFunctionConfiguration`. If you are upgrading, rotate the key:
> the old value was visible to a much wider set of principals.

---

## Verifying the install

Wait for `Status: Deployed` (5–15 minutes), then run these against a real page.

### 1. An AI agent gets the NORG treatment

```bash
curl -sI -H "User-Agent: GPTBot" https://your-domain.com/some-page/ | grep -i x-norg-edge
```

| Result | Meaning |
|---|---|
| `X-Norg-Edge: mirror` | A NORG render exists and was served. Fully working. |
| `X-Norg-Edge: stripped` | Nothing rendered yet — your page was served stripped and a render was requested. Re-check in a few minutes. |
| *(no header)* | The router never ran — see [Troubleshooting](#troubleshooting). |

> A plain `curl -A GPTBot` from your laptop will **not** be diverted, and that
> is correct: the router verifies the source IP against the crawler operator's
> published ranges, so a spoofed user-agent from an arbitrary address is
> refused. Use the health probe below to prove the router is alive.

### 2. A normal visitor is untouched

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" \
  https://your-domain.com/some-page/ | grep -i x-norg-edge
```

Expect **no output at all**, and `x-cache: Miss from cloudfront` both times you
run it: a page is never cached at the edge, so your origin answered both.

### 3. The router is alive and entitled

```bash
curl -s -H "x-norg-edge-check: <your-probe-token>" https://your-domain.com/ | jq
```

```json
{ "site_id": "…", "version": "0.6.0", "env": "production",
  "disabled": false, "platform": "cloudfront", "entitled": true, "ts": 1730000000000 }
```

`entitled: false` is the first thing to check when an install "does nothing":
it means NORG has not authenticated this install, and rule 3 means the router
is deliberately inert.

---

## Differences from the Cloudflare install

These are platform constraints or deliberate choices, and three of them change
behaviour you can observe.

| | Cloudflare | CloudFront |
|---|---|---|
| **Bot verification** | Operator CIDR ranges, falling back to Cloudflare's verified-bot signal | **CIDR ranges only** |
| **Where it runs** | Before the cache, on every request | On **every page request**; the page is never cached at the edge |
| **Mirror cache** | In-colo, keyed per tenant | Held by NORG's content service; **none in the function** |
| **Who records an agent visit** | The worker, through `ctx.waitUntil` | **NORG's content service**, from a header on the mirror fetch; the router makes no call of its own |
| **Passthrough events** | Every visit | Off unless `x-norg-events-verbose=true`, and then best-effort |
| **Config** | Worker bindings | Origin custom headers |
| **Liveness cron** | Worker cron trigger | A separate scheduled Lambda |
| **Rollback speed** | Delete a route — seconds | 5–15 min propagation; a Lambda@Edge replica takes ~30 min to become deletable |
| **The one cliff** | Workers free plan: 100k requests/day, fails closed by default | The regional Lambda concurrency quota: past it, **503** on every page request in that region |

**Bot verification is genuinely weaker here.** CloudFront exposes no
verified-bot signal (AWS's equivalent is AWS WAF Bot Control, a separate
product), so a crawler whose operator publishes no CIDR ranges will **not** be
diverted on CloudFront where it would be on Cloudflare. The failure direction is
the safe one — it under-serves agents rather than over-serving humans — but it
means fewer diverts on some crawlers.

**The router makes no call to report a visit.** Lambda@Edge freezes the moment
the handler returns, so a background call is lost and an awaited one is a wait
the visitor pays. Instead the details of the visit — user agent, classification,
what was served, and the viewer country, city, ASN, protocol and TLS version
CloudFront supplies — travel as one request header on the mirror fetch the
router was going to make anyway. NORG's content service, which runs on
Cloudflare and has a deferred-work primitive, records the event after it has
answered, and on a miss enqueues the render the same way. Two consequences: a
page served from your origin because NORG had no render is recorded as
`stripped` (or `origin`, if the strip fallback is off) without the `origin_thin`
distinction other platforms report; and a human passthrough is recorded only if
you opt in, and then by an un-awaited call that a freezing container may drop.

**There is no page cache at the edge, and no mirror cache in the function.**
The human page is served by your origin on every request, so there is no cache
key that could serve an agent's page to a person or a person's page to an
agent, and no guard needed to keep one out. Mirrors are cached by NORG's
content service behind its own authentication; a copy inside the function would
be a visit nobody recorded.

---

## Operational notes

- **us-east-1, always.** Lambda@Edge is a us-east-1-only resource.
- **Rollback is slow.** Budget 5–15 minutes for any distribution change to
  propagate, and up to ~30 minutes before a Lambda@Edge replica can be deleted.
  If the site matters, attach to a
  [CloudFront continuous-deployment](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/continuous-deployment.html)
  staging distribution first and shift traffic gradually. "Degrades safely" and
  "reverts quickly" are not the same property, and this install has the first.
- **Cost.** Every page request invokes Lambda@Edge, which has **no free tier**
  (unlike CloudFront requests). A human page view is answered in a few
  milliseconds with no lookup; an agent visit pays for the mirror fetch.
  Measured on a live install over a week — mean 126 ms on agent traffic, peak
  116 MB — at the 192 MB this ships with:

  | | per 1M page requests |
  |---|---|
  | Lambda@Edge (192 MB), human page views | ~$0.65 |
  | Lambda@Edge (192 MB), agent visits | ~$1.80 |
  | CloudFront requests | $1.00 (first 10M/month free) |

  The install keeps that number small by **not invoking the router for static
  assets at all** — see below. Assets are 90–95% of a typical page's requests.
- **The concurrency quota is the cliff.** Lambda@Edge concurrency is a
  per-region quota (`L-B99A9384`, default 1,000, often 10 on newer accounts),
  shared by every Lambda in the account in that region, and each instance
  serves ten requests a second. Past it CloudFront answers every page request
  in that region with a 503. The attach CLI prints the quota per region and
  flags any under 100; the new-distribution template enables a per-IP rate
  limit by default (`EnableRateLimit`), because a scraper on unique paths is
  the way to reach the quota.
- **Request bodies never reach the router except on MCP paths.** `IncludeBody`
  is set per association, and on the default behaviour it delivered every
  cache-miss POST body on your site — logins, checkouts, forms — into the
  router's memory, even though the router discards them. It is now **off** on
  the default behaviour and on only for the three MCP behaviours, the one
  surface that forwards a body. Access there is read-only; your origin still
  receives the full original body.
- **There is no instant off switch on CloudFront, and this README used to say
  there was.** Set the `EdgeDisabled` stack parameter to `"true"` (or the
  `x-norg-disabled` origin header) and the router passes everything through on
  its very first check — but that is a distribution update, and it takes
  **5–15 minutes** to propagate. So does detaching. The remote lever is NORG
  revoking your site key, which the router notices on its next feed refresh —
  up to an hour on a warm container, one minute on a cold one.
- **Where your site key is readable.** One place: the Secrets Manager secret
  the stack creates (or the one you pass as `SecretArn`). Reading it needs
  `secretsmanager:GetSecretValue` on that ARN, and CloudTrail records every
  read. **Rotating is a single call** and needs no redeploy — the edge picks up
  a new value within fifteen minutes, and the heartbeat within its next run:

  ```bash
  aws secretsmanager put-secret-value --secret-id <SecretArn> \
    --secret-string '<new-key>'
  ```

  If you would rather the key never entered a CloudFormation parameter at all,
  create the secret yourself and pass `SecretArn`; leave `SiteKey` blank.
- **The probe token is not your site key.** `x-norg-edge-check` compares against
  a token that authorises reading install status and nothing else. It is
  stripped from the request before the origin sees it, so a mistyped probe
  cannot land in your access logs either.
- **Logs are scattered and, by default, kept forever.** Lambda@Edge writes its
  logs to CloudWatch in the **region nearest the edge that ran it**, under
  `/aws/lambda/us-east-1.<function-name>` — a single install accumulates log
  groups in several regions with no retention set. Set one:

  ```bash
  for r in us-east-1 us-west-2 eu-west-1 ap-southeast-2; do
    aws logs put-retention-policy --region $r --retention-in-days 30 \
      --log-group-name /aws/lambda/us-east-1.<EdgeRouterFunction name>
  done
  ```

  Distribution access logging is **off** by default; if you need a record of
  what was served to whom, enable standard logging to S3 on the distribution.
  The stack creates two alarms — router errors (a 502 to a visitor) and
  heartbeat failures (NORG rejected the install) — give them somewhere to go
  with the `AlarmTopicArn` parameter.
- **Rate limiting is on by default on a new distribution.** Every page request
  is a Lambda invocation on your bill and against the regional quota above, so
  a scraper can run the meter and then the 503s. `EnableRateLimit` attaches a
  single per-IP rate-based WAF rule (`RateLimitPerFiveMinutes`, default 2000)
  for about $6/month; set it to `false` if you already run WAF and add the rule
  to your own ACL instead. The attach path does not create a WAF; add the rule
  to yours.
- **Verify what you deployed.** Every deployable artifact is digested in full
  in [`aws/src/DIGESTS.json`](../aws/src/DIGESTS.json), committed alongside the
  source it was built from, so you can check what you are about to run against
  what this repository publishes:

  ```bash
  sha256sum aws/src/edge-router-lambda.cjs aws/src/heartbeat-lambda.cjs aws/src/edge-gate.js
  cat aws/src/DIGESTS.json
  ```

  Always pin `ArtifactObjectVersion` and `HeartbeatObjectVersion`, and check the
  zip's digest before launching:

  ```bash
  aws s3api list-object-versions --bucket <ArtifactBucket> --prefix edge-router-lambda/
  aws s3api get-object --bucket <ArtifactBucket> --key <ArtifactKey> \
    --version-id <ArtifactObjectVersion> router.zip && sha256sum router.zip
  ```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `X-Norg-Edge` header on any request, health probe also silent | The functions aren't associated with the behaviour serving that path, or the distribution hasn't finished deploying |
| Health probe works, agents still get the origin | `entitled: false` (NORG hasn't authenticated the install), or the agent's source IP isn't in the operator's published ranges |
| Every page request in one region answers 503 | The Lambda concurrency quota in that region is exhausted — re-run the attach CLI's dry run for the table, and request an increase for `L-B99A9384` |
| An S3-backed distribution | Config is read from the S3 origin's custom headers too; the strip fallback is not available there (the function cannot read an OAC bucket directly), so a render miss is served by passthrough |
| `X-Norg-Edge: stripped` forever | NORG hasn't rendered that page yet; check for `x-norg-lazy-render=false` |
| 502 from CloudFront | Should not happen — every router failure path ends at your origin. Check the function's CloudWatch logs in the region nearest the failing viewer, and tell NORG |
| Heartbeat never arrives at NORG | The scheduled function's `SITE_ID`/`NORG_SITE_KEY` env vars, or its CloudWatch error metric |

Lambda@Edge logs land in CloudWatch **in the region nearest the viewer**, not in
us-east-1 — a common surprise when a log group looks empty.

---

## Development

```bash
npm run test:aws     # node:test, nothing to install
npm run build:aws    # rebuild aws/src/ and re-embed the function in the templates
```

`aws/src/` holds committed build artifacts: the templates and the attach CLI
deploy exactly those files and NORG pins them by SHA-256, so CI rebuilds them
and fails on any diff. `aws/build.mjs` also builds the gate function
(`aws/function/build.mjs`) and inlines it into `cloudformation/attach-gate.yaml`,
so an edit to `edge-gate.core.js` without a rebuild fails CI the same way.

Source layout:

Provider-neutral logic lives in **`core/`** at the repository root, not under
`aws/`. Roughly 1,280 of the ~1,690 lines are neutral — the strip rewriter, bot
classification, the feed and entitlement gate, telemetry, path predicates,
constants and exclusions are identical on any CDN. Only the adapter is
CloudFront-specific.

| Path | What it is |
|---|---|
| `core/` | **Provider-neutral.** strip, agent, paths, feed, visit, telemetry, deferred, norg, constants, exclusions, config helpers |
| `lambda/edge-router-lambda.js` | The router pipeline, same order as `workers/edge-router-worker.js` |
| `lambda/lib/` | **CloudFront adapters only** — `event.js`, `origin.js`, `config.js`, `secret.js` |
| `lambda/heartbeat-lambda.js` | Scheduled liveness beat |
| `function/edge-gate.core.js` | The gate layout's CloudFront Function (viewer-request, no Lambda) and its build |
| `cloudformation/` | The three install templates (`new-distribution`, `attach-existing`, `attach-gate`) |
| `install/attach.mjs` | Attach/detach against an existing distribution, `--layout lambda` (default) or `gate` |

`lambda/lib/constants.mjs` is a deliberate **copy** of the Cloudflare worker's
constant tables, not an import: that worker's bundle is SHA-256-pinned by NORG's
backend, and refactoring shared values out of it would change the shipped bytes
and tell every installed Cloudflare site an update is available. The copy is
kept honest by `tests/constants-parity.test.mjs`, which compares declaration
text and names any constant that drifts.
