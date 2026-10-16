// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asking the control plane for routes (`edge-poll.ts`): the list comes only when it changed, with
 * its version. The version said back is the edge's word that it holds every route of that list, so
 * it is kept only once the list is applied, and given at once by asking again.
 *
 * Not for applying a list, which the caller does (`router.ts`).
 */
import type { EdgeRoutes } from '@blockly/contracts/edge'
import { ROUTES_HELD_HEADER, ROUTES_VERSION_HEADER } from '../../packages/contracts/src/edge-poll.ts'

export class RoutesPoll {
  /** Asks for the routes with these headers. */
  readonly #ask: (headers: Record<string, string>) => Promise<Response>
  /** Applies a list the control plane sent; whether every route of it is held. */
  readonly #take: (list: EdgeRoutes) => Promise<boolean>
  /** The ETag of the list every route of which is held, if one is: it spares sending it again. */
  #etag: string | null = null
  /** The version of the newest list every route of which was held. */
  #version: string | null = null

  constructor(
    ask: (headers: Record<string, string>) => Promise<Response>,
    take: (list: EdgeRoutes) => Promise<boolean>,
  ) {
    this.#ask = ask
    this.#take = take
  }

  /** Asks once, and applies the list if it changed; whether it did and is held now. */
  async sync(): Promise<boolean> {
    const response = await this.#ask({
      ...(this.#etag === null ? {} : { 'if-none-match': this.#etag }),
      ...(this.#version === null ? {} : { [ROUTES_HELD_HEADER]: this.#version }),
    })
    if (response.status === 304) return false
    if (!response.ok) throw new Error(`routes answered ${response.status}`)
    if (!(await this.#take((await response.json()) as EdgeRoutes))) return false
    this.#etag = response.headers.get('etag')
    this.#version = response.headers.get(ROUTES_VERSION_HEADER)
    return true
  }

  /**
   * Something it held was lost, as a route mc-router refused: the next ask fetches the list again.
   * The version it said stays: a newer one is said only once a newer list is held whole.
   */
  forget(): void {
    this.#etag = null
  }
}
