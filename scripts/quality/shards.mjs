// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The existing CI test groups, with an exhaustive remainder for newly added tests. */
export const groups = {
  lifecycle: ['apps/control/src/app/operations/'],
  providers: [
    'apps/control/src/infra/fly/',
    'apps/control/src/infra/docker/',
    'apps/control/src/infra/boat/',
    'apps/control/src/infra/fleet/',
    'apps/control/src/infra/s3/',
    'apps/control/src/app/runtimes/',
  ],
  worlds: [
    'apps/control/src/app/backups/',
    'apps/control/src/app/revisions/',
    'apps/control/src/app/worlds/',
    'apps/control/src/app/servers/',
    'apps/control/src/app/setups/',
    'apps/control/src/app/console/',
    'apps/control/src/app/players/',
    'apps/control/src/app/uploads/',
    'apps/control/src/app/artifacts/',
  ],
  mods: [
    'apps/control/src/app/mods/',
    'apps/control/src/app/packs/',
    'apps/control/src/app/curation/',
    'apps/control/src/app/listings/',
  ],
  access: [
    'apps/control/src/app/access/',
    'apps/control/src/app/compat/',
    'apps/control/src/app/edge/',
    'apps/control/src/app/joins/',
    'apps/control/src/app/moderation/',
    'apps/control/src/app/platform/',
    'apps/control/src/app/policy/',
    'apps/control/src/app/stop-cheaters/',
  ],
  web: ['apps/web/', 'apps/edge/', 'scripts/'],
  rest: [],
}

export function groupOf(file) {
  return (
    Object.entries(groups).find(([, prefixes]) => prefixes.some((prefix) => file.startsWith(prefix)))?.[0] ??
    'rest'
  )
}
