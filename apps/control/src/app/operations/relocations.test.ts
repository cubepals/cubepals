import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { RuntimeFull, RuntimeUnsupported } from '../ports/runtime.ts'
import { HOST_LOST, loadRuntime } from '../servers/persistence.ts'
import { HOST_LOSS_GRACE_MS, RELOCATION_RETRY_MS } from './schedules.ts'

// The relocation triggers that aren't a person's choice (§9): a region remapped after its
// provider region was deprecated, and a lost host.
describe.skipIf(!hasDatabase)('relocation triggers', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (name: string, regionKey = 'local') => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name, regionKey })
    await h.until(id, 'running')
    await h.settled(id)
    return { owner, id }
  }
  /** The runtime refuses every move for want of room, as one whose room went since the sweep looked. */
  const refusingMoves = () =>
    spyOn(h.runtime, 'relocate').mockImplementation(async () => {
      throw new RuntimeFull('fake', 'no room just now')
    })
  const audited = (id: string, action: string) =>
    h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, action)))
  const backUp = async (owner: UserActor, id: string) => {
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [newest] = (await listBackups(h.db, id)).filter((b) => b.status === 'ready')
    if (newest === undefined) throw new Error('No backup was taken')
    return newest
  }

  test('a region remapped at the provider moves its servers there, a running one once nobody plays', async () => {
    const { owner, id } = await running('Remapped')
    const player = { uuid: randomUUID(), name: 'Steve' }
    h.minecraft.join(id, player)
    await h.app.schedules.presenceSync()
    try {
      // The region's provider region was deprecated; the operator mapped it elsewhere.
      h.runtime.remap('local', 'fake-2')
      expect(await h.app.schedules.relocations()).toBe(0)
      expect(h.runtime.machine(id)?.region).toBe('fake-1')

      h.minecraft.leave(id, player.uuid)
      await h.app.schedules.presenceSync()
      expect(await h.app.schedules.relocations()).toBe(1)
      await h.until(id, 'running', 20_000)
      await h.settled(id, 20_000)
      expect(h.runtime.machine(id)?.region).toBe('fake-2')
      // Same region as far as anyone can see; the world came along, saved first.
      expect((await h.app.queries.get(owner, id)).region.key).toBe('local')
      expect((await listBackups(h.db, id)).map((b) => b.trigger)).toContain('pre_relocate')
      expect(await audited(id, 'server.relocation_scheduled')).toMatchObject([
        { actor: 'system:reconcile', data: { reason: 'region', region: 'local' } },
      ])
      // Where it should be now: nothing more to move.
      expect(await h.app.schedules.relocations()).toBe(0)
    } finally {
      h.runtime.remap('local', 'fake-1')
      await h.app.servers.deleteServer(owner, id, 'Remapped')
    }
  }, 40_000)

  test('a region remapped where there is no room waits as it is, and moves once there is room', async () => {
    const { owner, id } = await running('Patient', 'far')
    h.runtime.remap('far', 'fake-1')
    h.runtime.fill('far')
    try {
      // Nothing is asked of a full region: the server keeps running where it is, every sweep.
      expect(await h.app.schedules.relocations()).toBe(0)
      expect(await h.app.schedules.relocations()).toBe(0)
      expect((await h.operations(id)).map((op) => op.kind)).not.toContain('relocate')
      expect(h.runtime.machine(id)).toMatchObject({ state: 'running', region: 'fake-2' })

      h.runtime.fill('far', false)
      expect(await h.app.schedules.relocations()).toBe(1)
      await h.until(id, 'running', 20_000)
      await h.settled(id, 20_000)
      expect(h.runtime.machine(id)?.region).toBe('fake-1')
    } finally {
      h.runtime.fill('far', false)
      h.runtime.remap('far', 'fake-2')
      await h.app.servers.deleteServer(owner, id, 'Patient')
    }
  }, 40_000)

  test('a move the runtime refuses for room leaves the server as it was, running where it ran', async () => {
    const { owner, id } = await running('Unmoved')
    const before = await loadRuntime(h.db, id, ['fake'])
    const relocate = refusingMoves()
    try {
      await h.app.servers.relocate(owner, id, 'far', randomUUID())
      await h.settled(id, 20_000)
      // Asked once: a refusal isn't tried again.
      expect(relocate).toHaveBeenCalledTimes(1)
    } finally {
      relocate.mockRestore()
    }
    const server = await h.server(id)
    expect(server.lifecycle).toMatchObject({ status: 'running', failure: null })
    expect(server.regionKey).toBe('local')
    expect((await loadRuntime(h.db, id, ['fake'])).handle).toBe(before.handle)
    expect(h.runtime.machine(id)).toMatchObject({ state: 'running', region: 'fake-1' })
    // The operation says why, for operators to see.
    const [move] = (await h.operations(id)).filter((op) => op.kind === 'relocate')
    expect(move?.status).toBe('failed')
    expect(move?.error).toStartWith('It stayed where it was')
    expect(move?.detail).toContain('no room just now')
    await h.app.servers.deleteServer(owner, id, 'Unmoved')
  }, 40_000)

  test('a move the runtime declines outright leaves the server as it was, running where it ran', async () => {
    const { owner, id } = await running('Unmovable')
    const before = await loadRuntime(h.db, id, ['fake'])
    const relocate = spyOn(h.runtime, 'relocate').mockImplementation(async () => {
      throw new RuntimeUnsupported('fake', 'moving this server to another node: its world is too big')
    })
    try {
      await h.app.servers.relocate(owner, id, 'far', randomUUID())
      await h.settled(id, 20_000)
      expect(relocate).toHaveBeenCalledTimes(1)
    } finally {
      relocate.mockRestore()
    }
    const server = await h.server(id)
    expect(server.lifecycle).toMatchObject({ status: 'running', failure: null })
    expect(server.regionKey).toBe('local')
    expect((await loadRuntime(h.db, id, ['fake'])).handle).toBe(before.handle)
    const [move] = (await h.operations(id)).filter((op) => op.kind === 'relocate')
    expect(move?.status).toBe('failed')
    expect(move?.detail).toContain('its world is too big')
    await h.app.servers.deleteServer(owner, id, 'Unmovable')
  }, 40_000)

  test('a move refused lately is asked for again only after a while', async () => {
    const { owner, id } = await running('Refused', 'far')
    h.runtime.remap('far', 'fake-1')
    const relocate = spyOn(h.runtime, 'relocate').mockImplementation(async () => {
      throw new RuntimeUnsupported('fake', 'moving this server to another node: its world is too big')
    })
    try {
      expect(await h.app.schedules.relocations()).toBe(1)
      await h.settled(id, 20_000)
      expect((await h.server(id)).lifecycle).toMatchObject({ status: 'running', failure: null })
      // Refused just now: the next sweeps leave it be.
      expect(await h.app.schedules.relocations()).toBe(0)
      expect(relocate).toHaveBeenCalledTimes(1)
      // A while later it is asked for again.
      expect(await h.app.schedules.relocations(new Date(Date.now() + RELOCATION_RETRY_MS + 60_000))).toBe(1)
      await h.settled(id, 20_000)
      expect(relocate).toHaveBeenCalledTimes(2)
      // Refused twice in a row, it waits twice as long: every try snapshots the world first.
      expect(await h.app.schedules.relocations(new Date(Date.now() + RELOCATION_RETRY_MS + 60_000))).toBe(0)
      expect(await h.app.schedules.relocations(new Date(Date.now() + 2 * RELOCATION_RETRY_MS + 60_000))).toBe(
        1,
      )
      await h.settled(id, 20_000)
      expect(relocate).toHaveBeenCalledTimes(3)
    } finally {
      relocate.mockRestore()
      h.runtime.remap('far', 'fake-2')
      await h.app.servers.deleteServer(owner, id, 'Refused')
    }
  }, 40_000)

  test('a lost host is rebuilt elsewhere from the newest snapshot after a grace, and the owner is told', async () => {
    const { owner, id } = await running('Stranded')
    await backUp(owner, id)
    // Built after the backup: lost with the host. Let in after it: Blockly's record keeps that.
    const dir = h.runtime.machine(id)?.dir ?? ''
    await writeFile(join(dir, 'after-backup.txt'), 'gone with the host\n')
    await h.app.access.setWhitelistEnabled(owner, id, true)
    await h.app.access.add(owner, id, 'whitelist', 'Alex')
    await h.settled(id)
    expect(await h.minecraft.file(id, 'whitelist.json')).toContain('"name": "Alex"')
    const before = h.runtime.machine(id)

    await h.runtime.loseHost(id)
    // The console stops answering; the provider, asked, says the host is unreachable.
    await h.app.schedules.presenceSync()
    const lost = (await loadRuntime(h.db, id, ['fake'])).observed
    expect(lost).toMatchObject({ state: 'unknown', detail: HOST_LOST })
    // Not a crash: the host may come back.
    await h.app.schedules.reconcile()
    expect((await h.server(id)).lifecycle.status).toBe('running')
    // Within the grace, nothing moves; past it, it is rebuilt.
    expect(await h.app.schedules.relocations()).toBe(0)
    const later = new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)
    expect(await h.app.schedules.relocations(later)).toBe(1)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)

    const after = h.runtime.machine(id)
    expect(after?.region).toBe('fake-1')
    expect(after?.dir).not.toBe(before?.dir)
    await expect(access(join(after?.dir ?? '', 'after-backup.txt'))).rejects.toThrow()
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.detail).not.toBe(HOST_LOST)
    // Who can join went back in full, and the owner heard what was lost.
    expect((await h.app.queries.get(owner, id)).status).toBe('running')
    expect(await h.minecraft.file(id, 'whitelist.json')).toContain('"name": "Alex"')
    expect(await h.minecraft.file(id, 'server.properties')).toContain('white-list=true')
    const [mail] = h.mail.to(`${owner.userId}@example.test`)
    expect(mail?.subject).toBe('“Stranded” was moved after the computer it ran on failed')
    expect(mail?.text).toContain('Anything built or changed in the world after that is gone.')
    expect(await audited(id, 'server.rebuilt_from_backup')).toHaveLength(1)
    expect(await audited(id, 'server.relocation_scheduled')).toMatchObject([{ data: { reason: 'host' } }])
  }, 60_000)

  test('a lost host with no snapshot to rebuild from fails the move and says why', async () => {
    const { id } = await running('No Backup')
    await h.runtime.loseHost(id)
    await h.app.schedules.presenceSync()
    const lost = (await loadRuntime(h.db, id, ['fake'])).observed
    expect(
      await h.app.schedules.relocations(new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)),
    ).toBe(1)
    const failed = await h.until(id, 'failed', 20_000)
    expect(failed.lifecycle.failure).toMatchObject({
      during: 'relocating',
      message: "This server's host was lost, and it has no snapshot to rebuild from.",
    })
    // The next sweeps leave it to its owner's "Try again", and nothing else waits on it.
    const later = new Date(Date.parse(lost?.at ?? '') + 2 * HOST_LOSS_GRACE_MS)
    expect(await h.app.schedules.relocations(later)).toBe(0)
    expect((await h.server(id)).lifecycle.failure?.during).toBe('relocating')
  }, 40_000)

  test('a host that answers again keeps its server: the console clears the mark, and so does the sweep', async () => {
    const { owner, id } = await running('Blip')
    await backUp(owner, id)
    const before = h.runtime.machine(id)
    const markLost = async () => {
      await h.runtime.loseHost(id)
      await h.app.schedules.presenceSync()
      const lost = (await loadRuntime(h.db, id, ['fake'])).observed
      expect(lost?.detail).toBe(HOST_LOST)
      return new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)
    }

    // Back while it runs: the console answers, and the mark goes with the next presence pass.
    const past = await markLost()
    await h.runtime.regainHost(id)
    await h.app.schedules.presenceSync()
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.detail).not.toBe(HOST_LOST)
    expect(await h.app.schedules.relocations(past)).toBe(0)

    // Back before anything asked the console again: the sweep asks the provider, and leaves it.
    const again = await markLost()
    await h.runtime.regainHost(id)
    expect(await h.app.schedules.relocations(again)).toBe(0)
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.detail).not.toBe(HOST_LOST)
    expect(h.runtime.machine(id)?.dir).toBe(before?.dir)
    expect(await audited(id, 'server.relocation_scheduled')).toEqual([])
  }, 40_000)

  test('a lost host with no room elsewhere waits, and is rebuilt as soon as there is room', async () => {
    const { owner, id } = await running('Crowded')
    await backUp(owner, id)
    await h.runtime.loseHost(id)
    await h.app.schedules.presenceSync()
    const lost = (await loadRuntime(h.db, id, ['fake'])).observed
    const later = new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)

    // No room anywhere in its region: no rebuild is asked for, sweep after sweep.
    h.runtime.fill('local')
    try {
      expect(await h.app.schedules.relocations(later)).toBe(0)
      expect(await h.app.schedules.relocations(later)).toBe(0)
    } finally {
      h.runtime.fill('local', false)
    }
    expect((await h.operations(id)).map((op) => op.kind)).not.toContain('relocate')

    // Room that went between the look and the rebuild: refused, and the server waits, stopped,
    // still marked lost, not failed.
    const relocate = refusingMoves()
    try {
      expect(await h.app.schedules.relocations(later)).toBe(1)
      await h.until(id, 'stopped', 20_000)
      await h.settled(id, 20_000)
    } finally {
      relocate.mockRestore()
    }
    expect((await h.server(id)).lifecycle.failure).toBeNull()
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.detail).toBe(HOST_LOST)
    expect(await audited(id, 'server.rebuilt_from_backup')).toEqual([])

    // With room, the next sweep rebuilds it.
    expect(await h.app.schedules.relocations(later)).toBe(1)
    await h.settled(id, 20_000)
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.detail).not.toBe(HOST_LOST)
    expect(await audited(id, 'server.rebuilt_from_backup')).toHaveLength(1)
  }, 60_000)
})
