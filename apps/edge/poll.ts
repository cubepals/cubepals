// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asking the control plane for routes (`edge-poll.ts`): the list comes only when it changed, and
 * the ETag sent back is the edge's word that it holds every route of that list, so it is kept only
 * once the list is applied, and given at once by asking again.
 *
 * Not for applying a list, which the caller does (`router.ts`).
 */
import type { EdgeRoutes } from '@blockly/contracts/edge'

export class RoutesPoll {
  /** Asks for the routes with these headers. */
  readonly #ask: (headers: Record<string, string>) => Promise<Response>
  /** Applies a list the control plane sent; whether every route of it is held. */
  readonly #take: (routes: EdgeRoutes['routes']) => Promise<boolean>
  /** The ETag of the list every route of which is held, if one is. */
  #held: string | null = null

  constructor(
    ask: (headers: Record<string, string>) => Promise<Response>,
    take: (routes: EdgeRoutes['routes']) => Promise<boolean>,
  ) {
    this.#ask = ask
    this.#take = take
  }

  /** Asks once, and applies the list if it changed; whether it did and is held now. */
  async sync(): Promise<boolean> {
    const response = await this.#ask(this.#held === null ? {} : { 'if-none-match': this.#held })
    if (response.status === 304) return false
    if (!response.ok) throw new Error(`routes answered ${response.status}`)
    const { routes } = (await response.json()) as EdgeRoutes
    if (!(await this.#take(routes))) return false
    this.#held = response.headers.get('etag')
    return true
  }

  /** Something it held was lost, as a route mc-router refused: the next ask fetches the list again. */
  forget(): void {
    this.#held = null
  }
}
