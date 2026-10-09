# Licensing

Cubepals is open source under the AGPL, with two exceptions: the brand and the site are kept
back, and blocklyd, the node daemon, is in its own repository under the Functional Source
License.

| What | Where | Licence |
| --- | --- | --- |
| The code: the control plane, the web app, the edge, the packages, the scripts and the infrastructure | everything not listed below | [AGPL-3.0-only](LICENSE) |
| The brand: the Cubepals name, mark and wordmark | [`brand/`](brand/) | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |
| The site: the landing page, the site's pictures and the guides' words | `apps/web/src/landing/` (except `type/` and `fonts.ts`), `apps/web/public/imagery/`, `apps/web/public/guides/`, `apps/web/public/email/`, and the words in each guide's `page.tsx` | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |
| blocklyd, the daemon that runs servers on a fleet's own hosts | [cubepals/blocklyd](https://github.com/cubepals/blocklyd) | [FSL-1.1-ALv2](https://github.com/cubepals/blocklyd/blob/main/LICENSE.md) from 0.3.0; each version becomes Apache-2.0 two years after it is published |

`LICENSE` is the AGPL's own text, unchanged. The brand and the site are not offered under it,
and the AGPL's section 7(e) lets the brand's trademarks be kept out of it. Nothing here takes
away a right the AGPL gives you in the code.

blocklyd and the control plane are separate programs that talk only over blocklyd's API. The
control plane's image carries the blocklyd release it pins, with that release's `LICENSE.md`, and
neither licence reaches the other's code. blocklyd 0.2.2 and earlier were published in this
repository under the AGPL and stay under it for whoever has them.

## Running your own

You may run, change and share the code under the AGPL. Before you ship or operate your build,
replace what is kept back:

- the brand: the name, the mark and the files in `brand/`;
- the landing page: `apps/web/src/app/page.tsx` and `apps/web/src/landing/`;
- the pictures in `apps/web/public/imagery/`, `apps/web/public/guides/` and `apps/web/public/email/`,
  some of which the app itself shows (server covers, the sign-in page, every email);
- the guides under `apps/web/src/app/(public)/guides/`.

The rest of the app does not depend on them.

blocklyd is needed only by the `fleet` runtime, servers on hosts you run yourself; the other
runtimes don't use it. The FSL lets you run it for your own servers, but not offer it, or
something built from it, in a commercial service that substitutes for Cubepals' hosting until that
version becomes Apache-2.0.

## Contributing

A change to the code is contributed under the AGPL. A change to the brand or the site is
contributed under [`brand/LICENSE.md`](brand/LICENSE.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

Questions: **legal@cubepals.com**.
