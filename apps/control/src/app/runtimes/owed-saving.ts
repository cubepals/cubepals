// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Saving put back on where a snapshot's `save-on` didn't get through. It wraps the console every
 * caller shares; pausing saving around a snapshot is `world-copies.ts`'s.
 */
import { SAVE_OFF, SAVE_ON } from '../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../ports/minecraft.ts'

/**
 * `inner`, where whatever asks a server owed a `save-on` anything next, in this process, sends it
 * first. Kept in memory: a game that restarts saves on its own again, and a server this process
 * forgot on restarting gets it with its next snapshot.
 */
export function keepingSaving(inner: ServerConsole): ServerConsole {
  /** Consoles owed a `save-on`, as the RCON lock names them. */
  const owed = new Set<string>()
  const keyOf = (target: ConsoleTarget) => `${target.endpoint.host}:${target.endpoint.port}`
  /**
   * A `save-on` that failed is owed; one that got through settles it, and so does a `save-off`
   * that did: a snapshot has paused saving on purpose, and turns it back on itself.
   */
  const heard = (target: ConsoleTarget, commands: readonly string[], got: readonly boolean[]) => {
    commands.forEach((command, index) => {
      if (command === SAVE_ON && !got[index]) owed.add(keyOf(target))
      else if ((command === SAVE_ON || command === SAVE_OFF) && got[index]) owed.delete(keyOf(target))
    })
  }
  const owedFirst = async (target: ConsoleTarget, commands: readonly string[]) => {
    if (commands.includes(SAVE_ON) || !owed.has(keyOf(target))) return
    await inner.run(target, SAVE_ON).then(
      () => owed.delete(keyOf(target)),
      () => undefined,
    )
  }
  return {
    async run(target, command) {
      await owedFirst(target, [command])
      return inner.run(target, command).then(
        (output) => {
          heard(target, [command], [true])
          return output
        },
        (error: unknown) => {
          heard(target, [command], [false])
          throw error
        },
      )
    },
    async runAll(target, commands, options) {
      await owedFirst(target, commands)
      const results = await inner.runAll(target, commands, options)
      heard(
        target,
        commands,
        results.map((result) => result.ok),
      )
      return results
    },
  }
}
