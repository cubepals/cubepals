// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Classifies requested CI work by runtime risk; execution and evidence use this same decision. */
export function classifyChanges(paths, { full = false } = {}) {
  if (
    !Array.isArray(paths) ||
    paths.some(
      (path) => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'),
    )
  )
    throw new Error('CI requires explicit repository-relative changed paths')
  const relevant = paths.filter((path) => !/^(?:docs\/|brand\/)|\.md$/.test(path))
  const tooling = relevant.some((path) =>
    /^(?:\.github\/(?:workflows|actions)\/|scripts\/quality\/|tools\/quality\/)/.test(path),
  )
  const configuration = relevant.some(
    (path) =>
      /(?:^|\/)(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.jsonc?)$/.test(path) ||
      /^(?:\.node-version|\.bun-version|\.npmrc|docker-compose\.yml)$/.test(path),
  )
  const website = relevant.length > 0 && relevant.every((path) => path.startsWith('apps/web/'))
  const reporter = relevant.some((path) => path.startsWith('apps/reporter/'))
  const terraform = relevant.some((path) => path.startsWith('infra/terraform/'))
  const unknown = relevant.some(
    (path) =>
      !/^(?:apps\/(?:web|control|edge|reporter|devtools)\/|packages\/(?:contracts|db)\/|scripts\/quality\/|tools\/quality\/|infra\/terraform\/|\.github\/(?:workflows|actions)\/)/.test(
        path,
      ) && !configuration,
  )
  const broad = full || tooling || configuration || unknown
  const code =
    broad ||
    terraform ||
    relevant.some((path) => /^(?:apps\/(?!reporter\/)|packages\/|scripts\/|tools\/)/.test(path))
  const control = relevant.some((path) => path.startsWith('apps/control/'))
  const shared = relevant.some((path) => path.startsWith('packages/'))
  const runtime = relevant.some(
    (path) =>
      /^apps\/control\/src\/(?:infra\/(?:fly|fleet|boat|docker)\/|app\/(?:runtimes|operations|servers)\/|minecraft\/)/.test(
        path,
      ) ||
      /^packages\/(?:contracts|db)\/src\/(?:runtime|server|operations|schema\/(?:runtimes|servers))/.test(
        path,
      ),
  )
  return {
    code,
    website,
    broad,
    tooling,
    configuration,
    terraform,
    static: code || terraform,
    worker: broad || website || shared,
    images: broad || control || shared || relevant.some((path) => path.startsWith('apps/edge/')),
    reporter: full || reporter || tooling,
    fleet:
      broad ||
      runtime ||
      terraform ||
      shared ||
      relevant.some(
        (path) =>
          /^scripts\/(?:blocklyd|staging|production)/.test(path) ||
          /^apps\/control\/(?:Dockerfile|src\/testing\/fleet)/.test(path),
      ),
    reasons: [
      ...(full ? ['Complete verification requested'] : []),
      ...(tooling ? ['Quality or workflow implementation changed'] : []),
      ...(configuration ? ['Dependency or execution configuration changed'] : []),
      ...(unknown ? ['Unknown dependency impact requires broader verification'] : []),
      ...(website && !broad ? ['Website dependency closure; backend integration only when imported'] : []),
    ],
  }
}
