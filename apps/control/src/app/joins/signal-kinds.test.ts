// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each kind of signal judged from joins (`signal-kinds.ts`), on fixed joins and a fixed setting of
 * the tests' own: what it raises, its key, and its figure and limit; and nothing for a kind the
 * setting leaves out.
 */
import { describe, expect, test } from 'bun:test'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { fromJoins, type JoinRow } from './signal-kinds.ts'

const NOW = new Date('2026-10-20T12:00:00.000Z')
const at = (secondsBefore: number) => new Date(NOW.getTime() - secondsBefore * 1000)

const row = (id: string, fields: Partial<JoinRow> = {}): JoinRow => ({
  id,
  kind: 'join',
  serverId: 'server-1',
  serverName: 'Castle',
  ours: false,
  address: 'castle.play.test',
  playerName: 'Steve',
  playerUuid: 'uuid-steve',
  path: 'direct',
  connectedAt: at(600),
  handedAt: at(599),
  loginAt: null,
  inWorldAt: null,
  leftAt: null,
  leftReason: null,
  pingedAfterAt: null,
  tick: null,
  serverSide: 'not_reported',
  wake: null,
  ...fields,
})

const raised = (config: SignalsConfig, rows: JoinRow[]) =>
  fromJoins(config, rows, NOW).map((r) => ({ key: r.key, detail: r.detail }))

describe('signals judged from joins', () => {
  test('nothing at all without a kind in the setting', () => {
    const joins = [row('a', { loginAt: at(500), leftAt: at(400), tick: { tps: 5, mspt: 200, online: 1 } })]
    expect(fromJoins({ watchedAddresses: ['castle'] }, joins, NOW)).toEqual([])
  })

  test('slow_join: login to world, ours by its own limit, and connect to world by the wake', () => {
    const config: SignalsConfig = {
      ourServers: 'official',
      slowJoin: { loginToWorldS: 10, loginToWorldOursS: 5, connectToWorldS: { stopped: 30 } },
    }
    const joins = [
      row('slow', { loginAt: at(100), inWorldAt: at(80) }),
      row('fine', { loginAt: at(100), inWorldAt: at(95) }),
      row('ours', { loginAt: at(100), inWorldAt: at(93), ours: true }),
      row('waiting', { loginAt: at(60) }),
      // Gone before the world: not still waiting, and left_while_loading's to tell.
      row('gone', { loginAt: at(60), leftAt: at(55) }),
      row('woke', { connectedAt: at(200), inWorldAt: at(140), wake: 'stopped' }),
      row('resumed', { connectedAt: at(200), inWorldAt: at(140), wake: 'memory' }),
    ]
    expect(raised(config, joins)).toEqual([
      {
        key: 'slow_join:slow:login',
        detail: expect.objectContaining({ figure: 20, limit: 10, server: 'Castle' }),
      },
      { key: 'slow_join:ours:login', detail: expect.objectContaining({ figure: 7, limit: 5 }) },
      { key: 'slow_join:waiting:login', detail: expect.objectContaining({ figure: 60, limit: 10 }) },
      {
        key: 'slow_join:woke:connect',
        detail: expect.objectContaining({ figure: 60, limit: 30, wake: 'stopped' }),
      },
    ])
  })

  test('left_while_loading, short_stay and kicked_early', () => {
    const config: SignalsConfig = {
      leftWhileLoading: {},
      shortStay: { underS: 30 },
      kickedEarly: { withinS: 60 },
    }
    const joins = [
      row('loading', { serverSide: 'reported', leftAt: at(500) }),
      row('unreported', { leftAt: at(500) }),
      row('gave-up', { path: 'held', leftAt: at(500), leftReason: 'gave_up_waiting' }),
      row('brief', {
        inWorldAt: at(300),
        leftAt: at(290),
        leftReason: 'disconnected',
        serverSide: 'reported',
      }),
      row('kicked', { inWorldAt: at(300), leftAt: at(280), leftReason: 'kicked', serverSide: 'reported' }),
      row('stayed', {
        inWorldAt: at(500),
        leftAt: at(10),
        leftReason: 'disconnected',
        serverSide: 'reported',
      }),
    ]
    expect(raised(config, joins).map((r) => r.key)).toEqual([
      'left_while_loading:loading',
      'left_while_loading:gave-up',
      'short_stay:brief',
      'kicked_early:kicked',
    ])
  })

  test('looked_back: pinged after leaving and not back in time; once the time is up', () => {
    const config: SignalsConfig = { lookedBack: { pingWithinS: 60, noRejoinS: 120 } }
    const gone = row('gone', { leftAt: at(300), pingedAfterAt: at(280) })
    const back = row('back', { leftAt: at(300), pingedAfterAt: at(280), playerUuid: 'uuid-alex' })
    const rejoined = row('rejoined', { connectedAt: at(250), playerUuid: 'uuid-alex' })
    const tooSoon = row('soon', { leftAt: at(60), pingedAfterAt: at(50), playerUuid: 'uuid-sam' })
    const late = row('late', { leftAt: at(400), pingedAfterAt: at(200), playerUuid: 'uuid-kim' })
    expect(raised(config, [gone, back, rejoined, tooSoon, late]).map((r) => r.key)).toEqual([
      'looked_back:gone',
    ])
  })

  test('watched_address and look_no_join, every look or in digests once each is over', () => {
    const watched = { watchedAddresses: ['castle'], watchedAddress: {} }
    const joins = [
      row('watched'),
      row('other', { address: 'keep.play.test' }),
      row('look-1', { kind: 'look', connectedAt: new Date('2026-10-20T11:31:00Z') }),
      row('look-2', { kind: 'look', connectedAt: new Date('2026-10-20T11:44:00Z') }),
      row('look-now', { kind: 'look', connectedAt: new Date('2026-10-20T12:00:00Z') }),
    ]
    expect(raised(watched, joins).map((r) => r.key)).toEqual(['watched_address:watched'])
    expect(raised({ ...watched, lookNoJoin: { watchedEveryOne: true } }, joins)).toHaveLength(4)
    expect(raised({ watchedAddresses: ['castle'], lookNoJoin: { digestMinutes: 30 } }, joins)).toEqual([
      {
        key: `look_no_join:castle.play.test:${Date.parse('2026-10-20T11:30:00Z')}`,
        detail: expect.objectContaining({ figure: 2, minutes: 30 }),
      },
    ])
  })

  test('crowd on one server, ours by its own limit; slow_tick', () => {
    const config: SignalsConfig = {
      ourServers: 'official',
      crowd: { playersIn10Min: 3, oursPlayersIn10Min: 2 },
      slowTick: { msptOver: 50 },
    }
    const players = ['a', 'b', 'c'].map((p) => row(`crowd-${p}`, { playerUuid: p, connectedAt: at(60) }))
    const ours = ['a', 'b'].map((p) =>
      row(`ours-${p}`, { serverId: 'ours', ours: true, playerUuid: p, connectedAt: at(60) }),
    )
    const ticking = row('ticking', { tick: { tps: 12, mspt: 80, online: 4 }, connectedAt: at(1_200) })
    expect(raised(config, [...players, ...ours, ticking]).map((r) => r.key)).toEqual([
      `crowd:server-1:${Date.parse('2026-10-20T12:00:00Z')}`,
      `crowd:ours:${Date.parse('2026-10-20T12:00:00Z')}`,
      'slow_tick:ticking',
    ])
  })
})
