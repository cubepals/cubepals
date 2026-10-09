<p align="center">
  <a href="https://cubepals.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="brand/png/lockup-horizontal-reversed.png">
      <img src="brand/png/lockup-horizontal.png" alt="Cubepals" width="320">
    </picture>
  </a>
</p>

<p align="center"><strong>A Minecraft server that starts when your friends join.</strong></p>

<p align="center">
  <a href="https://cubepals.com">Website</a> ·
  <a href="https://cubepals.com/pricing">Pricing</a> ·
  <a href="https://cubepals.com/guides">Guides</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/cubepals/cubepals/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/cubepals/cubepals/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-181818?style=flat-square" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/Minecraft-Java_Edition-181818?style=flat-square" alt="Minecraft: Java Edition">
</p>

---

Minecraft server hosting that feels simple: create a server, pick a version, optionally add
mods, copy the address and play. It runs at [cubepals.com](https://cubepals.com).

Inside this repository the project goes by its codename, **Blockly**: the packages, the
`blocklyd` daemon, the infrastructure and the code all use it. Cubepals is the name players see.

The design lives in [`docs/architecture.md`](docs/architecture.md). Read it before changing a
boundary. To work on it, start with [CONTRIBUTING.md](CONTRIBUTING.md); running it locally is
[`docs/local-development.md`](docs/local-development.md).

## License

[GNU Affero General Public License v3.0 only](LICENSE). If you run a modified version of
Cubepals as a network service, you must offer its users the source of that version.

The **code** is AGPL. The **brand and the site** are not. The Cubepals name, mark, wordmark
and the files in [`brand/`](brand/) are all rights reserved, and so are the landing page
(`apps/web/src/landing/`), the site's pictures and the guides' words — see
[`brand/LICENSE.md`](brand/LICENSE.md). This takes nothing away from your rights in the rest
of the source. If you fork Cubepals, replace the branding, the landing page, the pictures and
the guides before you ship or operate it.
