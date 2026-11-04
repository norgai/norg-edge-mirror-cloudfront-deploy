# NORG Edge Router — AWS CloudFront

This repo holds NORG's edge router for sites served through **AWS CloudFront**. It installs on **your own** distribution and runs in your AWS account. NORG never receives AWS credentials.

**Install guide, configuration and troubleshooting: [`aws/README.md`](aws/README.md)**

> **On Cloudflare?** Use the [Cloudflare Worker](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy) instead. Other platforms are listed under [Other platforms](#other-platforms).

| | Version | Set in |
|---|---|---|
| Router | 0.6.14 | `EDGE_SCRIPT_VERSION` in `aws/lambda/lib/config.js` |
| Gate function | 0.1.1 | `GATE_VERSION` in `aws/function/build.mjs` |

---

## What it does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged |
| An AI agent, on a page NORG has rendered | The NORG render, at your own URL, with no redirect |
| An AI agent, on a page not rendered yet | Your page stripped to its facts, while NORG renders it |

The three rules every NORG router follows hold here unchanged:
- **It never breaks your site.** Every failure path ends at your origin.
- **Search engines see what people see.**
- **Nothing happens without NORG's authenticated feed.** There is no local bot list to fall back on.

CloudFront behaves differently from Cloudflare in ways you can observe, so read [Differences from the Cloudflare install](aws/README.md#differences-from-the-cloudflare-install) before installing.

## Install options

| Your situation | Use | Runs |
|---|---|---|
| Already on CloudFront | [`attach-existing.yaml`](aws/cloudformation/attach-existing.yaml) and the attach CLI | Lambda@Edge on every page request |
| Already on CloudFront, and you want no Lambda | [`attach-gate.yaml`](aws/cloudformation/attach-gate.yaml) and `attach --layout gate`. See [Gate layout](aws/README.md#gate-layout-no-lambda) | One CloudFront Function, with NORG's receptionist as an origin |
| Not on CloudFront yet | [`new-distribution.yaml`](aws/cloudformation/new-distribution.yaml) | Lambda@Edge on every page request |

---

## Layout

```
aws/
  lambda/                  the router and heartbeat Lambdas, and their CloudFront adapters
  function/                the gate layout's CloudFront Function
  cloudformation/          the three install templates
  install/attach.mjs       attach/detach on an existing distribution
  src/                     committed build artifacts and DIGESTS.json
  tests/                   node:test suites
  build.mjs                builds aws/src/ and embeds the function in the templates
core/                      provider-neutral router logic
workers/, src/, build.mjs, wrangler.jsonc, README.shopify.md
                           Cloudflare files carried over from the original repo
```

The CloudFront code imports `workers/lib/`, and `aws/tests/constants-parity.test.mjs` reads `workers/edge-router-worker.js`, so `workers/` has to stay for now. This copy of the worker is at 0.11.7 and is not the Cloudflare release. For that, see the [Cloudflare repo](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy).

## Development

```bash
node --test aws/tests/*.test.mjs aws/function/*.test.mjs   # nothing to install
node aws/build.mjs                                         # rebuild aws/src/ and the templates
```

`aws/src/` is committed because the templates and the attach CLI deploy exactly those files and NORG pins them by SHA-256. CI rebuilds them and fails on any difference.

## Releasing

1. Bump `EDGE_SCRIPT_VERSION` in `aws/lambda/lib/config.js`, and the assertions in `aws/tests/config.test.mjs`. For a gate change, bump `GATE_VERSION` in `aws/function/build.mjs`.
2. Run `node aws/build.mjs` and the tests, then commit the rebuilt files.
3. Tag `cloudfront-vX.Y.Z` and publish a GitHub release.
4. Publish the artifacts with `scripts/edge/publish_cloudfront_artifacts.py`, then update the pins in content-craft's `cloudfront_pin.py`.

---

## Other platforms

| Platform | Where it lives |
|---|---|
| **AWS CloudFront** | This repo. Install guide: [`aws/README.md`](aws/README.md) |
| **Cloudflare** | [`norg-edge-mirror-cloudflare-deploy`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy) |
| **Next.js and Vercel** | [`norg-edge-mirror-nextjs-deploy`](https://github.com/norgai/norg-edge-mirror-nextjs-deploy) |
| **Fastly Compute** | [`norg-edge-mirror-fastly-deploy`](https://github.com/norgai/norg-edge-mirror-fastly-deploy) |
| **Bunny Edge Scripting** | [`norg-edge-mirror-bunny-deploy`](https://github.com/norgai/norg-edge-mirror-bunny-deploy) |
| **WordPress (no CDN)** | [`feature/wordpress-plugin`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/wordpress-plugin) in the Cloudflare repo |

## Support

For questions about your install, your Site ID or Site Key, contact your NORG account contact.
