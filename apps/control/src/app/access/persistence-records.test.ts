// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Access records preserve all fields and protect newer owner changes during reconciliation. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type AccessEntry, entryKey, newAccessRecord } from '../../domain/access/access.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import {
  createAccess,
  deleteEntry,
  liftedIpBans,
  lockAccess,
  markReseed,
  readAccess,
  recordSyncError,
  saveReconciled,
  setWhitelistPending,
  upsertEntry,
} from './persistence.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
})
const entry = (name: string, list: AccessEntry['list'] = 'whitelist'): AccessEntry => ({
  list,
  player: { uuid: crypto.randomUUID(), name },
  state: 'pending_add',
  origin: 'blockly',
  details: { reason: 'fixture' },
  error: null,
})
async function server() {
  const owner = await h.user('Access owner', 'plus')
  const { id } = await h.create(owner)
  await h.until(id, 'running', 3 * SECOND_MS)
  await h.settled(id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, id, crypto.randomUUID())
  await h.until(id, 'stopped', 3 * SECOND_MS)
  await h.settled(id, 3 * SECOND_MS)
  return id
}

test.skipIf(!hasDatabase)(
  'seeded entries round-trip every field, stamp and requesting actor',
  async () => {
    const id = await server()
    await h.db.delete(schema.serverAccessEntries).where(eq(schema.serverAccessEntries.serverId, id))
    await h.db.delete(schema.serverAccess).where(eq(schema.serverAccess.serverId, id))
    const seeded = {
      ...entry('Operator', 'operator'),
      origin: 'game' as const,
      details: { level: 3, bypassesPlayerLimit: true },
      error: 'previous refusal',
    }
    await h.db.transaction((tx) =>
      createAccess(tx, id, { whitelistOn: true, entries: [seeded] }, 'fixture-owner'),
    )
    const read = await readAccess(h.db, id)
    expect(read.record).toEqual({ ...newAccessRecord(), whitelistEnabledPending: true, entries: [seeded] })
    expect(read).toMatchObject({ version: 0, syncedAt: null, syncError: null })
    const [row] = await h.db
      .select()
      .from(schema.serverAccessEntries)
      .where(eq(schema.serverAccessEntries.serverId, id))
    if (!row) throw new Error('The seeded access entry must exist')
    expect(row.requestedBy).toBe('fixture-owner')
    expect(read.stamps).toEqual(
      new Map([[entryKey(seeded.list, seeded.player.uuid), row.updatedAt.getTime()]]),
    )
    await h.db.transaction((tx) => createAccess(tx, id))
    expect((await readAccess(h.db, id)).record).toEqual(read.record)
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'head changes and entry deletion retain unrelated entries',
  async () => {
    const id = await server()
    const version = (await readAccess(h.db, id)).version
    const first = entry('First'),
      second = entry('Second'),
      otherList = { ...first, list: 'operator' as const }
    await h.db.transaction(async (tx) => {
      for (const value of [first, second, otherList]) await upsertEntry(tx, id, value, 'fixture-owner')
      expect(await lockAccess(tx, id)).toBe(version + 1)
      expect(await lockAccess(tx, id)).toBe(version + 2)
      await setWhitelistPending(tx, id, false)
      await deleteEntry(tx, id, first)
    })
    await h.db
      .update(schema.serverAccess)
      .set({ reseedRequired: false })
      .where(eq(schema.serverAccess.serverId, id))
    await markReseed(h.db, id)
    await recordSyncError(h.db, id, 'console did not answer')
    const read = await readAccess(h.db, id)
    expect(read.record.entries).toEqual(expect.arrayContaining([second, otherList]))
    expect(read.record.entries).toHaveLength(2)
    expect(read.record).toMatchObject({ whitelistEnabledPending: false, reseedRequired: true })
    expect(read).toMatchObject({ version: version + 2, syncError: 'console did not answer' })
    const missing = crypto.randomUUID()
    await expect(readAccess(h.db, missing)).rejects.toThrow(`Server ${missing} has no access record`)
    await expect(h.db.transaction((tx) => lockAccess(tx, missing))).rejects.toThrow(
      `Server ${missing} has no access record`,
    )
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'reconciliation protects concurrent edits and deletions while saving untouched changes',
  async () => {
    const id = await server()
    const kept = entry('Kept'),
      changed = entry('Changed'),
      removed = entry('Removed'),
      gone = entry('Gone')
    const added = entry('Added by owner'),
      discovered = entry('Discovered in game')
    await h.db.transaction(async (tx) => {
      for (const value of [kept, changed, removed, gone]) await upsertEntry(tx, id, value, 'fixture-owner')
      await setWhitelistPending(tx, id, false)
    })
    const before = await readAccess(h.db, id)
    const edited = {
      ...changed,
      player: { ...changed.player, name: 'Newer owner name' },
      state: 'pending_remove' as const,
    }
    await h.db.transaction(async (tx) => {
      await upsertEntry(tx, id, edited, 'fixture-owner')
      await tx
        .update(schema.serverAccessEntries)
        .set({
          updatedAt: new Date((before.stamps.get(entryKey(changed.list, changed.player.uuid)) ?? 0) + 1),
        })
        .where(eq(schema.serverAccessEntries.playerUuid, changed.player.uuid))
      await deleteEntry(tx, id, removed)
      await upsertEntry(tx, id, added, 'fixture-owner')
      await setWhitelistPending(tx, id, true)
    })
    const reconciled = { ...kept, state: 'active' as const, error: null }
    const after = {
      ...before.record,
      whitelistEnabled: true,
      whitelistEnabledPending: null,
      reseedRequired: false,
      entries: [reconciled, changed, removed, discovered],
    }
    const version = await h.db.transaction((tx) => saveReconciled(tx, id, before, after))
    const read = await readAccess(h.db, id)
    expect(read.version).toBe(version)
    expect(version).toBe(before.version + 1)
    expect(read.record).toMatchObject({
      whitelistEnabled: true,
      whitelistEnabledPending: true,
      reseedRequired: false,
    })
    expect(read.record.entries).toEqual(expect.arrayContaining([reconciled, edited, added, discovered]))
    expect(read.record.entries).toHaveLength(4)
    expect(read.syncedAt).toBeInstanceOf(Date)
    expect(read.syncError).toBeNull()
    await h.db.transaction((tx) =>
      saveReconciled(tx, id, read, { ...read.record, whitelistEnabledPending: null }),
    )
    expect((await readAccess(h.db, id)).record.whitelistEnabledPending).toBeNull()
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'lifted IP history filters its server and action and returns the newest ten',
  async () => {
    const id = await server(),
      other = crypto.randomUUID()
    const since = new Date('2026-01-01T00:00:00Z')
    const rows = Array.from({ length: 12 }, (_, index) => ({
      actor: 'fixture',
      action: 'access.ip_ban_lifted',
      subjectType: 'server',
      subjectId: id,
      data: { ip: `192.0.2.${index}` },
      at: new Date(since.getTime() + index),
    }))
    const sample = rows[0]
    if (!sample) throw new Error('The audit fixture must contain a first record')
    await h.db
      .insert(schema.auditLog)
      .values([
        ...rows,
        { ...sample, subjectId: other },
        { ...sample, action: 'other.action' },
        { ...sample, subjectType: 'account' },
        { ...sample, at: new Date(since.getTime() - 1) },
      ])
    expect(await liftedIpBans(h.db, id, since)).toEqual(
      rows
        .toReversed()
        .slice(0, 10)
        .map((row) => ({ ip: row.data.ip, at: row.at.toISOString() })),
    )
    const missingIp = new Date(since.getTime() + 20)
    await h.db.insert(schema.auditLog).values({
      actor: 'fixture',
      action: 'access.ip_ban_lifted',
      subjectType: 'server',
      subjectId: id,
      data: {},
      at: missingIp,
    })
    expect(await liftedIpBans(h.db, id, missingIp)).toEqual([{ ip: '', at: missingIp.toISOString() }])
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'seeded imports record the system actor by default',
  async () => {
    const id = await server()
    const imported = entry('Imported')
    await h.db.transaction((tx) => createAccess(tx, id, { whitelistOn: false, entries: [imported] }))
    const [row] = await h.db
      .select()
      .from(schema.serverAccessEntries)
      .where(eq(schema.serverAccessEntries.playerUuid, imported.player.uuid))
    expect(row?.requestedBy).toBe('system')
    expect((await readAccess(h.db, id)).record.whitelistEnabledPending).toBeNull()
  },
  30 * SECOND_MS,
)
