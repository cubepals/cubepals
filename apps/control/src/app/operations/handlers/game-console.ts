// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What operations ask of the running game through its console: where it answers, and the save
 * that winds it down before its process goes away, with word to the players first where it is
 * coming back (`restart-notice.ts`). All of it is best effort; the commands themselves are
 * `minecraft/console.ts`'s, and the snapshot that pauses saving around it is `world-copies.ts`'s.
 */
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { SAVE_ALL_FLUSH } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import { restartNotice } from './restart-notice.ts'

export type GameConsole = ReturnType<typeof gameConsole>

export function gameConsole(deps: {
  runtime: Pick<Runtimes, 'endpoint'>
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  console: Pick<ServerConsole, 'run' | 'runAll'>
  access: Pick<AccessReconciler, 'reconcile'>
}) {
  const { runtime, specs } = deps
  const consoleTarget = (server: MinecraftServer, handle: RuntimeHandle) => ({
    endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
    passwords: specs.rconPasswords(server.id),
  })
  const notice = restartNotice({ console: deps.console, consoleTarget })

  /**
   * Saves the world and keeps in-game access changes before the process goes away. Best effort,
   * but says whether the world was saved: a server put to sleep with its memory kept needs it,
   * since a provider may drop that memory and boot from what was saved. Given why it is coming
   * back (`restart-notice.ts`), whoever is on is turned out with it first.
   */
  const windDown = async (server: MinecraftServer, handle: RuntimeHandle, why?: string): Promise<boolean> => {
    if (why !== undefined) await notice.sendOff(server, handle, why)
    await deps.access.reconcile(server, handle, 'import').catch(() => undefined)
    const target = {
      endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: specs.rconPasswords(server.id),
    }
    return deps.console.run(target, SAVE_ALL_FLUSH).then(
      () => true,
      () => false,
    )
  }

  return { consoleTarget, windDown }
}
