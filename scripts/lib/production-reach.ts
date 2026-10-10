// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production's operators' API reached from this machine, for `scripts/ops.ts --production` and
 * `scripts/production-check.ts`: `fly proxy` to the api role's internal listener on
 * bly-prod-control, with production's own Fly token, and production's OPERATOR_TOKEN, both read
 * from local/production/production.env (`production-values.ts`). Neither is printed. A shell's own
 * FLY_ACCESS_TOKEN, staging's in a shell set up for it, never reaches flyctl here.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseValues, VALUES_FILE } from '../production-values.ts'

const PRODUCTION_CONTROL = 'bly-prod-control'
/** The api role's internal listener, as infra/fly/control.toml's INTERNAL_LISTEN sets it. */
const INTERNAL_PORT = 4001

/** The environment flyctl runs in for production: its token, and no other. */
export function productionFlyEnv(): NodeJS.ProcessEnv {
  const values = productionValues()
  if (!values.FLY_API_TOKEN) throw new Error(`${VALUES_FILE} has no FLY_API_TOKEN.`)
  const env: NodeJS.ProcessEnv = { ...process.env, FLY_API_TOKEN: values.FLY_API_TOKEN }
  delete env.FLY_ACCESS_TOKEN
  return env
}

export function productionValues(): Record<string, string> {
  if (!existsSync(VALUES_FILE))
    throw new Error(`There is no ${VALUES_FILE}: production's values live there (docs/production.md).`)
  return parseValues(readFileSync(VALUES_FILE, 'utf8'))
}

/**
 * Opens the proxy, and points the operator CLI's calls at it (OPERATOR_API and OPERATOR_TOKEN in
 * this process's environment) until the process exits.
 */
export async function reachProduction(): Promise<void> {
  const token = productionValues().OPERATOR_TOKEN
  if (!token)
    throw new Error(`${VALUES_FILE} has no OPERATOR_TOKEN: run bun scripts/production.ts init, then apply.`)
  const port = 14_000 + Math.floor(Math.random() * 1000)
  const host = `api.process.${PRODUCTION_CONTROL}.internal`
  const proxy = spawn('fly', ['proxy', `${port}:${INTERNAL_PORT}`, host, '-a', PRODUCTION_CONTROL], {
    stdio: 'ignore',
    env: productionFlyEnv(),
  })
  process.on('exit', () => proxy.kill())
  const base = `http://127.0.0.1:${port}`
  // Asked without the token, the operators' API refuses: that is the answer that says it is there.
  for (let tries = 0; tries < 60; tries++) {
    const status = await fetch(`${base}/ops/v1/accounts`).then(
      (response) => response.status,
      () => 0,
    )
    if (status === 401) {
      process.env.OPERATOR_API = base
      process.env.OPERATOR_TOKEN = token
      return
    }
    if (status === 404)
      throw new Error(
        `${PRODUCTION_CONTROL} has no operators' API: apply production with OPERATOR_TOKEN first.`,
      )
    await Bun.sleep(1000)
  }
  proxy.kill()
  throw new Error(`fly proxy to ${host}:${INTERNAL_PORT} never answered.`)
}
