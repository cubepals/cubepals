import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision, loadRuntime } from '../servers/persistence.ts'

// What a plan allows of a configuration (§ free plan cost controls): the size, the server type
// and the settings a revision may carry, and what happens to a server made before a limit.
describe.skipIf(!hasDatabase)('plan limits on configurations', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const settingsOf = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
  const change = (owner: UserActor, id: string, patch: Partial<ServerSettings>) =>
    settingsOf(id).then((current) =>
      h.app.revisions.changeSettings(owner, id, { ...current, ...patch }, randomUUID()),
    )

  test('a free server is made on the smallest size, within the caps, with the AFK kick and world border', async () => {
    const owner = await h.user()
    const { id, memoryTier } = await h.create(owner, { name: 'Small' })
    await h.until(id, 'running')
    await h.settled(id)
    expect(memoryTier).toBe('3g')
    // Blockly's defaults are fitted to the plan; nothing the owner chose is lowered.
    expect(await settingsOf(id)).toMatchObject({ maxPlayers: 5, viewDistance: 8, simulationDistance: 6 })
    const env = h.runtime.machine(id)?.spec.env ?? {}
    expect(env.PLAYER_IDLE_TIMEOUT).toBe('15')
    expect(env.MAX_WORLD_SIZE).toBe('2500')
    expect(env.MEMORY).toBe('2048M')
    const view = await h.app.queries.get(owner, id)
    expect(view.partySize).toBe('5')
    expect(view.movesToSize).toBeNull()
  })

  test('a free server refuses what is above its caps, and keeps its configuration', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Capped' })
    await h.until(id, 'running')
    await h.settled(id)
    const before = await settingsOf(id)
    // On the free size, max players is capped by the size itself, which holds the same 5.
    await expect(change(owner, id, { maxPlayers: 6 })).rejects.toThrow(/holds up to 5 players/)
    await expect(change(owner, id, { viewDistance: 9 })).rejects.toThrow('Free servers see up to 8 chunks')
    await expect(change(owner, id, { simulationDistance: 7 })).rejects.toThrow(
      'Free servers simulate up to 6 chunks',
    )
    expect(await settingsOf(id)).toEqual(before)
    // What fits still saves.
    await change(owner, id, { viewDistance: 8, motd: 'Within the plan' })
    await h.until(id, 'running')
    await h.settled(id)
    expect((await settingsOf(id)).motd).toBe('Within the plan')
  }, 30_000)

  test('Free runs plain Minecraft; other server types and mods come with Plus', async () => {
    const free = await h.user()
    const { id } = await h.create(free, { name: 'Plain', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    const options = await h.app.queries.settingsOptions(free, id)
    const loaders = options.gameVersions.find((v) => v.value === '26.2')?.loaders ?? []
    // Paper is plain Minecraft to the people playing; the rest add something they install.
    expect(loaders.filter((l) => l.allowed).map((l) => l.value)).toEqual(['vanilla', 'paper'])
    expect(loaders.find((l) => l.value === 'fabric')).toMatchObject({
      allowed: false,
      reason: 'Fabric servers come with Plus.',
    })
    expect(options.partySizes.find((s) => s.value === '10')).toMatchObject({
      allowed: false,
      reason: 'Groups over 5 come with Plus.',
      plan: 'plus',
    })
    expect(options.bounds).toMatchObject({
      maxPlayers: 5,
      viewDistance: { min: 3, max: 8 },
      simulationDistance: { min: 3, max: 6 },
    })
    // Moving the world to a modded server type is refused in the same words, and nothing changes.
    const moved = await h.app.mods
      .changeVersion(free, id, { gameVersion: '26.2', loader: 'fabric' }, [], randomUUID())
      .then(
        () => null,
        (error: Error) => error.message,
      )
    expect(moved).toBe('Free servers run Vanilla and Paper. Fabric comes with Plus.')
    // Paper is fine.
    await h.app.mods.changeVersion(free, id, { gameVersion: '26.2', loader: 'paper' }, [], randomUUID())
    await h.until(id, 'running', 60_000)
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    // Creating a Fabric server is refused before anything is made.
    const made = await h.create(free, { name: 'Modded', loader: 'fabric', gameVersion: '26.2' }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(made).toBe('Free servers run Vanilla and Paper. Fabric comes with Plus.')
  }, 60_000)

  test('Plus runs every server type', async () => {
    const payer = await h.user('Pat', 'plus')
    const { id } = await h.create(payer, { name: 'Modded', loader: 'fabric', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    const options = await h.app.queries.settingsOptions(payer, id)
    const loaders = options.gameVersions.find((v) => v.value === '26.2')?.loaders ?? []
    expect(loaders.every((l) => l.allowed)).toBe(true)
  }, 30_000)

  test('a server on a size the plan no longer offers keeps running, and moves at its next change', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Grandfathered' })
    await h.until(id, 'running')
    await h.settled(id)
    // As a server made when free included 4 GB is: on a size the plan no longer offers.
    await h.db
      .update(schema.minecraftServers)
      .set({ memoryTier: '4g' })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)

    // The size holds 10, and the plan 5: the plan's cap is what refuses.
    await expect(change(owner, id, { maxPlayers: 8 })).rejects.toThrow('Free servers hold up to 5 players.')

    // It still starts: a plan change breaks nothing.
    const view = await h.app.queries.get(owner, id)
    expect(view.movesToSize).toEqual({ tier: '3g', label: '3 GB' })
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect((await h.server(id)).memoryTier).toBe('4g')

    // Its next change moves it to the size the plan offers, and the audit says so.
    await change(owner, id, { motd: 'Moved by the plan' })
    await h.until(id, (s) => s.memoryTier === '3g' && s.lifecycle.status === 'running')
    await h.settled(id)
    const audit = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.settings_changed')))
    expect(audit.at(-1)?.data).toMatchObject({ sizeMovedByPlan: { from: '4g', to: '3g' } })
    expect((await h.app.queries.get(owner, id)).movesToSize).toBeNull()
  }, 40_000)

  test('idle players are kicked after 15 minutes unless the owner opts out; never is theirs alone', async () => {
    const owner = await h.user('Idle', 'plus')
    const { id } = await h.create(owner, { name: 'Standing Still' })
    await h.until(id, 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.env.PLAYER_IDLE_TIMEOUT).toBe('15')
    // Never is the costliest choice, made by the owner; the server takes it at its next start.
    await h.app.accounts.setAfkKick(owner, 0)
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.env.PLAYER_IDLE_TIMEOUT).toBe('0')
    // Anything else is a real kick.
    const refused = await h.app.accounts.setAfkKick(owner, 3).then(
      () => null,
      (error: { code?: string }) => error.code,
    )
    expect(refused).toBe('invalid_choice')
  }, 40_000)

  test('a server’s disk is its plan’s, stopping measures its world, and a grown disk comes at the next start', async () => {
    const free = await h.user('Disk')
    const small = await h.create(free, { name: 'Small Disk' })
    await h.until(small.id, 'running')
    await h.settled(small.id)
    expect(h.runtime.machine(small.id)?.spec.storage.sizeGb).toBe(3)
    await h.app.servers.stop(free, small.id, randomUUID())
    await h.until(small.id, 'stopped')
    await h.settled(small.id)
    const [measured] = await h.db
      .select()
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, small.id))
    expect(measured?.diskUsedBytes).toBeGreaterThan(0)
    expect(measured?.diskCheckedAt).not.toBeNull()

    const payer = await h.user('Big Disk', 'plus')
    const large = await h.create(payer, { name: 'Large Disk', partySize: 'more' })
    await h.until(large.id, 'running')
    await h.settled(large.id)
    expect(h.runtime.machine(large.id)?.spec.storage.sizeGb).toBe(5)
    // A world that filled its disk gets the grown one at its next start, and not before.
    await h.db
      .update(schema.serverRuntimes)
      .set({ storageGb: 15 })
      .where(eq(schema.serverRuntimes.serverId, large.id))
    expect(await h.app.schedules.drift()).toBe(0)
    await h.app.servers.restart(payer, large.id, randomUUID())
    await h.until(large.id, 'running', 30_000)
    await h.settled(large.id)
    expect(h.runtime.machine(large.id)?.spec.storage.sizeGb).toBe(15)
  }, 60_000)

  test('a world that outgrows its disk while people play gets a bigger one then, not at its next start', async () => {
    const payer = await h.user('Explorer', 'plus')
    const { id } = await h.create(payer, { name: 'Far Lands' })
    await h.until(id, 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(5)
    const GB_IN_KB = 2 ** 20
    try {
      // Plenty of room: nothing happens.
      h.runtime.reportDiskUsage(id, 2 * GB_IN_KB)
      expect(await h.app.schedules.diskCheck()).toBe(0)
      // Less than 1.5 GB left: players are told, and it restarts onto a disk with room again.
      h.runtime.reportDiskUsage(id, Math.round(3.8 * GB_IN_KB))
      expect(await h.app.schedules.diskCheck()).toBe(1)
      await h.settled(id, 30_000)
      await h.until(id, 'running')
      expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(7)
      expect(h.minecraft.said(id).some((line) => line.includes('needs more room'))).toBe(true)
      // Measured again with the room it has now: nothing more.
      expect(await h.app.schedules.diskCheck()).toBe(0)
    } finally {
      h.runtime.reportDiskUsage(id, null)
    }
    // Free never grows, so it is never checked.
    const free = await h.user('Walker')
    const plain = await h.create(free, { name: 'Small Lands' })
    await h.until(plain.id, 'running')
    await h.settled(plain.id)
    h.runtime.reportDiskUsage(plain.id, Math.round(2.9 * GB_IN_KB))
    try {
      expect(await h.app.schedules.diskCheck()).toBe(0)
    } finally {
      h.runtime.reportDiskUsage(plain.id, null)
    }
  }, 90_000)

  test('a plan change reaches a running server at its next start, never by restarting it', async () => {
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Unbothered' })
    await h.until(id, 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.env.MAX_WORLD_SIZE).toBe('10000')

    // The account moves to a plan with a world border.
    await h.db
      .update(schema.accountStanding)
      .set({ plan: 'free' })
      .where(eq(schema.accountStanding.userId, owner.userId))
    // Nothing drifts: what a plan sets is left out of what drift compares.
    expect(await h.app.schedules.drift()).toBe(0)
    expect(h.runtime.machine(id)?.spec.env.MAX_WORLD_SIZE).toBe('10000')
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.driftDigest).toBeDefined()

    // Its next start runs it under the new plan.
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.env.MAX_WORLD_SIZE).toBe('2500')
  }, 40_000)
})
