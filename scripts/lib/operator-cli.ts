// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the operator CLIs, `fleet.ts`, `runtimes.ts` and `ops.ts`, share: reading their arguments,
 * failing under their own name, and calling their part of the control plane's operator API as the
 * operator. `production-check.ts` calls it too, and has its refusals thrown, so it can clean up
 * after them. Which commands each has, and what they print, is its own.
 */

/** The values that open the operator APIs and Fly: never printed, never answered with. */
const SECRETS = ['OPERATOR_TOKEN', 'FLEET_OPERATOR_TOKEN', 'FLY_API_TOKEN', 'FLY_ACCESS_TOKEN'] as const

/** `text` with every secret this process holds in its environment written as `[secret]`. */
export function withoutSecrets(text: string): string {
  return SECRETS.reduce((clean, name) => {
    const value = process.env[name]
    return value ? clean.replaceAll(value, '[secret]') : clean
  }, text)
}

/** Arguments as positionals and `--name value` options; a bare `--flag` is `'true'`, and options repeat. */
export function flags(args: string[]): { positional: string[]; options: Map<string, string[]> } {
  const positional: string[] = []
  const options = new Map<string, string[]>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = args[i + 1]
    const value = next !== undefined && !next.startsWith('--') ? next : 'true'
    if (value !== 'true' || next === 'true') i++
    options.set(name, [...(options.get(name) ?? []), value])
  }
  return { positional, options }
}

/**
 * A CLI's way out, `fail`, and its calls to the operator API under `part` (`/fleet/v1`). OPERATOR_API
 * and OPERATOR_TOKEN reach it, `docs` says how to get them, and OPERATOR (or USER) is who acted,
 * `unnamed` when neither is set. A call the API refuses exits, unless `refusals` is `throw`: then it
 * throws, with the API's words. What it prints or throws never holds a secret (`withoutSecrets`).
 */
export function operatorCli(
  name: string,
  part: string,
  docs: string,
  refusals: 'exit' | 'throw' = 'exit',
  unnamed = 'unnamed',
) {
  function fail(message: string): never {
    console.error(`${name}: ${withoutSecrets(message)}`)
    process.exit(1)
  }
  const refuse = (message: string): never => {
    if (refusals === 'throw') throw new Error(withoutSecrets(message))
    return fail(message)
  }

  async function api(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
  ): Promise<unknown> {
    const base = process.env.OPERATOR_API ?? process.env.FLEET_API
    const token = process.env.OPERATOR_TOKEN ?? process.env.FLEET_OPERATOR_TOKEN
    if (!base || !token) fail(`set OPERATOR_API and OPERATOR_TOKEN (${docs})`)
    const response = await fetch(`${base.replace(/\/$/, '')}${part}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-operator': process.env.OPERATOR || process.env.FLEET_OPERATOR || process.env.USER || unnamed,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch((error: Error) => refuse(`the operator API doesn't answer: ${error.message}`))
    const answer = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string } | string
    } | null
    if (!response.ok) {
      const error = answer?.error
      refuse(typeof error === 'object' ? `${error.code}: ${error.message}` : `HTTP ${response.status}`)
    }
    return answer
  }

  return { fail, api }
}
