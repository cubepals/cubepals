/**
 * Restarts a running world onto a bigger disk as soon as it outgrows its own, telling its players
 * first, on plans whose disks grow. Measuring a world as it stops is the `stop` operation's
 * (`handlers/winding-down.ts`); how big a disk grows is `domain/account/entitlements.ts`'s.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor, grownDisk } from '../../../domain/account/entitlements.ts'
import { announce } from '../../../minecraft/console.ts'
import { DATA_DIR } from '../../../minecraft/jars.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import type { Actor } from '../../actor.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { grownStorage, listByStatus, loadRuntime, recordDisk } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'

const MORE_ROOM: Actor = { kind: 'system', reason: 'disk' }

export function growingDisks(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'exec' | 'endpoint'>
  console: ServerConsole
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  service: Pick<MinecraftServerService, 'restart'>
}) {
  const { db, runtime, specs, service } = deps

  /**
   * `disk-check`: a world that grows fast while people play (a group exploring apart
   * can add gigabytes an hour) gets its bigger disk now, not at its next start, so no disk ever
   * runs full with players on it. Players are told first; the restart saves the world, and they
   * are back in about half a minute. Plans whose disks never grow are left alone.
   */
  const diskCheck = async (now: Date): Promise<number> => {
    let grown = 0
    for (const server of await listByStatus(db, 'running')) {
      const standing = await loadStanding(db, server.ownerId)
      const plan = entitlementsFor(standing.plan, standing.limitOverrides)
      if (plan.storage.mostGb <= plan.storage.startGb) continue
      const { handle } = await loadRuntime(db, server.id, runtime.providers)
      if (handle === null) continue
      const read = await runtime.exec(handle, ['du', '-sk', DATA_DIR], 60).catch(() => null)
      const kilobytes = Number.parseInt(read?.stdout.trim().split(/\s+/)[0] ?? '', 10)
      if (read?.exitCode !== 0 || !Number.isFinite(kilobytes)) continue
      const current = Math.max(plan.storage.startGb, await grownStorage(db, server.id))
      const bigger = grownDisk(plan, current, kilobytes * 1024)
      await recordDisk(db, server.id, kilobytes * 1024, now, bigger ?? undefined)
      if (bigger === null) continue
      const target = {
        endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
        passwords: specs.rconPasswords(server.id),
      }
      await deps.console
        .run(
          target,
          announce('The world needs more room. The server restarts with more in a moment, saving first.'),
        )
        .catch(() => undefined)
      // One restart for each size it grows to, however often the check sees it before it starts.
      await service.restart(MORE_ROOM, server.id, `disk:${bigger}`).catch(() => undefined)
      grown++
    }
    return grown
  }

  return diskCheck
}
