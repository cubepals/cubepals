# Licensing

Copyright (C) 2026 The Cubepals Authors.

Cubepals is open source under the AGPL, with two exceptions: the brand and the site are kept
back, and blocklyd, the node daemon, is in its own repository under the Functional Source
License. A few files are other people's and stay under their own licences.

| What | Where | Licence |
| --- | --- | --- |
| The code: the control plane, the web app, the edge, the packages, the scripts and the infrastructure | everything not listed below | [AGPL-3.0-only](LICENSE) |
| The brand: the Cubepals name, mark and wordmark | [`brand/`](brand/), and the copies the app serves: `apps/web/src/app/icon.svg`, `apple-icon.png`, `apps/web/public/logo.png`, the server icon `blockly` | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |
| The site: the landing page, the site's pictures and the guides' words | `apps/web/src/app/page.tsx`, `apps/web/src/landing/` (except `type/` and `fonts.ts`), `apps/web/public/imagery/`, `apps/web/public/guides/`, the pictures in `apps/web/public/email/`, the site's preview image, and each guide's `page.tsx` | All rights reserved, [`brand/LICENSE.md`](brand/LICENSE.md) |
| Typefaces: Press Start 2P, IBM Plex | `apps/web/src/landing/type/`, `docs/architecture/fonts/` | [OFL-1.1](LICENSES/OFL-1.1.txt), their authors' |
| API descriptions and the types generated from them: Fly's Machines API, Hangar, Modrinth | `apps/control/src/infra/{fly,hangar,modrinth}/` | Apache-2.0, MIT and CC0-1.0, their authors' |
| AOneBlock's settings, with one change | `apps/control/src/app/setups/aoneblock-config.yml` | [EPL-2.0](LICENSES/EPL-2.0.txt), AOneBlock's authors' |
| BSkyBlock's settings, with one change | `apps/control/src/app/setups/bskyblock-config.yml` | [EPL-2.0](LICENSES/EPL-2.0.txt), BSkyBlock's authors' |
| Boat's API description, Hangar's recorded answers, Supabase's root certificate | `apps/control/src/infra/boat/`, `apps/control/src/infra/hangar/fixtures/`, `packages/db/certs/` | Their owners' terms, no licence from us |
| blocklyd's API description and Docker settings, copied from the release this repository pins | `apps/control/src/infra/fleet/` (the `.json` files and `generated/`) | [FSL-1.1-ALv2](LICENSES/FSL-1.1-ALv2.txt) |
| blocklyd, the daemon that runs servers on a fleet's own hosts | [cubepals/blocklyd](https://github.com/cubepals/blocklyd) | [FSL-1.1-ALv2](https://github.com/cubepals/blocklyd/blob/main/LICENSE.md) from 0.3.0; each version becomes Apache-2.0 two years after it is published |

Each file says which of these it is under, in its own SPDX lines or in [REUSE.toml](REUSE.toml),
as [REUSE](https://reuse.software) asks; [`LICENSES/`](LICENSES/) holds each licence's text, and CI
runs `reuse lint`. `LicenseRef-Cubepals-Reserved` is the brand and the site,
`LicenseRef-Upstream-Terms` the files under their owners' terms.

`LICENSE` is the AGPL's own text, unchanged. The brand and the site are not offered under it.
Nothing here takes away a right the AGPL gives you in the code.

blocklyd and the control plane are separate programs that talk only over blocklyd's API. The
control plane's image carries the blocklyd release it pins, with that release's `LICENSE.md`, and
neither licence reaches the other's code. blocklyd 0.2.2 and earlier were published in this
repository under the AGPL and stay under it for whoever has them.

## Additional terms

Under section 7(e) of the AGPL, the licence of the code grants no rights under trademark law in
the Cubepals name, mark or wordmark. You may say truthfully that your work is based on Cubepals;
you may not name or brand it Cubepals.

## Running your own

You may run, change and share the code under the AGPL. Before you ship or operate your build,
replace what is kept back:

- the brand: the name, the mark and the files in `brand/`, and the copies listed above;
- the landing page: `apps/web/src/app/page.tsx` and `apps/web/src/landing/`;
- the pictures in `apps/web/public/imagery/`, `apps/web/public/guides/` and `apps/web/public/email/`,
  some of which the app itself shows (server covers, the sign-in page, every email);
- the guides under `apps/web/src/app/(public)/guides/`;
- the legal pages' operator details in `apps/web/src/legal/operator.ts`: who runs the service,
  where, under which law, and its email addresses;
- the domains: `cubepals.com` and the names under it, in `operator.ts`, the environment
  (`PLAY_DOMAIN` and the rest, [`docs/configuration.md`](docs/configuration.md)) and `infra/`.

The rest of the app does not depend on them.

blocklyd is needed only by the `fleet` runtime, servers on hosts you run yourself; the other
runtimes don't use it. The FSL lets you run it for your own servers, but not offer it, or
something built from it, in a commercial service that substitutes for Cubepals' hosting until that
version becomes Apache-2.0.

## Contributing

A change to the code is contributed under the AGPL. A change to the brand or the site is
contributed under [`brand/LICENSE.md`](brand/LICENSE.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

Questions: **legal@cubepals.com**.
