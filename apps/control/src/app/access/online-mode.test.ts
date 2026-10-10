// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { WAITS_FOR_JOIN } from '../../domain/access/reconcile.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { offlineUuid } from './identity.ts'
import { readAccess } from './persistence.ts'

// A server whose owner turned off account checks (§15.1), end to end: the setting, who each name
// is to the server, and everything keyed by a player moving with it. The fake server behaves as
// vanilla 26.x did on real servers on 2026-09-23 (`infra/fake/fake-minecraft.ts`).
describe.skipIf(!hasDatabase)('a server that does not check accounts', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async () => {
    const owner = await h.user()
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const checks = async (owner: UserActor, id: string, onlineMode: boolean) => {
    const { version } = await h.server(id)
    await h.app.revisions.changeAuthentication(owner, id, onlineMode, randomUUID(), { version })
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }
  const account = async (name: string) => normalizeUuid((await h.profiles.byName(name))?.uuid ?? '')
  const entryFor = async (owner: UserActor, id: string, name: string) =>
    (await h.app.queries.access(owner, id)).entries.find((e) => e.player.name === name)
  const env = (id: string) => h.runtime.machine(id)?.spec.env ?? {}

  test('every server checks accounts, and only its own setting changes that', async () => {
    const { owner, id } = await running()
    expect(env(id).ONLINE_MODE).toBe('TRUE')
    const first = (await h.server(id)).desiredRevisionId

    await checks(owner, id, false)
    expect(env(id).ONLINE_MODE).toBe('FALSE')
    expect(await h.minecraft.file(id, 'server.properties')).toContain('online-mode=false')

    // The game settings, going back to the first revision, and a stop and start all leave it off.
    const { version } = await h.server(id)
    const current = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...current.settings, difficulty: 'hard' },
      randomUUID(),
      {
        version,
      },
    )
    await h.settled(id, 20_000)
    await h.app.revisions.rollback(owner, id, first, randomUUID(), { version: (await h.server(id)).version })
    await h.settled(id, 20_000)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(env(id).ONLINE_MODE).toBe('FALSE')
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings).toMatchObject({
      difficulty: 'normal',
      onlineMode: false,
    })

    // Somebody who makes one like it gets a server that checks accounts: they never chose otherwise.
    const stranger = await h.user()
    const { slug, inviteCode } = await h.server(id)
    const made = await h.create(stranger, { from: { kind: 'server', slug, invite: inviteCode } })
    await h.until(made.id, 'running')
    await h.settled(made.id)
    expect(env(made.id).ONLINE_MODE).toBe('TRUE')
    // Made from an invite, and kept as such: the way friends bring friends.
    const [row] = await h.db
      .select({ from: schema.minecraftServers.createdFrom })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, made.id))
    expect(row?.from).toBe('invite')
  }, 90_000)

  test('turning it off keeps who may join, who operates and who is banned, as the players it now sees', async () => {
    const { owner, id } = await running()
    await h.app.access.setWhitelistEnabled(owner, id, true)
    await h.app.access.add(owner, id, 'whitelist', 'Alex')
    await h.app.access.add(owner, id, 'operator', 'Steve')
    await h.app.access.add(owner, id, 'ban', 'Griefer', 'broke things')
    await h.settled(id)
    expect(await h.minecraft.login(id, 'Alex')).toBe('joined')
    expect(h.minecraft.isOperator(id, await account('Steve'))).toBe(true)
    h.minecraft.leave(id, await account('Alex'))

    await checks(owner, id, false)

    // To this server a name is the player: Alex gets in as Alex, with nobody's account.
    expect(await h.minecraft.login(id, 'Alex')).toBe('joined')
    expect(await h.minecraft.login(id, 'Mallory')).toBe('not whitelisted')
    expect(await h.minecraft.login(id, 'Griefer')).toBe('banned')
    // Operators load only as the server starts: the boot wrote them and started it once more.
    expect(h.minecraft.isOperator(id, offlineUuid('Steve'))).toBe(true)
    expect(h.minecraft.isOperator(id, await account('Steve'))).toBe(false)
    // The name cache named everyone the old way, so it went.
    expect(await h.minecraft.file(id, 'usercache.json')).not.toContain(await account('Steve'))
    const { record } = await readAccess(h.db, id)
    expect(record.entries.map((e) => [e.list, e.player.name, e.player.uuid, e.state]).sort()).toEqual(
      [
        ['ban', 'Griefer', offlineUuid('Griefer'), 'active'],
        ['operator', 'Steve', offlineUuid('Steve'), 'active'],
        ['whitelist', 'Alex', offlineUuid('Alex'), 'active'],
      ].sort(),
    )
  }, 90_000)

  test('a name needs no account, and capitals count — from the owner and through an invitation', async () => {
    const { owner, id } = await running()
    await checks(owner, id, false)
    await h.app.access.setWhitelistEnabled(owner, id, true)
    h.profiles.unknown('NoAccount')
    await h.app.access.add(owner, id, 'whitelist', 'NoAccount')
    await h.settled(id)
    expect(await h.minecraft.login(id, 'NoAccount')).toBe('joined')
    expect(await h.minecraft.login(id, 'noaccount')).toBe('not whitelisted')

    const { inviteCode } = await h.server(id)
    expect(await h.app.sharing.joinThroughInvite(inviteCode, 'Invited_Friend')).toMatchObject({ added: true })
    await h.settled(id)
    expect(await h.minecraft.login(id, 'Invited_Friend')).toBe('joined')

    // The public page counts who is on, and names nobody: nobody's name was checked.
    await h.app.schedules.presenceSync()
    expect(await h.app.sharingQueries.invite(inviteCode)).toMatchObject({
      online: 2,
      players: [],
      checksAccounts: false,
    })
  }, 90_000)

  test('an operator for someone it has never met waits for them, and lands once they join', async () => {
    const { owner, id } = await running()
    await checks(owner, id, false)
    await h.app.access.add(owner, id, 'operator', 'Newcomer')
    await h.settled(id)
    // The console named Newcomer the way an account would be named; that was taken back off.
    expect(await entryFor(owner, id, 'Newcomer')).toMatchObject({
      state: 'pending_add',
      error: WAITS_FOR_JOIN,
    })
    expect(h.minecraft.isOperator(id, offlineUuid('Newcomer'))).toBe(false)
    expect(h.minecraft.isOperator(id, await account('Newcomer'))).toBe(false)

    expect(await h.minecraft.login(id, 'Newcomer')).toBe('joined')
    await h.app.schedules.presenceSync()
    await h.settled(id)
    expect(h.minecraft.isOperator(id, offlineUuid('Newcomer'))).toBe(true)
    expect(await entryFor(owner, id, 'Newcomer')).toMatchObject({ state: 'active' })
  }, 90_000)

  test('turning it back on gives everyone their account again, and refuses a name nobody owns', async () => {
    const { owner, id } = await running()
    await checks(owner, id, false)
    await h.app.access.setWhitelistEnabled(owner, id, true)
    h.profiles.unknown('Nobody_Owns')
    for (const name of ['Alex', 'Nobody_Owns']) await h.app.access.add(owner, id, 'whitelist', name)
    await h.app.access.add(owner, id, 'operator', 'Steve')
    await h.settled(id)

    await checks(owner, id, true)

    expect(env(id).ONLINE_MODE).toBe('TRUE')
    expect(await h.minecraft.login(id, 'Alex')).toBe('joined')
    expect(h.minecraft.isOperator(id, await account('Steve'))).toBe(true)
    expect(await entryFor(owner, id, 'Nobody_Owns')).toMatchObject({
      state: 'rejected',
      error: expect.stringContaining('No Minecraft account has this name'),
    })
    expect(await h.minecraft.login(id, 'Nobody_Owns')).toBe('no account')
  }, 90_000)
})
