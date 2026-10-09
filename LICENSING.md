# Licensing

Cubepals is open source under the AGPL, with one part kept back: the brand and the site.

| What | Where | Licence |
| --- | --- | --- |
| The code: the control plane, the web app, the edge, the packages, the scripts and the infrastructure | everything not listed below | [AGPL-3.0-only](LICENSE) |
| The brand: the Cubepals name, mark and wordmark | [`brand/`](brand/) | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |
| The site: the landing page, the site's pictures and the guides' words | `apps/web/src/landing/` (except `type/` and `fonts.ts`), `apps/web/public/imagery/`, `apps/web/public/guides/`, and the words in each guide's `page.tsx` | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |

`LICENSE` is the AGPL's own text, unchanged. The brand and the site are not offered under it,
and the AGPL's section 7(e) lets the brand's trademarks be kept out of it. Nothing here takes
away a right the AGPL gives you in the code.

## Running your own

You may run, change and share the code under the AGPL. Before you ship or operate your build,
replace what is kept back:

- the brand: the name, the mark and the files in `brand/`;
- the landing page: `apps/web/src/app/page.tsx` and `apps/web/src/landing/`;
- the pictures in `apps/web/public/imagery/` and `apps/web/public/guides/`, some of which the app
  itself shows (server covers, the sign-in page);
- the guides under `apps/web/src/app/(public)/guides/`.

The rest of the app does not depend on them.

## Contributing

A change to the code is contributed under the AGPL. A change to the brand or the site is
contributed under [`brand/LICENSE.md`](brand/LICENSE.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

Questions: **legal@cubepals.com**.
