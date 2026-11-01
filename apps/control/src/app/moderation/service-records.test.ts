// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real moderation records retain durations, history, owner policy and acknowledgement states. */
import { describe, expect, test } from 'bun:test'
import { DEFAULT_LADDER } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { CHATSENTINEL, LIBERTYBANS, LUCKPERMS } from '../../minecraft/moderation.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { ModerationService } from './service.ts'

const player = { playerUuid: '8667BA71-B85A-4004-AF54-457A9734EED7', name: 'Steve' }

async function fixture(loader: 'vanilla' | 'paper' = 'vanilla') {
  const h = await startHarness()
  try {
    const owner = await h.user(undefined, 'plus')
    const created = await h.create(
      owner,
      loader === 'paper'
        ? {
            loader,
            gameVersion: offeredVersions().find((version) => supports(version.id, 'paper'))?.id ?? '',
          }
        : {},
    )
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, crypto.randomUUID())
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    const service = new ModerationService({
      db: h.db,
      policy: h.app.policy,
      transitions: h.app.transitions,
      events: h.events,
      mods: h.app.mods,
    })
    return { h, owner, id: created.id, service }
  } catch (error) {
    await h.close()
    throw error
  }
}

async function record(
  h: Harness,
  serverId: string,
  patch: Partial<typeof schema.serverModerationActions.$inferInsert> = {},
) {
  const [row] = await h.db
    .insert(schema.serverModerationActions)
    .values({
      serverId,
      playerUuid: player.playerUuid,
      playerName: player.name,
      kind: 'mute',
      minutes: 5,
      state: 'pending',
      requestedBy: 'fixture',
      ...patch,
    })
    .returning()
  if (!row) throw new Error('The moderation record must persist')
  return row
}

async function history() {
  const { h, owner, id, service } = await fixture()
  try {
    const now = new Date()
    const rows = []
    for (const [state, minutes, age] of [
      ['pending', null, 0],
      ['pending', 1, 2],
      ['delivered', null, 3],
      ['delivered', 1, 4],
      ['lifting', 20, 5],
      ['lifted', 20, 6],
    ] as const)
      rows.push(
        await record(h, id, {
          state,
          minutes,
          reason: `reason-${age}`,
          error: age === 5 ? 'delivery failed' : null,
          createdAt: new Date(now.getTime() - age * MINUTE_MS),
        }),
      )
    const view = await service.view(owner, id, now)
    expect(view.available).toBe(true)
    expect(view.enabled).toBe(false)
    expect(view.chatFilter).toBe(false)
    expect(view.ladder).toEqual([...DEFAULT_LADDER])
    expect(view.ownLadder).toBe(false)
    expect(view.actions).toEqual(
      rows.map((row, index) => ({
        id: row.id,
        player: { uuid: row.playerUuid, name: row.playerName },
        kind: row.kind,
        reason: row.reason,
        minutes: row.minutes,
        status: (['waiting', 'over', 'given', 'over', 'lifting', 'lifted'] as const)[index]!,
        endsAt:
          row.minutes === null
            ? null
            : new Date(row.createdAt.getTime() + row.minutes * MINUTE_MS).toISOString(),
        at: row.createdAt.toISOString(),
        error: row.error,
      })),
    )
    const earlier = new Date(now.getTime() - 10 * MINUTE_MS)
    expect((await service.view(owner, id, earlier)).actions.map((a) => a.status)).toEqual([
      'waiting',
      'waiting',
      'given',
      'given',
      'lifting',
      'lifted',
    ])
  } finally {
    await h.close()
  }
}

async function lifting() {
  const { h, owner, id, service } = await fixture()
  try {
    const now = new Date()
    const pending = await record(h, id)
    const active = await record(h, id, { state: 'delivered', minutes: null })
    const expired = await record(h, id, {
      state: 'delivered',
      minutes: 1,
      createdAt: new Date(now.getTime() - 2 * MINUTE_MS),
    })
    const warning = await record(h, id, { kind: 'warn', minutes: null })
    await service.lift(owner, id, pending.id, now)
    await service.lift(owner, id, active.id, now)
    await service.lift(owner, id, expired.id, now)
    await service.lift(owner, id, pending.id, now)
    await service.lift(owner, id, active.id, now)
    await expect(service.lift(owner, id, warning.id, now)).rejects.toThrow(
      'A warning stays in their history.',
    )
    await expect(service.lift(owner, id, crypto.randomUUID(), now)).rejects.toThrow('Punishment')
    const saved = await h.db
      .select()
      .from(schema.serverModerationActions)
      .where(eq(schema.serverModerationActions.serverId, id))
    const byId = new Map(saved.map((row) => [row.id, row]))
    expect(byId.get(pending.id)).toMatchObject({ state: 'lifted', liftedAt: now, error: null })
    expect(byId.get(expired.id)).toMatchObject({ state: 'lifted', liftedAt: now, error: null })
    expect(byId.get(active.id)).toMatchObject({ state: 'lifting', liftedAt: null, error: null })
    expect(byId.get(warning.id)?.state).toBe('pending')
    expect((await service.view(owner, id, now)).actions).toHaveLength(4)
  } finally {
    await h.close()
  }
}

async function escalation() {
  const { h, owner, id, service } = await fixture()
  try {
    const outsider = await h.user()
    const ladder = [{ kind: 'mute' as const, minutes: 12 }]
    await service.setLadder(owner, id, ladder)
    expect(await service.view(owner, id)).toMatchObject({ ladder, ownLadder: true })
    const audit = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id))
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: `user:${owner.userId}`,
          action: 'moderation.ladder_changed',
          subjectType: 'server',
          subjectId: id,
        }),
      ]),
    )
    await expect(service.view(outsider, id)).rejects.toThrow('Server')
    await expect(service.setLadder(outsider, id, null)).rejects.toThrow('Server')
    await expect(
      service.punish(owner, id, { ...player, kind: 'warn', minutes: 12, reason: 'Be kind' }),
    ).rejects.toThrow('Turn on the moderation tools first')
    await service.setLadder({ kind: 'admin', userId: owner.userId }, id, null)
    expect(await service.view(owner, id)).toMatchObject({ ladder: [...DEFAULT_LADDER], ownLadder: false })
  } finally {
    await h.close()
  }
}

async function tools() {
  const { h, owner, id, service } = await fixture('paper')
  const cdn = new Cdn()
  try {
    await cdn.start()
    for (const projectId of [LIBERTYBANS, LUCKPERMS, CHATSENTINEL])
      h.catalog.publish(
        {
          projectId,
          slug: projectId,
          name: projectId,
          summary: 'Moderation fixture',
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
            gameVersions: offeredVersions().map((version) => version.id),
            publishedAt: new Date(),
            file: cdn.file(projectId),
            dependencies: [],
          },
        ],
      )
    const revision = async () => loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    await service.setTools(owner, id, { enabled: true, chatFilter: false }, crypto.randomUUID())
    expect(await service.view(owner, id)).toMatchObject({ available: true, enabled: true, chatFilter: false })
    expect(
      (await revision()).mods.map((mod) => ('projectId' in mod.source ? mod.source.projectId : '')).sort(),
    ).toEqual([LIBERTYBANS, LUCKPERMS].sort())
    const enabled = (await revision()).id
    await service.setTools(owner, id, { enabled: true, chatFilter: false }, crypto.randomUUID())
    expect((await revision()).id).toBe(enabled)
    await service.setTools(owner, id, { enabled: true, chatFilter: true }, crypto.randomUUID())
    expect(await service.view(owner, id)).toMatchObject({ enabled: true, chatFilter: true })
    expect((await revision()).mods).toHaveLength(3)
    expect((await revision()).files.some((file) => file.path.includes('ChatSentinel'))).toBe(true)
    await service.setTools(owner, id, { enabled: false, chatFilter: true }, crypto.randomUUID())
    expect(await service.view(owner, id)).toMatchObject({ enabled: false, chatFilter: false })
    expect((await revision()).mods).toEqual([])
    expect((await revision()).files).toEqual([])
    const fabric = await h.create(owner, { loader: 'fabric' })
    await expect(
      service.setTools(owner, fabric.id, { enabled: true, chatFilter: false }, crypto.randomUUID()),
    ).rejects.toThrow('The moderation tools run on Paper servers')
    expect((await service.view(owner, fabric.id)).available).toBe(false)
  } finally {
    cdn.close()
    await h.close()
  }
}

describe.skipIf(!hasDatabase)('moderation records', () => {
  test('tool changes retain the selected plugins and configuration', tools, 30 * SECOND_MS)
  test(
    'history distinguishes waiting, delivered, expired and lifted actions at the requested time',
    history,
    30 * SECOND_MS,
  )
  test(
    'lifting acknowledges pending and expired actions, requests delivery for active ones and refuses warnings',
    lifting,
    30 * SECOND_MS,
  )
  test(
    'owner changes persist the custom ladder and audit, while outsiders cannot read or write',
    escalation,
    30 * SECOND_MS,
  )
})
