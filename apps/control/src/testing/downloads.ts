// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserActor } from '../app/actor.ts'
import type { ControlPlane } from '../app/control-plane.ts'

/**
 * What an archive's owner downloads: asked for, waited on while a worker makes it, and fetched
 * by its link, as the backups page does.
 */
export async function downloaded(
  app: ControlPlane,
  actor: UserActor,
  serverId: string,
  backupId: string,
): Promise<Uint8Array> {
  let state = await app.backups.downloads.ask(actor, serverId, backupId)
  const deadline = Date.now() + 30_000
  while (state.status === 'making' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    state = await app.backups.downloads.state(actor, serverId, backupId)
  }
  if (state.status !== 'ready') throw new Error(`The download is ${JSON.stringify(state)}`)
  const response = await fetch(state.url)
  if (!response.ok) throw new Error(`Its link answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
