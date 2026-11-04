// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measures running worlds, on plans whose disks grow, and records the bigger disk one has outgrown
 * its own for: it comes at the server's next start, and nobody is turned out for it. Only a world
 * about to fill the disk it is on now is restarted onto the bigger one at once, its players told
 * why first. Measuring a world as it stops is the `stop` operation's (`handlers/winding-down.ts`);
 * how big a disk grows is `domain/account/entitlements.ts`'s.
 */
import type { Db } from '@blockly/db'
import { entitlementsOf, grownDisk } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { announce } from '../../../minecraft/console.ts'
import { DATA_DIR } from '../../../minecraft/jars.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import type { Actor } from '../../actor.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { grownStorage, listByStatus, loadRuntime, recordDisk } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'

const MORE_ROOM: Actor = { kind: 'system', reason: 'disk' }

const KB = 1024
const GB_IN_KB = 2 ** 20

/**
 * The room left, as the disk itself says, below which a world played on now moves to its bigger
 * disk at once, players and all. The check runs every ten minutes (`infra/pg/cron.ts`). A world
 * grows about 10 KB a chunk explored (`Entitlements.storage`), and a player flying an elytra at
 * view distance 10 meets about 40 new chunks a second, about 1.4 GB an hour: a gigabyte is twenty
 * minutes of two of them flying apart, so a check that fails once, and the save the restart makes,
 * still fit. Above it the world has room, and its bigger disk waits for the next start.
 */
const ABOUT_TO_FILL_BYTES = 2 ** 30

/** What players read before a restart onto a bigger disk, from the line that comes first. */
const OUT_OF_ROOM =
  'This world is almost out of room. The server restarts with more in a moment, saving it first.'

export function growingDisks(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'exec' | 'endpoint'>
  console: ServerConsole
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  service: Pick<MinecraftServerService, 'restart'>
}) {
  const { db, runtime, specs, service } = deps

  /** What `du` says the server's folder takes, in bytes; null where it can't be read. */
  const usedBytes = async (handle: RuntimeHandle): Promise<number | null> => {
    const read = await runtime.exec(handle, ['du', '-sk', DATA_DIR], 60).catch(() => null)
    const kilobytes = Number.parseInt(read?.stdout.trim().split(/\s+/)[0] ?? '', 10)
    return read?.exitCode === 0 && Number.isFinite(kilobytes) ? kilobytes * KB : null
  }

  /**
   * The disk the server is on now, as its filesystem says (`df`): its size in whole GB, since a
   * filesystem is a little smaller than the disk it was made on, and the room the game may still
   * write, which leaves out what the filesystem keeps for root. Null where it can't be read.
   */
  const diskNow = async (handle: RuntimeHandle): Promise<{ gb: number; freeBytes: number } | null> => {
    const read = await runtime.exec(handle, ['df', '-Pk', DATA_DIR], 60).catch(() => null)
    // Its last line, counted from the end: size, used, available, capacity, mount point.
    const fields =
      read?.exitCode === 0 ? (read.stdout.trim().split('\n').at(-1) ?? '').trim().split(/\s+/) : []
    const [size = Number.NaN, , available = Number.NaN] = fields.slice(-5).map(Number)
    if (fields.length < 6 || !Number.isInteger(size) || !Number.isInteger(available)) return null
    return { gb: Math.ceil(size / GB_IN_KB), freeBytes: available * KB }
  }

  /** Tells whoever is on why, then restarts the server onto the disk of `gb` its world needs now. */
  const moreRoomNow = async (server: MinecraftServer, handle: RuntimeHandle, gb: number) => {
    const target = {
      endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: specs.rconPasswords(server.id),
    }
    await deps.console.run(target, announce(OUT_OF_ROOM)).catch(() => undefined)
    // One restart for each size it grows to, however often the check sees it before it starts.
    await service.restart(MORE_ROOM, server.id, `disk:${gb}`).catch(() => undefined)
  }

  /**
   * One running server measured: the disk its next start gets recorded, and whether it was
   * restarted onto it now, which only a disk about to fill is. Who is on doesn't change that: a
   * restart turns players out, and an empty server's restart spends its owner's hours on a fresh
   * idle wait (`domain/server/idle.ts`), for a world nobody is growing.
   */
  const measure = async (server: MinecraftServer, now: Date): Promise<boolean> => {
    const plan = entitlementsOf(await loadStanding(db, server.ownerId))
    if (plan.storage.mostGb <= plan.storage.startGb) return false
    const { handle } = await loadRuntime(db, server.id, runtime.providers)
    const used = handle === null ? null : await usedBytes(handle)
    if (handle === null || used === null) return false
    const current = Math.max(plan.storage.startGb, await grownStorage(db, server.id))
    const bigger = grownDisk(plan, current, used)
    await recordDisk(db, server.id, used, now, bigger ?? undefined)
    // The disk its next start gets, which an earlier check may have recorded already: the disk it
    // is on is the filesystem's to say.
    const next = bigger ?? current
    const on = await diskNow(handle)
    if (on === null || next <= on.gb || on.freeBytes >= ABOUT_TO_FILL_BYTES) return false
    await moreRoomNow(server, handle, next)
    return true
  }

  /**
   * `disk-check`: a world that grows fast while people play (a group exploring apart can add
   * gigabytes an hour) is measured as it does. Past the line its disk grows at, the bigger disk is
   * recorded for its next start, and it plays on: servers sleep when nobody is on, and the stop
   * measures it again (`handlers/winding-down.ts`). Only one about to fill the disk it is on is
   * restarted onto the bigger one now, so no disk runs full with players on it. Plans whose disks
   * never grow are left alone. Says how many restarted.
   */
  const diskCheck = async (now: Date): Promise<number> => {
    let grown = 0
    for (const server of await listByStatus(db, 'running')) if (await measure(server, now)) grown++
    return grown
  }

  return diskCheck
}
