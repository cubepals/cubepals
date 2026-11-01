// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Bedrock requests retain explicit choices and migrate only an eligible plain server to Paper. */
import { afterAll, describe, expect, test } from 'bun:test'
import { ONLINE_MODE_KEPT } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

let harness: ReturnType<typeof startHarness> | undefined
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})

async function fixture(loader: 'vanilla' | 'paper' | 'fabric' = 'vanilla') {
  harness ??= startHarness()
  const h = await harness
  const owner = await h.user('Steve', 'plus')
  const created = await h.create(owner, { loader, gameVersion: '26.2' })
  await h.until(created.id, 'running', 3 * SECOND_MS)
  await h.settled(created.id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, created.id, crypto.randomUUID())
  await h.until(created.id, 'stopped', 3 * SECOND_MS)
  await h.settled(created.id, 3 * SECOND_MS)
  const desired = async () => loadRevision(h.db, (await h.server(created.id)).desiredRevisionId)
  return { h, owner, id: created.id, desired }
}

async function paperChoices() {
  const { h, owner, id, desired } = await fixture('paper')
  const first = await desired()
  await h.app.revisions.changeBedrock(owner, id, false, crypto.randomUUID())
  expect(await desired()).toMatchObject({
    loader: 'paper',
    loaderVersion: first.loaderVersion,
    settings: { bedrock: false },
    reason: 'settings_changed',
    basedOnRevisionId: first.id,
  })
  const disabled = (await desired()).id
  await h.app.revisions.changeBedrock(owner, id, false, crypto.randomUUID())
  expect((await desired()).id).toBe(disabled)
  await h.app.revisions.changeOtherVersions(owner, id, 'off', crypto.randomUUID())
  await h.app.revisions.changeBedrock(owner, id, true, crypto.randomUUID())
  expect((await desired()).settings).toMatchObject({ bedrock: true, otherVersions: 'off' })
  expect((await desired()).reason).toBe('settings_changed')
  await h.app.revisions.changeOtherVersions(owner, id, 'on', crypto.randomUUID())
  expect((await desired()).settings.otherVersions).toBe('on')
}

async function legacyPlain() {
  const { h, owner, id, desired } = await fixture()
  await h.app.mods.changeVersion(
    owner,
    id,
    { loader: 'vanilla', gameVersion: '26.2', onPaper: false },
    [],
    crypto.randomUUID(),
  )
  const before = await desired()
  const settings = { ...before.settings }
  delete settings.bedrock
  delete settings.otherVersions
  // An existing server may predate both optional membership settings.
  await h.db.update(schema.serverRevisions).set({ settings }).where(eq(schema.serverRevisions.id, before.id))
  const pin = h.loaderBuilds.builds.get('paper') ?? null
  h.loaderBuilds.builds.set('paper', null)
  try {
    await expect(h.app.revisions.changeBedrock(owner, id, true, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'Bedrock players can’t join Minecraft 26.2 yet.',
    })
    expect((await desired()).id).toBe(before.id)
  } finally {
    h.loaderBuilds.builds.set('paper', pin)
  }
  await h.app.revisions.changeBedrock(owner, id, true, crypto.randomUUID())
  expect(await desired()).toMatchObject({
    loader: 'vanilla',
    loaderVersion: pin,
    settings: { bedrock: true, otherVersions: 'on' },
    reason: 'version_changed',
    basedOnRevisionId: before.id,
  })
  const saved = (await desired()).id
  await h.app.revisions.changeBedrock(owner, id, true, crypto.randomUUID())
  expect((await desired()).id).toBe(saved)
}

async function moddedRefusals() {
  const { h, owner, id, desired } = await fixture('fabric')
  const before = await desired()
  for (const value of [false, true])
    await expect(h.app.revisions.changeBedrock(owner, id, value, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'Bedrock players join only a server without mods.',
    })
  await expect(
    h.app.revisions.changeOtherVersions(owner, id, 'on', crypto.randomUUID()),
  ).rejects.toMatchObject({
    code: 'invalid_choice',
    message: 'Only a Paper server lets players on other versions in.',
  })
  expect((await desired()).id).toBe(before.id)
}

async function persistedSettings() {
  const { h, owner, id, desired } = await fixture()
  await h.app.revisions.changeAuthentication(owner, id, false, crypto.randomUUID())
  const before = await desired()
  // The game form cannot replace choices owned by the membership requests.
  const request = {
    ...before.settings,
    motd: '  A place to play  ',
    onlineMode: !before.settings.onlineMode,
    bedrock: before.settings.bedrock !== true,
    otherVersions: before.settings.otherVersions === 'off' ? 'on' : 'off',
  }
  await h.app.revisions.changeSettings(owner, id, request, crypto.randomUUID())
  expect(await desired()).toMatchObject({
    settings: { ...before.settings, motd: 'A place to play' },
    reason: 'settings_changed',
    basedOnRevisionId: before.id,
  })
  const audits = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id))
  expect(audits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: `user:${owner.userId}`,
        subjectType: 'server',
        action: 'server.settings_changed',
        data: { changes: [{ field: 'motd', from: before.settings.motd, to: 'A place to play' }] },
      }),
    ]),
  )
  await h.app.revisions.changeAuthentication(owner, id, true, crypto.randomUUID())
  const checked = (await desired()).id
  await h.db
    .update(schema.accountStanding)
    .set({ plan: 'free' })
    .where(eq(schema.accountStanding.userId, owner.userId))
  await expect(
    h.app.revisions.changeAuthentication(owner, id, false, crypto.randomUUID()),
  ).rejects.toMatchObject({
    code: 'not_entitled',
    message: ONLINE_MODE_KEPT,
  })
  expect((await desired()).id).toBe(checked)
}

describe.skipIf(!hasDatabase)('membership and persisted settings', () => {
  test(
    'Paper accepts Bedrock changes without overwriting an explicit other-versions choice',
    paperChoices,
    30 * SECOND_MS,
  )
  test(
    'legacy plain servers pin Paper and open other versions only after a successful request',
    legacyPlain,
    30 * SECOND_MS,
  )
  test('modded servers refuse membership changes without creating a revision', moddedRefusals, 30 * SECOND_MS)
  test(
    'game settings trim the public description and preserve authentication and membership',
    persistedSettings,
    30 * SECOND_MS,
  )
})
