import { describe, expect, test } from 'bun:test'
import { flyInputs } from './production-web.ts'

describe('what may go to production as the website alone', () => {
  test('the website, docs, scripts and Terraform are not what the Fly apps are built from', () => {
    expect(
      flyInputs([
        'apps/web/src/ui/plans.tsx',
        'apps/web/src/legal/privacy.ts',
        'docs/production.md',
        'scripts/staging.ts',
        'infra/terraform/modules/web/main.tf',
      ]),
    ).toEqual([])
  })

  test('the control plane, the edge, a shared package, Fly config or the lockfile are', () => {
    expect(
      flyInputs([
        'apps/web/src/app/page.tsx',
        'apps/control/src/main.node.ts',
        'apps/edge/src/main.ts',
        'packages/contracts/src/agreements.ts',
        'infra/fly/control.toml',
        'bun.lock',
        'package.json',
      ]),
    ).toEqual([
      'apps/control/src/main.node.ts',
      'apps/edge/src/main.ts',
      'packages/contracts/src/agreements.ts',
      'infra/fly/control.toml',
      'bun.lock',
      'package.json',
    ])
  })
})
