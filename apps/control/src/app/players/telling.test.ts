// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player is told in chat what the server's owner did to them from their page: at once, or as
 * they join for what waited; never of a kick or a mode, which the game shows itself; and not at all
 * on a server whose owner turned it off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { TOLD_OF_PUT_BACK, toldOfPower, toldOfTrip, toldOnJoin } from './telling.ts'

test('what they are told of each power', () => {
  expect(toldOfPower({ kind: 'teleport', dimension: 'minecraft:the_nether', x: 5, y: 80, z: -2 })).toBe(
    'The server’s owner moved you to 5, 80, -2 in the Nether.',
  )
  expect(toldOfPower({ kind: 'to_player', to: randomUUID() }, 'Ana')).toBe(
    'The server’s owner sent you to Ana.',
  )
  expect(toldOfPower({ kind: 'give', item: 'golden_apple', count: 2 })).toBe(
    'The server’s owner gave you 2 golden apple.',
  )
  expect(toldOfPower({ kind: 'give', item: 'create:wrench', count: 1 })).toBe(
    'The server’s owner gave you 1 create:wrench.',
  )
  expect(toldOfPower({ kind: 'levels', levels: 1 })).toBe('The server’s owner gave you 1 level.')
  expect(toldOfPower({ kind: 'kick', reason: '' })).toBeNull()
  expect(toldOfTrip('spawn')).toBe('The server’s owner sent you to the spawn.')
  expect(TOLD_OF_PUT_BACK).toContain('at your feet')
})

test('as they join, of what waited', () => {
  expect(toldOnJoin({ kind: 'levels', what: '8' })).toBe(
    'While you were away, the server’s owner gave you 8 levels.',
  )
  expect(
    toldOnJoin({
      kind: 'give',
      what: JSON.stringify([
        { item: 'minecraft:diamond', count: 5 },
        { item: 'minecraft:torch', count: 16 },
      ]),
    }),
  ).toBe('While you were away, the server’s owner gave you 5 diamond, 16 torch.')
  expect(toldOnJoin({ kind: 'game_mode', what: 'creative' })).toBeNull()
})

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const kaiOn = async () => {
  const owner = await h.user()
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  const kai = { uuid: randomUUID(), name: 'Kai' }
  h.minecraft.join(id, kai)
  await h.app.schedules.presenceSync()
  return { owner, id, kai }
}

const toKai = (said: readonly string[]) => said.filter((line) => line.startsWith('to Kai: '))

describe.skipIf(!hasDatabase)('telling a player what was done to them', () => {
  test('told at once, never of a kick, and as they join of what waited', async () => {
    const { owner, id, kai } = await kaiOn()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 3 })
    await h.app.players.act(owner, id, kai.uuid, { kind: 'heal' })
    expect(toKai(h.minecraft.said(id))).toEqual([
      'to Kai: [Cubepals] The server’s owner gave you 3 diamond.',
      'to Kai: [Cubepals] The server’s owner healed and fed you.',
    ])

    await h.app.players.act(owner, id, kai.uuid, { kind: 'kick', reason: 'Bedtime' })
    await h.app.schedules.presenceSync()
    expect(toKai(h.minecraft.said(id))).toHaveLength(2)

    await h.app.players.act(owner, id, kai.uuid, { kind: 'levels', levels: 4 })
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    expect(toKai(h.minecraft.said(id)).at(-1)).toBe(
      'to Kai: [Cubepals] While you were away, the server’s owner gave you 4 levels.',
    )
  }, 30_000)

  test('nothing said on a server whose owner turned it off', async () => {
    const { owner, id, kai } = await kaiOn()
    expect((await h.app.queries.get(owner, id)).tellPlayers).toBe(true)
    await h.app.servers.tellPlayers.set(owner, id, false)
    expect((await h.app.queries.get(owner, id)).tellPlayers).toBe(false)
    await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 1 })
    expect(h.minecraft.heard(id)).toContain('give Kai minecraft:diamond 1')
    expect(toKai(h.minecraft.said(id))).toEqual([])

    const stranger = await h.user('stranger')
    await expect(h.app.servers.tellPlayers.set(stranger, id, true)).rejects.toThrow('Server was not found')
  }, 30_000)
})
