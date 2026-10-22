// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `terraform plan` for each environment against its committed example config, with no cloud
 * credentials: state is local and empty, nothing is refreshed, and the providers get stand-in
 * tokens. A variable the stack reads and the config doesn't give, or a secret it indexes that an
 * environment leaves out, fails here and not at the next apply (2026-10-22: FLOODGATE_KEY became
 * optional while the stack still read it as required, and production's plan failed).
 *
 *   bun scripts/terraform-plan.ts [staging|production]
 *
 * Each environment is planned twice: with only the secrets in `secret_names`, as an environment
 * that turned nothing optional on gives them, and with every optional one too. Terraform must be
 * on the PATH. The plan is never applied.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const ENVIRONMENTS = ['staging', 'production']
const EXAMPLE = 'config.auto.tfvars.example.json'
/** What the environment's files add to the stack: a local backend in place of its R2 one. */
const OVERRIDE = 'plan_override.tf'

interface Example {
  secret_names: string[]
  optional_secret_names?: string[]
}

const stamp = (character: string) => character.repeat(32)

function terraform(directory: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  const run = spawnSync('terraform', [`-chdir=${directory}`, ...args], { env, stdio: 'inherit' })
  return run.status === 0
}

/** The names each as `value`: the secrets, and their versions. */
const named = (names: string[], value: string) =>
  JSON.stringify(Object.fromEntries(names.map((n) => [n, value])))

function plan(environment: string): boolean {
  const directory = join(ROOT, 'infra/terraform/environments', environment)
  const example = JSON.parse(readFileSync(join(directory, EXAMPLE), 'utf8')) as Example
  const override = join(directory, OVERRIDE)
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    TF_IN_AUTOMATION: '1',
    TF_VAR_cloudflare_account_id: stamp('0'),
    TF_VAR_cloudflare_zone_id: stamp('1'),
    TF_VAR_database_dumps_bucket: 'stand-in',
    FLY_API_TOKEN: 'stand-in',
    CLOUDFLARE_API_TOKEN: 'stand-in',
  }
  writeFileSync(override, 'terraform {\n  backend "local" {}\n}\n')
  try {
    if (!terraform(directory, ['init', '-reconfigure', '-input=false'], base)) return false
    let ok = true
    for (const [scenario, names] of [
      ['required secrets only', example.secret_names],
      ['every secret', [...example.secret_names, ...(example.optional_secret_names ?? [])]],
    ] as const) {
      process.stdout.write(`\n== ${environment}: ${scenario}\n`)
      const env = {
        ...base,
        TF_VAR_secrets: named(names, 'stand-in'),
        TF_VAR_secret_versions: named(names, 'v1'),
        // Billing is all of Polar's values or none of them.
        TF_VAR_operator_settings: names.includes('POLAR_ACCESS_TOKEN')
          ? '{"POLAR_PRODUCTS":"stand-in"}'
          : '{}',
      }
      const planned = terraform(
        directory,
        ['plan', '-refresh=false', '-lock=false', '-input=false', '-no-color', `-var-file=${EXAMPLE}`],
        env,
      )
      ok = planned && ok
    }
    return ok
  } finally {
    if (existsSync(override)) rmSync(override)
  }
}

if (import.meta.main) {
  const wanted = process.argv.slice(2)
  const results = (wanted.length > 0 ? wanted : ENVIRONMENTS).map(
    (environment) => [environment, plan(environment)] as const,
  )
  for (const [environment, ok] of results)
    process.stdout.write(`${environment}: ${ok ? 'plans' : 'FAILS to plan'}\n`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}
