// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The road a change takes to production, from its paths, and that every doubt takes the whole road. */
import { describe, expect, test } from 'bun:test'
import { areaOf, besideTheWebsite, describeRoute, routeOf } from './production-route.ts'

const route = (...paths: string[]) => routeOf(paths).route

describe('a change to one area takes that area’s road', () => {
  test('prose and tests deploy nothing', () => {
    expect(route()).toBe('none')
    expect(route('docs/production.md', 'README.md', 'brand/README.md', 'apps/control/README.md')).toBe('none')
    expect(route('apps/control/src/app/billing/service.test.ts', 'scripts/staging.test.ts')).toBe('none')
    expect(route('apps/web/src/ui/plans.test.tsx', '.github/settings/rulesets/production.json')).toBe('none')
  })

  test('the website’s own code is the website, its tests and docs beside it', () => {
    expect(route('apps/web/src/ui/plans.tsx')).toBe('website')
    expect(route('apps/web/next.config.ts', 'apps/web/public/guides/x/step.png', 'docs/web.md')).toBe(
      'website',
    )
    expect(route('apps/web/src/ui/plans.tsx', 'apps/web/src/ui/plans.test.tsx')).toBe('website')
  })

  test('what control and realtime are built from is control', () => {
    expect(route('apps/control/src/app/billing/service.ts')).toBe('control')
    expect(route('infra/fly/realtime.toml', 'apps/control/Dockerfile')).toBe('control')
    // The control image copies the reporter plugin and the lockup the emails use.
    expect(route('apps/reporter/src/main/java/Reporter.java')).toBe('control')
    expect(route('brand/png/lockup-horizontal.png')).toBe('control')
  })

  test('what the edge is built from is the edge', () => {
    expect(route('apps/edge/router.ts')).toBe('edge')
    expect(route('apps/edge/Dockerfile', 'infra/fly/edge.toml', 'apps/edge/README.md')).toBe('edge')
  })
})

describe('anything wider, or unknown, takes the whole road', () => {
  test('migrations, packages, dependencies, Terraform, workflows and deploy scripts', () => {
    for (const path of [
      'packages/db/migrations/0112_x.sql',
      'packages/contracts/src/agreements.ts',
      'bun.lock',
      'package.json',
      'apps/web/package.json',
      'bunfig.toml',
      'infra/terraform/modules/web/main.tf',
      '.github/workflows/ci.yml',
      'scripts/production.ts',
      'scripts/lib/web-worker.ts',
      'apps/web/wrangler.jsonc',
    ])
      expect({ path, route: route(path) }).toEqual({ path, route: 'full' })
  })

  test('the website’s runtime (next, the adapter, wrangler) moves only with the lockfile, so never alone', () => {
    expect(route('apps/web/package.json', 'bun.lock')).toBe('full')
  })

  test('a file both Fly images are built from', () => {
    expect(route('apps/control/src/minecraft/ports.ts')).toBe('full')
  })

  test('two areas at once', () => {
    expect(route('apps/web/src/ui/plans.tsx', 'apps/control/src/app/billing/service.ts')).toBe('full')
    expect(route('apps/control/src/main.node.ts', 'apps/edge/router.ts')).toBe('full')
    expect(route('apps/web/src/ui/plans.tsx', 'apps/edge/router.ts', 'docs/x.md')).toBe('full')
  })

  test('a path no rule names', () => {
    expect(route('tools/openapi/package-lock.json')).toBe('full')
    expect(route('experimental/thing.ts')).toBe('full')
    expect(route('Makefile')).toBe('full')
    expect(route('.github/second-eye.schema.json')).toBe('full')
    expect(areaOf('apps/devtools/server.ts')).toEqual({ area: 'full', why: 'no narrower road knows it' })
  })
})

test('the summary names the route and the paths behind each area', () => {
  const lines = describeRoute(routeOf(['apps/web/src/a.tsx', 'apps/control/src/b.ts', 'docs/c.md']))
  expect(lines[0]).toBe('Route: full.')
  expect(lines).toContain('  website: apps/web/src/a.tsx')
  expect(lines).toContain('  control: apps/control/src/b.ts')
  expect(lines).toContain('  none: docs/c.md')
})

describe('what stops the website going alone (production.ts web) agrees with the route', () => {
  test('a test or prose beside the Fly apps’ code is nothing, as it is to the route', () => {
    const paths = ['apps/control/src/app/billing/charges.test.ts', 'docs/x.md', 'apps/web/src/legal/terms.ts']
    expect(route(...paths)).toBe('website')
    expect(besideTheWebsite(paths)).toEqual({ terraform: [], fly: [] })
  })

  test('what a Fly image is built from, or Terraform, still stops it', () => {
    expect(
      besideTheWebsite([
        'apps/web/src/legal/terms.ts',
        'apps/control/src/app/billing/service.ts',
        'infra/terraform/modules/web/main.tf',
      ]),
    ).toEqual({
      terraform: ['infra/terraform/modules/web/main.tf'],
      fly: ['apps/control/src/app/billing/service.ts'],
    })
  })
})
