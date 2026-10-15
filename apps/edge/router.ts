// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * mc-router's routes, changed one hostname at a time through its API (`-api-binding`).
 *
 * mc-router's routes file is read whole: a reload empties its table and fills it again, and a
 * player who arrives in between finds no route and is closed without a word. Through the API a
 * route is added, replaced or removed on its own, each in one step, so a hostname that routes
 * keeps routing while others change, and a change costs the same however many servers there are.
 *
 * Not for deciding where a hostname goes (`mappings.ts`).
 */

/** How many changes go to mc-router at once while many are waiting, as after a start. */
const AT_ONCE = 16

/** What one change asks of mc-router: a hostname to route to a backend, or to route no more. */
type Change = { hostname: string; backend: string } | { hostname: string; backend: null }

/** The changes that turn the table `held` into `wanted`. */
export function changes(
  held: ReadonlyMap<string, string>,
  wanted: Readonly<Record<string, string>>,
): Change[] {
  const out: Change[] = []
  for (const [hostname, backend] of Object.entries(wanted))
    if (held.get(hostname) !== backend) out.push({ hostname, backend })
  for (const hostname of held.keys())
    if (!Object.hasOwn(wanted, hostname)) out.push({ hostname, backend: null })
  return out
}

export class RouterRoutes {
  readonly #api: string
  /** What mc-router holds, as far as it has said so. */
  readonly #held = new Map<string, string>()
  /** The table last asked for, and the apply under way, if any. */
  #wanted: Record<string, string> | null = null
  #applying: Promise<void> | null = null

  /** `api` is mc-router's API, as `http://127.0.0.1:port`. */
  constructor(api: string) {
    this.#api = api
  }

  /**
   * Waits for mc-router's API to answer, then gives a hostname it holds no route for to the
   * default route with no backend, as its routes file did: mc-router then asks the wake webhook
   * about it, with no address.
   */
  async ready(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const answered = await fetch(`${this.#api}/routes`).then(
        (response) => response.ok,
        () => false,
      )
      if (answered) break
      if (Date.now() >= deadline) throw new Error('mc-router’s API never answered')
      await Bun.sleep(100)
    }
    await this.#send('POST', '/defaultRoute', { backend: '' })
  }

  /**
   * Makes mc-router hold `wanted`, changing only what differs. Resolves once it holds all of it, or
   * a table asked for later; rejects if mc-router refused a change, which the next apply retries.
   */
  apply(wanted: Readonly<Record<string, string>>): Promise<void> {
    this.#wanted = { ...wanted }
    this.#applying ??= this.#drain().finally(() => {
      this.#applying = null
    })
    return this.#applying
  }

  /** Applies the newest table asked for until nothing newer is waiting. */
  async #drain(): Promise<void> {
    while (this.#wanted !== null) {
      const wanted = this.#wanted
      this.#wanted = null
      const pending = changes(this.#held, wanted)
      for (let i = 0; i < pending.length; i += AT_ONCE)
        await Promise.all(pending.slice(i, i + AT_ONCE).map((change) => this.#change(change)))
    }
  }

  async #change(change: Change): Promise<void> {
    if (change.backend === null) {
      await this.#send('DELETE', `/routes/${encodeURIComponent(change.hostname)}`)
      this.#held.delete(change.hostname)
    } else {
      await this.#send('POST', '/routes', { serverAddress: change.hostname, backend: change.backend })
      this.#held.set(change.hostname, change.backend)
    }
  }

  async #send(method: string, path: string, body?: object): Promise<void> {
    const response = await fetch(`${this.#api}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(5_000),
    })
    // A route already gone is gone.
    if (!response.ok && !(method === 'DELETE' && response.status === 404))
      throw new Error(`mc-router answered ${response.status} to ${method} ${path}`)
  }
}
