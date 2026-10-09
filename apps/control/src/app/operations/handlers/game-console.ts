/**
 * What operations ask of the running game through its console: where it answers, and the save
 * that winds it down before its process goes away. All of it is best effort; the commands
 * themselves are `minecraft/console.ts`'s, and the snapshot that pauses saving around it is
 * `world-copies.ts`'s.
 */
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { SAVE_ALL_FLUSH } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'

export type GameConsole = ReturnType<typeof gameConsole>

export function gameConsole(deps: {
  runtime: Pick<Runtimes, 'endpoint'>
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  console: Pick<ServerConsole, 'run'>
  access: Pick<AccessReconciler, 'reconcile'>
}) {
  const { runtime, specs } = deps

  /** Saves the world and keeps in-game access changes before the process goes away. Best effort. */
  const windDown = async (server: MinecraftServer, handle: RuntimeHandle) => {
    await deps.access.reconcile(server, handle, 'import').catch(() => undefined)
    const target = {
      endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: specs.rconPasswords(server.id),
    }
    await deps.console.run(target, SAVE_ALL_FLUSH).catch(() => undefined)
  }

  const consoleTarget = (server: MinecraftServer, handle: RuntimeHandle) => ({
    endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
    passwords: specs.rconPasswords(server.id),
  })

  return { consoleTarget, windDown }
}
