# NORG Edge Router — AWS CloudFront

This repo holds NORG's edge router for sites served through **AWS CloudFront**. It installs on **your own** distribution and runs in your AWS account, with no Lambda. NORG never receives AWS credentials.

```bash
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --origin-headers "X-Norg-Site-Id=<your-site-id>,X-Norg-Mirror-Token=<your-token>" \
  --apply
```

Without `--apply` that's a dry run, which creates and changes nothing.

**Install guide, configuration and troubleshooting: [`aws/README.md`](aws/README.md)**

> **On Cloudflare?** Use the [Cloudflare Worker](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy) instead. Other platforms are listed under [Other platforms](#other-platforms).

The current version is on the [latest release](https://github.com/norgai/norg-edge-mirror-cloudfront-deploy/releases/latest). Release tags are the only place the version is recorded.

---

## What it does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged |
| A verified AI agent, on a page NORG has rendered | The NORG render, at your own URL, with no redirect |
| Anyone else NORG does not answer | Your own page, through CloudFront's origin failover |

The three rules every NORG router follows hold here unchanged:
- **It never breaks your site.** A NORG refusal or fault ends at your origin.
- **Search engines see what people see.**
- **Nothing happens without authentication.** The receptionist only serves a distribution that presents your site's mirror token.

---

## Layout

```
aws/
  function/                the CloudFront Function
  cloudformation/          attach-gate.yaml, the install stack
  install/attach.mjs       installs on, upgrades and removes from a distribution
  src/                     committed build artifacts and DIGESTS.json
  tests/                   node:test suites
  build.mjs                builds aws/src/ and embeds the function in the template
core/exclusions.mjs        the carve-out lists the installer uses
core/ (the rest), workers/, src/, build.mjs, wrangler.jsonc, README.shopify.md
                           carried over from the original repo; the gate doesn't use them
```

## Development

```bash
node --test aws/tests/*.test.mjs aws/function/*.test.mjs   # nothing to install
node aws/build.mjs                                         # rebuild aws/src/ and the template
```

`aws/src/` is committed because the installer deploys exactly those files and NORG pins them by SHA-256. CI rebuilds them and fails on any difference.

## Releasing

1. For a change to the function, bump `GATE_VERSION` in `aws/function/build.mjs`. The function sends it on every hand-off to NORG.
2. Run `node aws/build.mjs` and the tests, then merge to `main`.
3. Tag `cloudfront-vX.Y.Z` and publish a GitHub release with the built files attached. The tag is the release version; don't record it in the code.
4. If the function or template changed, publish them with content-craft's `scripts/edge/publish_cloudfront_artifacts.py --layout gate`, then update the pins in its `cloudfront_pin.py`.

---

## Other platforms

| Platform | Where it lives |
|---|---|
| **AWS CloudFront** | This repo. Install guide: [`aws/README.md`](aws/README.md) |
| **Cloudflare** | [`norg-edge-mirror-cloudflare-deploy`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy) |
| **Next.js and Vercel** | [`norg-edge-mirror-nextjs-deploy`](https://github.com/norgai/norg-edge-mirror-nextjs-deploy) |
| **Fastly Compute** | [`norg-edge-mirror-fastly-deploy`](https://github.com/norgai/norg-edge-mirror-fastly-deploy) |
| **Bunny Edge Scripting** | [`norg-edge-mirror-bunny-deploy`](https://github.com/norgai/norg-edge-mirror-bunny-deploy) |

## Support

For questions about your install, your Site ID or your mirror token, contact your NORG account contact.
