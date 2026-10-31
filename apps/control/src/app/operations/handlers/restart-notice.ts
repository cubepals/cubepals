// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Word to the players on a server about to reboot under them, for an update (`updating.ts`) and a
 * restart (`bringing-up.ts`): the console turns everyone out with why, and that they can join
 * again. Without it the game's own shutdown drops them with no reason, and they rejoin over and
 * over while it is down. The edge holds those rejoins until the server is back.
 *
 * Best effort, and never in the way: a console that fails is ignored, and one that doesn't answer
 * in `NOTICE_WAIT_MS` is left behind, so the reboot goes ahead as it would have without it.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { kickEveryone } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'

/** What players read as an update reboots the server they are on. */
export const RESTARTING_FOR_A_CHANGE =
  'Cubepals is restarting this server for a change · join again, and you’ll go in as soon as it’s back'

/** What players read as a restart reboots the server they are on. */
export const RESTARTING =
  'Cubepals is restarting this server · join again, and you’ll go in as soon as it’s back'

/** The longest the word to players may hold up a reboot. */
export const NOTICE_WAIT_MS = 5 * SECOND_MS

export type RestartNotice = ReturnType<typeof restartNotice>

export function restartNotice(deps: {
  console: Pick<ServerConsole, 'runAll'>
  /** Where the server's console answers, as `game-console.ts` gives it. */
  consoleTarget: (server: MinecraftServer, handle: RuntimeHandle) => ConsoleTarget
  waitMs?: number
}) {
  const waitMs = deps.waitMs ?? NOTICE_WAIT_MS

  /** Turns everyone on the server out with `reason`; resolves once done, failed or waited out. */
  const sendOff = async (server: MinecraftServer, handle: RuntimeHandle, reason: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    })
    const sent = Promise.resolve()
      .then(() => deps.console.runAll(deps.consoleTarget(server, handle), kickEveryone(reason)))
      .then(
        () => undefined,
        () => undefined,
      )
    try {
      await Promise.race([sent, waited])
    } finally {
      clearTimeout(timer)
    }
  }

  return { sendOff }
}
