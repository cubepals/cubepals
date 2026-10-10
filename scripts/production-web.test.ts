// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which paths reach production by which road: the website alone, or a hotfix's Fly apps. */
import { describe, expect, test } from 'bun:test'
import { appsFor, flyInputs, reachesWebsite, terraformIn } from './production-web.ts'

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

describe('what a hotfix deploys', () => {
  test('only the Fly apps the change is built into, control first', () => {
    expect(appsFor(['apps/edge/src/main.ts'])).toEqual(['edge'])
    expect(appsFor(['apps/control/src/app/billing/service.ts'])).toEqual(['control', 'realtime'])
    expect(appsFor(['packages/db/src/schema/billing.ts'])).toEqual(['control', 'realtime', 'edge'])
    expect(appsFor(['infra/fly/realtime.toml'])).toEqual(['realtime'])
    expect(appsFor(['apps/web/src/ui/plans.tsx', 'docs/production.md'])).toEqual([])
  })

  test('the website is built when its code or a package changed', () => {
    expect(reachesWebsite(['apps/web/src/ui/plans.tsx'])).toBe(true)
    expect(reachesWebsite(['packages/contracts/src/agreements.ts'])).toBe(true)
    expect(reachesWebsite(['apps/control/src/main.node.ts'])).toBe(false)
  })

  test('Terraform is named, so a hotfix can refuse it', () => {
    expect(terraformIn(['infra/terraform/modules/dns/main.tf', 'apps/web/x.ts'])).toEqual([
      'infra/terraform/modules/dns/main.tf',
    ])
  })
})
