// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { API_PORT } from '@blockly/contracts/local'

/**
 * The control plane this web app fronts: server-side only. Local development defaults to the
 * control plane's local listener; every deployed environment sets API_UPSTREAM.
 */
export function apiUpstream(): string {
  const upstream =
    process.env.API_UPSTREAM ??
    (process.env.NODE_ENV === 'production' ? undefined : `http://127.0.0.1:${API_PORT}`)
  if (upstream === undefined)
    throw new Error('API_UPSTREAM must name the control plane the /api rewrite forwards to')
  return upstream.replace(/\/$/, '')
}

/**
 * The most a page's server render waits on one answer from the control plane. Past it the page is
 * sent without that answer, as when the control plane is unreachable: a stopped or waking control
 * plane (a pull request's preview while staging sleeps) never holds a page blank. The /api rewrite,
 * which the browser waits on itself, has no such limit.
 */
export const RENDER_READ_MS = 2_000
