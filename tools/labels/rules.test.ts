// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { areaOf, decide, generatedMatchers, LABELS, missing, RENAMES, sizeOf } from './rules.ts'

const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions })
const pr = (title: string, paths: string[], author = 'someone') => ({
  title,
  author,
  files: paths.map((p) => file(p)),
})

describe('areas', () => {
  test.each([
    ['apps/control/src/minecraft/arcade/hub.ts', 'area/minecraft'],
    ['apps/control/src/app/billing/ending.ts', 'area/billing'],
    ['apps/control/src/infra/fly/fly-runtime.ts', 'area/fleet'],
    ['apps/control/src/app/edge/service.ts', 'area/edge'],
    ['packages/contracts/src/edge.ts', 'area/edge'],
    ['apps/control/src/app/realtime/hub.ts', 'area/realtime'],
    ['packages/db/migrations/0089_job_claims.sql', 'area/db'],
    ['apps/web/src/landing/README.md', 'area/web'],
    ['docs/production.md', 'area/docs'],
    ['AGENTS.md', 'area/docs'],
    ['scripts/production.ts', 'area/infra'],
    ['scripts/check-mentions.ts', 'area/ci'],
    ['scripts/lib/arcade-brand.ts', 'area/minecraft'],
    ['scripts/ops.ts', 'area/scripts'],
    ['tools/labels/rules.ts', 'area/ci'],
    ['tools/openapi/openapi.ts', 'area/devtools'],
    ['tsconfig.base.json', 'area/ci'],
  ])('%s is %s', (path, area) => expect(areaOf(path)).toBe(area as never))

  test('the structure ratchet and lockfile ride along', () => {
    const d = decide(
      pr('Let a server use its own icon', [
        'apps/web/src/lib/own-icon.ts',
        'scripts/structure-baseline.json',
        'bun.lock',
      ]),
    )
    expect(d.areas).toEqual(['area/web'])
  })

  test('a lockfile alone still has an area', () => {
    expect(decide(pr('Bump the bun group with 3 updates', ['bun.lock'], 'dependabot[bot]')).areas).toEqual([
      'area/ci',
    ])
  })
})

describe('size', () => {
  test('Kubernetes thresholds', () => {
    expect([0, 9, 10, 29, 30, 99, 100, 499, 500, 999, 1000].map(sizeOf)).toEqual([
      'size/XS',
      'size/XS',
      'size/S',
      'size/S',
      'size/M',
      'size/M',
      'size/L',
      'size/L',
      'size/XL',
      'size/XL',
      'size/XXL',
    ])
  })

  test('generated files are not counted', () => {
    const gen = generatedMatchers(
      '# comment\npackages/db/migrations/meta/** linguist-generated\nbun.lock linguist-generated\n',
    )
    const d = decide(
      {
        title: 'Add a column',
        author: 'someone',
        files: [
          file('packages/db/migrations/meta/0090_snapshot.json', 8000),
          file('packages/db/migrations/0090_x.sql', 5),
        ],
      },
      gen,
    )
    expect(d.lines).toBe(5)
    expect(d.size).toBe('size/XS')
  })
})

describe('kind', () => {
  test.each([
    ['Bump the bun group with 3 updates', ['bun.lock'], 'dependabot[bot]', 'kind/deps', true],
    ['Run blocklyd 0.3.3 on the fleet', ['apps/control/Dockerfile'], 'someone', 'kind/deps', true],
    ['Move: split the edge agent', ['apps/edge/agent.ts'], 'someone', 'kind/refactor', true],
    ['Add a rule for PR titles', ['AGENTS.md'], 'someone', 'kind/docs', true],
    [
      'Assign each pull request to its author',
      ['.github/workflows/pr-assignee.yml'],
      'someone',
      'kind/chore',
      true,
    ],
    [
      'Fix Boat servers stuck loading the world',
      ['apps/control/src/infra/boat/boat.ts'],
      'someone',
      'kind/bug',
      true,
    ],
    ['Cut database egress', ['apps/control/src/infra/pg/jobs.ts'], 'someone', 'kind/perf', false],
    ['Keep the edge answering on a bad connection', ['apps/edge/agent.ts'], 'someone', 'kind/bug', false],
    [
      'Let an owner upload their own datapack',
      ['apps/web/src/app/page.tsx'],
      'someone',
      'kind/feature',
      false,
    ],
  ])('%s', (title, paths, author, kind, sure) => {
    const d = decide(pr(title, paths, author))
    expect([d.kind, d.kindSure]).toEqual([kind as never, sure])
  })
})

describe('impact and risk', () => {
  test('CI and docs alone are internal, for sure', () => {
    const d = decide(
      pr('Assign each pull request to its author', ['.github/workflows/pr-assignee.yml', 'docs/x.md']),
    )
    expect([d.impact, d.impactSure]).toEqual(['impact/internal', true])
  })

  test('tests alone are internal', () => {
    expect(
      decide(
        pr('Tail before start in the Docker logs gone test', [
          'apps/control/src/infra/docker/docker-logs.test.ts',
        ]),
      ).impact,
    ).toBe('impact/internal')
  })

  test('a migration, billing and the edge', () => {
    const d = decide(
      pr('End Plus after a refund', [
        'packages/db/migrations/0091_x.sql',
        'apps/control/src/app/billing/ending.ts',
        'apps/edge/agent.ts',
      ]),
    )
    expect(d.risks).toEqual(['risk/migration', 'risk/billing', 'risk/staging'])
  })
})

describe('the required check', () => {
  test('one kind, an area, one size', () => {
    expect(missing(['kind/bug', 'area/web', 'size/S'])).toEqual([])
    expect(missing(['area/web', 'size/S'])).toEqual(['a kind/ label'])
    expect(missing(['kind/bug', 'kind/feature', 'area/web', 'size/S'])).toEqual(['one kind/ label, not 2'])
    expect(missing(['kind/bug', 'size/S', 'size/M'])).toEqual(['an area/ label', 'one size/ label'])
  })
})

describe('the label set', () => {
  test('names are unique and colours are six hex digits', () => {
    expect(new Set(LABELS.map((l) => l.name)).size).toBe(LABELS.length)
    for (const l of LABELS) expect(l.color).toMatch(/^[0-9a-f]{6}$/)
    for (const l of LABELS) expect(l.description.length).toBeLessThanOrEqual(100)
  })

  test('every rename lands on a label in the set', () => {
    for (const to of Object.values(RENAMES)) expect(LABELS.some((l) => l.name === to)).toBe(true)
  })
})
