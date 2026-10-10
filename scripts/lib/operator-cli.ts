/**
 * What the operator CLIs, `fleet.ts`, `runtimes.ts` and `ops.ts`, share: reading their arguments,
 * failing under their own name, and calling their part of the control plane's operator API as the
 * operator. `production-check.ts` calls it too, and has its refusals thrown, so it can clean up
 * after them. Which commands each has, and what they print, is its own.
 */

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
 * and OPERATOR_TOKEN reach it, `docs` says how to get them, and OPERATOR (or USER) is who acted. A
 * call the API refuses exits, unless `refusals` is `throw`: then it throws, with the API's words.
 */
export function operatorCli(name: string, part: string, docs: string, refusals: 'exit' | 'throw' = 'exit') {
  function fail(message: string): never {
    console.error(`${name}: ${message}`)
    process.exit(1)
  }
  const refuse = (message: string): never => {
    if (refusals === 'throw') throw new Error(message)
    return fail(message)
  }

  async function api(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
        'x-operator': process.env.OPERATOR ?? process.env.FLEET_OPERATOR ?? process.env.USER ?? 'unnamed',
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
