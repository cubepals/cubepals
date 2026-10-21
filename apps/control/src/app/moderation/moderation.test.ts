// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moderation on the stand-in runtime: the tools and the chat filter arrive as plugins with Cubepals'
 * files for them and leave the same way; a warning, a mute and a ban reach the running server by
 * the player's UUID, one given while it slept reaches it as it starts, for the time it has left,
 * and one whose time ran out isn't sent; a mute is taken back; helpers are named, delivered to
 * LuckPerms and read back from its files; and the game's own ban list still works beside
 * LibertyBans, by its full name.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { normalizeUuid as dashed } from '../../minecraft/console.ts'
import { CHATSENTINEL, LIBERTYBANS, LUCKPERMS } from '../../minecraft/moderation.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { ModerationService } from './service.ts'

let h: Harness
let moderation: ModerationService
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
  // As the API builds it (main.node.ts).
  moderation = new ModerationService({
    db: h.db,
    events: h.events,
    policy: h.app.policy,
    transitions: h.app.transitions,
    mods: h.app.mods,
  })
  for (const [projectId, name] of [
    [LIBERTYBANS, 'LibertyBans'],
    [LUCKPERMS, 'LuckPerms'],
    [CHATSENTINEL, 'ChatSentinel'],
  ] as const)
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: `${name}, for tests`,
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: offeredVersions().map((offered) => offered.id),
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file(`${name}-1`),
          dependencies: [],
        } satisfies CatalogVersion,
      ],
    )
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

/** A Paper server up with the tools, after the change that brings them has settled. */
const moderated = async (chatFilter = false) => {
  const owner = await h.user(undefined, 'plus')
  const server = await h.create(owner, paper())
  await h.until(server.id, 'running')
  await h.settled(server.id)
  const before = await h.server(server.id)
  await moderation.setTools(owner, server.id, { enabled: true, chatFilter }, randomUUID())
  await h.until(server.id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
  await h.settled(server.id, 20_000)
  return { owner, id: server.id, volume: h.runtime.machine(server.id)?.dir ?? '' }
}

/** The newest release Cubepals offers Paper on. */
const paper = () => ({
  loader: 'paper' as const,
  gameVersion: offeredVersions().find((offered) => supports(offered.id, 'paper'))?.id ?? '',
})

const steve = { playerUuid: '8667ba71-b85a-4004-af54-457a9734eed7', name: 'Steve' }
const heard = (id: string, pattern: RegExp) => h.minecraft.heard(id).filter((c) => pattern.test(c))

describe.skipIf(!hasDatabase)('the tools and the chat filter', () => {
  test('the tools and the filter come as plugins with their files, and go the same way', async () => {
    const { owner, id, volume } = await moderated(true)
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.mods.map((m) => m.name).sort()).toEqual(['ChatSentinel', 'LibertyBans', 'LuckPerms'])
    expect(readFileSync(`${volume}/plugins/LibertyBans/config.yml`, 'utf8')).toContain(
      'address-strictness: LENIENT',
    )
    expect(readFileSync(`${volume}/plugins/ChatSentinel/config.yml`, 'utf8')).toContain(
      'libertybans mute %player% 1h',
    )
    expect(await moderation.view(owner, id)).toMatchObject({
      available: true,
      enabled: true,
      chatFilter: true,
    })

    const before = await h.server(id)
    await moderation.setTools(owner, id, { enabled: false, chatFilter: true }, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    const off = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(off.mods).toEqual([])
    expect(off.files).toEqual([])
    expect(readdirSync(`${volume}/plugins`).filter((name) => name.endsWith('.jar'))).toEqual([])
    expect(await moderation.view(owner, id)).toMatchObject({ enabled: false, chatFilter: false })
  }, 90_000)
})

describe.skipIf(!hasDatabase)('punishments on a running server', () => {
  test('a warning, a mute and a ban reach the running server by UUID, and a mute is taken back', async () => {
    const { owner, id } = await moderated()
    await moderation.punish(owner, id, { ...steve, kind: 'warn', minutes: null, reason: 'Be kind' })
    await moderation.punish(owner, id, { ...steve, kind: 'mute', minutes: 60, reason: 'Spam' })
    await moderation.punish(owner, id, { ...steve, kind: 'ban', minutes: null, reason: '' })
    await h.settled(id)
    // A mute or ban takes the one standing off first, so the newest is the one in force.
    expect(heard(id, /^libertybans /)).toEqual([
      `libertybans warn ${steve.playerUuid} Be kind`,
      `libertybans unmute ${steve.playerUuid}`,
      expect.stringMatching(new RegExp(`^libertybans mute ${steve.playerUuid} (59|60)m Spam$`)),
      `libertybans unban ${steve.playerUuid}`,
      `libertybans ban ${steve.playerUuid} perm`,
    ])
    const view = await moderation.view(owner, id)
    expect(view.actions.map((a) => [a.kind, a.status])).toEqual([
      ['ban', 'given'],
      ['mute', 'given'],
      ['warn', 'given'],
    ])

    const mute = view.actions.find((a) => a.kind === 'mute')?.id ?? ''
    await moderation.lift(owner, id, mute)
    await h.settled(id)
    expect(heard(id, /^libertybans unmute /)).toHaveLength(2)
    expect((await moderation.view(owner, id)).actions.find((a) => a.id === mute)?.status).toBe('lifted')
  }, 90_000)
})

describe.skipIf(!hasDatabase)('punishments while it sleeps', () => {
  test('given while the server sleeps, it arrives as it starts, for the time left; one that ran out is not sent', async () => {
    const { owner, id } = await moderated()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await moderation.punish(owner, id, {
      ...steve,
      kind: 'mute',
      minutes: DAY_MS / MINUTE_MS,
      reason: 'Spam',
    })
    await moderation.punish(owner, id, { ...steve, kind: 'ban', minutes: 60, reason: 'Griefing' })
    // The ban was given two hours ago, and is over by the time the server wakes.
    const ban = schema.serverModerationActions
    await h.db
      .update(ban)
      .set({ createdAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(eq(ban.kind, 'ban'))
    await h.settled(id)
    expect(heard(id, /^libertybans (mute|ban) /)).toEqual([])

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(heard(id, /^libertybans (mute|ban) /)).toEqual([
      expect.stringMatching(new RegExp(`^libertybans mute ${steve.playerUuid} 14[0-9]{2}m Spam$`)),
    ])
    const view = await moderation.view(owner, id)
    expect(view.actions.map((a) => [a.kind, a.status])).toEqual([
      ['mute', 'given'],
      ['ban', 'over'],
    ])
  }, 90_000)
})

describe.skipIf(!hasDatabase)('helpers', () => {
  test('a helper is delivered to LuckPerms and read back; the game’s own ban list goes by its full name', async () => {
    const { owner, id, volume } = await moderated()
    const alex = await h.profiles.byName('Alex')
    if (alex === null) throw new Error('expected Alex to have an account')
    await h.app.access.add(owner, id, 'helper', 'Alex')
    await h.app.access.add(owner, id, 'ban', 'Steve', 'Griefing')
    await h.settled(id, 20_000)
    const uuid = dashed(alex.uuid)
    expect(heard(id, /^lp /)).toEqual([`lp user ${uuid} parent add helper`])
    expect(readFileSync(`${volume}/plugins/LuckPerms/yaml-storage/users/${uuid}.yml`, 'utf8')).toContain(
      '- helper',
    )
    expect(heard(id, /ban Steve/)).toEqual(['minecraft:ban Steve Griefing'])
    const access = await h.app.queries.access(owner, id)
    expect(access.entries.map((e) => [e.list, e.player.name, e.state]).sort()).toEqual([
      ['ban', 'Steve', 'active'],
      ['helper', 'Alex', 'active'],
    ])

    await h.app.access.remove(owner, id, 'helper', uuid)
    await h.settled(id, 20_000)
    expect(heard(id, /^lp /)).toEqual([
      `lp user ${uuid} parent add helper`,
      `lp user ${uuid} parent remove helper`,
    ])
    expect((await h.app.queries.access(owner, id)).entries.map((e) => e.list)).toEqual(['ban'])
  }, 90_000)
})

describe.skipIf(!hasDatabase)('escalation', () => {
  test('a server without the tools refuses a punishment, and an owner sets their own escalation', async () => {
    const owner = await h.user(undefined, 'plus')
    const server = await h.create(owner, paper())
    await expect(
      moderation.punish(owner, server.id, { ...steve, kind: 'warn', minutes: null, reason: '' }),
    ).rejects.toThrow('Turn on the moderation tools first')
    const ladder = [{ kind: 'mute' as const, minutes: 30 }]
    await moderation.setLadder(owner, server.id, ladder)
    expect(await moderation.view(owner, server.id)).toMatchObject({ ladder, ownLadder: true })
    await moderation.setLadder(owner, server.id, null)
    expect((await moderation.view(owner, server.id)).ownLadder).toBe(false)
  }, 60_000)
})
