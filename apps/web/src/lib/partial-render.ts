// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a page that fell back to less than it should show tells the Worker, so the edge doesn't keep
 * it (edge-cache.ts). A server component can't set a response header in Next, so the Worker runs
 * the render inside a store (`markingPartial`) and the page marks it (`markPartial`), as
 * lib/plans.ts does when the plans can't be read; the Worker then puts `PARTIAL` on the response.
 * Not for a page's own state, and a no-op outside the Worker, where nothing is kept.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** On a response the Worker's render made from a page that fell back; never sent to a browser. */
export const PARTIAL = 'x-blockly-partial'

/** The Worker's bundle and Next's server bundle each load this file, so the store is shared by key. */
const STORE = Symbol.for('blockly.partial-render')
const shared = globalThis as Record<symbol, AsyncLocalStorage<{ partial: boolean }> | undefined>
const renders = shared[STORE] ?? new AsyncLocalStorage<{ partial: boolean }>()
shared[STORE] = renders

/** The render under way fell back to less than it should show: it won't be kept. */
export function markPartial(): void {
  const render = renders.getStore()
  if (render) render.partial = true
}

/** `render`'s response, marked `PARTIAL` when a page under it called `markPartial`. */
export async function markingPartial(render: () => Promise<Response>): Promise<Response> {
  const state = { partial: false }
  const response = await renders.run(state, render)
  if (!state.partial) return response
  const headers = new Headers(response.headers)
  headers.set(PARTIAL, '1')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
