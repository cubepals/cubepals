// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Game field logic uses real settings and timing metadata without mounting a browser. */
import { afterAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase, startHarness } from '../../testing/harness.ts'

const fields = () => import('../../../../web/src/app/(app)/servers/[id]/settings/game-fields')
let harness, snapshot
async function recorded() {
  snapshot ??= (async () => {
    harness = await startHarness()
    const owner = await harness.user('Steve', 'plus')
    const server = await harness.create(owner)
    await harness.until(server.id, 'running')
    await harness.settled(server.id)
    return {
      h: harness,
      owner,
      server,
      view: await harness.app.queries.get(owner, server.id),
      options: await harness.app.queries.settingsOptions(owner, server.id),
    }
  })()
  return snapshot
}
afterAll(async () => {
  await harness?.close()
})

for (const [input, opening, expected] of [
  [[], true, ''],
  [['difficulty'], true, 'Difficulty'],
  [['difficulty'], false, 'difficulty'],
  [['pvp'], true, 'PvP'],
  [['pvp'], false, 'PvP'],
  [['difficulty', 'pvp'], true, 'Difficulty and PvP'],
  [['difficulty', 'pvp', 'defaultGameMode'], false, 'difficulty, PvP, and game mode'],
])
  test(`field names preserve grammar for ${input.join(',')} with opening=${opening}`, async () => {
    expect((await fields()).named(input, opening)).toBe(expected)
  })
test('the form retains every game field in its declared order', async () => {
  const { FIELDS, named } = await fields()
  expect(named(FIELDS)).toBe(
    'Difficulty, game mode, PvP, keep items when you die, server message, max players, spawn protection, view distance, and simulation distance',
  )
})

describe.skipIf(!hasDatabase)('game field logic from real server records', () => {
  test(
    'typed numbers round trip every numeric bound supplied by the control plane',
    async () => {
      const { view, options } = await recorded(),
        { typedFrom } = await fields()
      const typed = typedFrom(view.settings)
      expect(Object.keys(typed).sort()).toEqual(Object.keys(options.bounds).sort())
      for (const [key, value] of Object.entries(typed)) {
        expect(typeof value).toBe('string')
        expect(Number(value)).toBe(view.settings[key])
      }
    },
    30 * SECOND_MS,
  )
  test(
    'differences retain the real before values and only changed fields',
    async () => {
      const { view } = await recorded(),
        { differences } = await fields()
      expect(differences(view.settings, { ...view.settings })).toEqual([])
      expect(differences(view.settings, { ...view.settings, pvp: !view.settings.pvp })).toEqual([
        { field: 'pvp', from: view.settings.pvp, to: !view.settings.pvp },
      ])
      const legacy = { ...view.settings }
      delete legacy.keepInventory
      expect(differences(legacy, { ...legacy, keepInventory: true })).toEqual([
        { field: 'keepInventory', from: false, to: true },
      ])
      expect(
        differences({ ...legacy, keepInventory: true }, { ...legacy, keepInventory: undefined }),
      ).toEqual([{ field: 'keepInventory', from: true, to: false }])
    },
    30 * SECOND_MS,
  )
  test(
    'live, next-start and mixed changes explain exactly when each applies',
    async () => {
      const { view, options } = await recorded(),
        { FIELDS, onRunning } = await fields()
      const now = FIELDS.find((field) => options.takes[field] === 'now')
      const later = FIELDS.find((field) => options.takes[field] === 'next_start')
      if (!now || !later) throw new Error('The real options must offer a live rule and a server message')
      expect(onRunning(view, [], options.takes)).toBe('Nobody is sent away.')
      expect(onRunning(view, [now], options.takes)).toBe(
        'The game takes the change as people play, and nobody is sent away.',
      )
      expect(onRunning(view, [later], options.takes)).toBe(
        'Nobody is sent away. The new server message shows from the server’s next start.',
      )
      expect(onRunning(view, [now, later], options.takes)).toBe(
        'The game takes the change as people play, and nobody is sent away. The new server message shows from the server’s next start.',
      )
    },
    30 * SECOND_MS,
  )
  test(
    'one or several startup settings use singular or plural restart wording',
    async () => {
      const { view, options } = await recorded(),
        { FIELDS, named, onRunning } = await fields()
      const restarting = FIELDS.filter((field) => options.takes[field] === 'restart')
      if (restarting.length < 2) throw new Error('The real options must include multiple startup settings')
      const { whatHappens } = await import('../../../../web/src/app/(app)/servers/[id]/settings/shared')
      expect(onRunning(view, restarting.slice(0, 1), options.takes)).toBe(
        `${named(restarting.slice(0, 1))} needs a restart. ${whatHappens(view)}`,
      )
      expect(onRunning(view, restarting, options.takes)).toBe(
        `${named(restarting)} need a restart. ${whatHappens(view)}`,
      )
      expect(onRunning(view, FIELDS, options.takes)).toBe(
        `${named(restarting)} need a restart. ${whatHappens(view)}`,
      )
    },
    30 * SECOND_MS,
  )
  test(
    'a plan that needs a smaller size retains the real restart explanation',
    async () => {
      const { h, owner, server, options } = await recorded(),
        { onRunning } = await fields()
      const largest = options.partySizes
        .filter((size) => size.allowed)
        .sort((a, b) => b.maxPlayers - a.maxPlayers)[0]
      if (!largest) throw new Error('The real plan must allow a size')
      await h.app.revisions.resize(owner, server.id, largest.value, crypto.randomUUID())
      await h.settled(server.id)
      await h.db
        .update(schema.accountStanding)
        .set({ plan: 'free' })
        .where(eq(schema.accountStanding.userId, owner.userId))
      const view = await h.app.queries.get(owner, server.id)
      expect(view.movesToSize).not.toBeNull()
      const { whatHappens } = await import('../../../../web/src/app/(app)/servers/[id]/settings/shared')
      expect(onRunning(view, ['difficulty'], options.takes)).toBe(whatHappens(view))
    },
    30 * SECOND_MS,
  )
})
