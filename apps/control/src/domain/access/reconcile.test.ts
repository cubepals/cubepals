// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  type AccessCommand,
  type AccessEntry,
  type AccessRecord,
  newAccessRecord,
  type ObservedAccess,
  type PlayerRef,
} from './access.ts'
import {
  commandKey,
  importObserved,
  operatorsAndBansToWrite,
  planDelivery,
  settle,
  WAITS_FOR_JOIN,
  WAITS_FOR_START,
  whitelistToWrite,
} from './reconcile.ts'

const steve: PlayerRef = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Steve' }
const alex: PlayerRef = { uuid: '22222222-2222-2222-2222-222222222222', name: 'Alex' }
const griefer: PlayerRef = { uuid: '33333333-3333-3333-3333-333333333333', name: 'Griefer' }

/** No player the console can name only once the server has met them, as on a server without Bedrock. */
const javaOnly = () => false

const files = (patch: Partial<ObservedAccess> = {}): ObservedAccess => ({
  onlineMode: true,
  whitelistEnabled: false,
  whitelist: [],
  operators: [],
  bans: [],
  ipBans: [],
  helpers: null,
  unchecked: null,
  stopCheaters: null,
  pluginBans: false,
  ...patch,
})

const entry = (list: AccessEntry['list'], player: PlayerRef, state: AccessEntry['state']): AccessEntry => ({
  list,
  player,
  state,
  origin: 'blockly',
  details: {},
  error: null,
})

const record = (patch: Partial<AccessRecord> = {}): AccessRecord => ({
  whitelistEnabled: false,
  whitelistEnabledPending: null,
  reseedRequired: false,
  entries: [],
  ...patch,
})

describe('command failure attribution', () => {
  test('an unseeded access record starts independently of records already being delivered', () => {
    const first = newAccessRecord()
    expect(first).toEqual({
      whitelistEnabled: false,
      whitelistEnabledPending: null,
      reseedRequired: true,
      entries: [],
    })
    first.entries.push(entry('whitelist', steve, 'pending_add'))
    expect(newAccessRecord().entries).toEqual([])
  })

  test('server-wide commands and kicks do not claim a player-list entry', () => {
    const commands: AccessCommand[] = [
      { type: 'whitelist_mode', enabled: true },
      { type: 'whitelist_mode', enabled: false },
      { type: 'pardon_ip', ip: '203.0.113.7' },
      { type: 'whitelist_reload' },
      { type: 'kick', player: griefer, reason: 'griefing' },
    ]
    // A failed kick must not mark the later ban as failed; reloading and mode changes likewise
    // have no individual entry to settle, even when other changes are being delivered.
    for (const command of commands) expect(commandKey(command)).toBeNull()
  })

  test('opposite operations identify the same entry, while players and lists stay distinct', () => {
    const pairs: [AccessCommand, AccessCommand][] = [
      [
        { type: 'whitelist_add', player: steve },
        { type: 'whitelist_remove', player: steve },
      ],
      [
        { type: 'op', player: steve },
        { type: 'deop', player: steve },
      ],
      [
        { type: 'ban', player: steve, reason: null },
        { type: 'pardon', player: steve },
      ],
      [
        { type: 'helper_add', player: steve },
        { type: 'helper_remove', player: steve },
      ],
      [
        { type: 'unchecked_add', player: steve },
        { type: 'unchecked_remove', player: steve },
      ],
    ]
    const keys = pairs.map(([add, remove]) => {
      const key = commandKey(add)
      expect(key).not.toBeNull()
      expect(commandKey(remove)).toBe(key)
      return key
    })
    expect(new Set(keys).size).toBe(pairs.length)
    expect(commandKey({ type: 'op', player: alex })).not.toBe(commandKey({ type: 'op', player: steve }))
    expect(commandKey({ type: 'ban', player: steve, reason: 'griefing' })).toBe(
      commandKey({ type: 'ban', player: steve, reason: null }),
    )
    const differentlyCased = { uuid: 'ABCDEF01-2345-6789-ABCD-EF0123456789', name: 'Steve' }
    expect(commandKey({ type: 'op', player: differentlyCased })).toBe(
      'operator:abcdef01-2345-6789-abcd-ef0123456789',
    )
  })
})

describe('importObserved', () => {
  test('in-game additions become game-origin entries and in-game removals drop entries', () => {
    const before = record({ entries: [entry('whitelist', steve, 'active')] })
    const imported = importObserved(
      before,
      files({ whitelist: [alex], operators: [{ ...alex, level: 4, bypassesPlayerLimit: false }] }),
    )
    expect(imported.entries).toEqual([
      { list: 'whitelist', player: alex, state: 'active', origin: 'game', details: {}, error: null },
      {
        list: 'operator',
        player: alex,
        state: 'active',
        origin: 'game',
        details: { level: 4, bypassesPlayerLimit: false },
        error: null,
      },
    ])
  })

  test('entries Blockly is still delivering are left alone', () => {
    const before = record({ entries: [entry('whitelist', steve, 'pending_add')] })
    expect(importObserved(before, files()).entries).toEqual(before.entries)
  })

  test('the whitelist mode follows the files unless a change is waiting', () => {
    expect(importObserved(record(), files({ whitelistEnabled: true })).whitelistEnabled).toBe(true)
    const waiting = record({ whitelistEnabled: false, whitelistEnabledPending: false })
    expect(importObserved(waiting, files({ whitelistEnabled: true })).whitelistEnabled).toBe(false)
  })
})

describe('planDelivery', () => {
  test('the whitelist is written whole; the switch and IP bans follow as commands', () => {
    const wanted = record({
      whitelistEnabledPending: true,
      entries: [entry('whitelist', steve, 'pending_add')],
    })
    const observed = files({ ipBans: [{ ip: '10.0.0.1' }] })
    // The reconciler writes this and reloads it before any command runs, so switching the
    // whitelist on never kicks someone who is being added.
    expect(whitelistToWrite(observed, wanted)).toEqual([steve])
    expect(planDelivery(observed, wanted)).toEqual([
      { type: 'pardon_ip', ip: '10.0.0.1' },
      { type: 'whitelist_mode', enabled: true },
    ])
    expect(whitelistToWrite(files({ whitelist: [steve] }), wanted)).toBeNull()
  })

  test('operators and bans are written only where the files hold someone else', () => {
    const wanted = record({
      entries: [entry('operator', steve, 'active'), entry('ban', griefer, 'pending_add')],
    })
    const op = { ...steve, level: 4, bypassesPlayerLimit: false }
    const ban = { ...griefer, reason: null, source: null, expiresAt: null }
    expect(operatorsAndBansToWrite(files({ operators: [op], bans: [ban] }), wanted)).toBeNull()
    expect(operatorsAndBansToWrite(files({ operators: [op] }), wanted)).toEqual({
      operators: [op],
      bans: [ban],
    })
  })

  test('a reseed removes whatever the restored files carried that the record does not', () => {
    const wanted = record({ reseedRequired: true, entries: [entry('ban', griefer, 'active')] })
    const restored = files({ operators: [{ ...alex, level: 4, bypassesPlayerLimit: false }] })
    expect(planDelivery(restored, wanted)).toEqual([
      { type: 'ban', player: griefer, reason: null },
      { type: 'deop', player: alex },
    ])
  })
  test('a ban with a reason first turns the player out with it', () => {
    const banned = { ...entry('ban', griefer, 'pending_add'), details: { reason: 'griefing' } }
    expect(planDelivery(files(), record({ entries: [banned] }))).toEqual([
      { type: 'kick', player: griefer, reason: 'griefing' },
      { type: 'ban', player: griefer, reason: 'griefing' },
    ])
  })
})

describe('a Bedrock player the server has not met', () => {
  const pixel: PlayerRef = { uuid: '00000000-0000-0000-0009-01eed05d1000', name: '.Pixel' }
  const held = { ...pixel, reason: null, source: null, expiresAt: null }
  const bedrock = (p: PlayerRef) => p === pixel

  test('one the console could not name waits, rather than being rejected', () => {
    const add = record({ entries: [entry('ban', pixel, 'pending_add')] })
    expect(settle(add, files(), files(), new Map(), bedrock).record.entries).toEqual([
      { ...entry('ban', pixel, 'pending_add'), error: WAITS_FOR_JOIN },
    ])
    const remove = record({ entries: [entry('ban', pixel, 'pending_remove')] })
    expect(
      settle(remove, files({ bans: [held] }), files({ bans: [held] }), new Map(), bedrock).record.entries,
    ).toEqual([{ ...entry('ban', pixel, 'pending_remove'), error: WAITS_FOR_START }])
    // An operator is named the same way, and waits for them to join just the same.
    const op = record({ entries: [entry('operator', pixel, 'pending_add')] })
    expect(settle(op, files(), files(), new Map(), bedrock).record.entries).toEqual([
      { ...entry('operator', pixel, 'pending_add'), error: WAITS_FOR_JOIN },
    ])
  })
})

describe('settle', () => {
  test('landed changes become active or leave the record', () => {
    const delivering = record({
      whitelistEnabledPending: true,
      entries: [entry('whitelist', steve, 'pending_add'), entry('operator', alex, 'pending_remove')],
    })
    const before = files({ operators: [{ ...alex, level: 4, bypassesPlayerLimit: false }] })
    const after = files({ whitelistEnabled: true, whitelist: [steve] })
    const { record: settled, undo } = settle(delivering, before, after, new Map(), javaOnly)
    expect(undo).toEqual([])
    expect(settled).toEqual({
      whitelistEnabled: true,
      whitelistEnabledPending: null,
      reseedRequired: false,
      entries: [{ ...entry('whitelist', steve, 'active') }],
    })
  })

  test('a transport failure keeps the entry pending with its error', () => {
    const delivering = record({ entries: [entry('whitelist', steve, 'pending_add')] })
    const failures = new Map([
      [commandKey({ type: 'whitelist_add', player: steve }) ?? '', 'connection reset'],
    ])
    const { record: settled } = settle(delivering, files(), files(), failures, javaOnly)
    expect(settled.entries[0]).toMatchObject({ state: 'pending_add', error: 'connection reset' })
  })

  test('a name that resolved to another account is undone and rejected', () => {
    const newOwner: PlayerRef = { uuid: '44444444-4444-4444-4444-444444444444', name: 'steve' }
    const delivering = record({ entries: [entry('operator', steve, 'pending_add')] })
    const after = files({ operators: [{ ...newOwner, level: 4, bypassesPlayerLimit: false }] })
    const { record: settled, undo } = settle(delivering, files(), after, new Map(), javaOnly)
    expect(undo).toEqual([{ type: 'deop', player: newOwner }])
    expect(settled.entries[0]).toMatchObject({ state: 'rejected' })
  })
})

describe('settle, on a server that does not check accounts', () => {
  const unchecked = { onlineMode: false }
  // How such a server's console names Steve when it has never met him: as an account would be.
  const named = { ...steve, uuid: '44444444-4444-4444-4444-444444444444' }

  test('an operator the server put under someone else is taken off, and waits for Steve to join', () => {
    const delivering = record({ entries: [entry('operator', steve, 'pending_add')] })
    const after = files({ ...unchecked, operators: [{ ...named, level: 4, bypassesPlayerLimit: false }] })
    const { record: settled, undo } = settle(delivering, files(unchecked), after, new Map(), javaOnly)
    expect(undo).toEqual([{ type: 'deop', player: named }])
    expect(settled.entries).toEqual([{ ...entry('operator', steve, 'pending_add'), error: WAITS_FOR_JOIN }])
  })

  test('a ban that did not land waits too, where a server that checks accounts refuses it', () => {
    const delivering = record({ entries: [entry('ban', griefer, 'pending_add')] })
    expect(
      settle(delivering, files(unchecked), files(unchecked), new Map(), javaOnly).record.entries[0],
    ).toMatchObject({
      state: 'pending_add',
      error: WAITS_FOR_JOIN,
    })
    expect(settle(delivering, files(), files(), new Map(), javaOnly).record.entries[0]).toMatchObject({
      state: 'rejected',
    })
  })

  test('the whitelist never waits: Blockly writes it as the server keys it', () => {
    const delivering = record({ entries: [entry('whitelist', steve, 'pending_add')] })
    const after = files({ ...unchecked, whitelist: [steve] })
    expect(settle(delivering, files(unchecked), after, new Map(), javaOnly).record.entries[0]?.state).toBe(
      'active',
    )
  })
})

describe('helpers', () => {
  const tools = { helpers: [] as PlayerRef[] }

  test('where the moderation tools run, helpers are delivered by UUID and read back from LuckPerms', () => {
    const naming = record({ entries: [entry('helper', alex, 'pending_add')] })
    expect(planDelivery(files(tools), naming)).toEqual([{ type: 'helper_add', player: alex }])
    const after = files({ helpers: [{ ...alex, name: '' }] })
    // LuckPerms keeps no name for someone who hasn't joined: the record's stays.
    expect(settle(naming, files(tools), after, new Map(), javaOnly).record.entries[0]).toMatchObject({
      state: 'active',
      player: alex,
    })
    // A helper named in game is imported, one taken off in game drops out.
    const imported = importObserved(
      record({ entries: [entry('helper', steve, 'active')] }),
      files({ helpers: [alex] }),
    )
    expect(imported.entries).toEqual([
      { list: 'helper', player: alex, state: 'active', origin: 'game', details: {}, error: null },
    ])
  })

  test('where they don’t run, helpers are left as they are: never dropped, never delivered', () => {
    const held = record({ entries: [entry('helper', alex, 'active'), entry('helper', steve, 'pending_add')] })
    expect(importObserved(held, files()).entries).toEqual(held.entries)
    expect(planDelivery(files(), held)).toEqual([])
    expect(settle(held, files(), files(), new Map(), javaOnly).record.entries).toEqual(held.entries)
  })

  test('helpers never wait to join, and are never written into the operator and ban files', () => {
    const naming = record({ entries: [entry('helper', alex, 'pending_add')] })
    const unchecked = { onlineMode: false, helpers: [] as PlayerRef[] }
    expect(
      settle(naming, files(unchecked), files(unchecked), new Map(), javaOnly).record.entries[0]?.state,
    ).toBe('rejected')
    expect(
      operatorsAndBansToWrite(files(), record({ entries: [entry('helper', alex, 'active')] })),
    ).toBeNull()
  })
})

describe('reconciliation preserves identities and delivery state', () => {
  test('observed metadata refreshes existing entries without losing absent rejections', () => {
    const heldBan = { ...entry('ban', steve, 'active'), details: { reason: 'old' }, error: 'old error' }
    const rejected = { ...entry('whitelist', alex, 'rejected'), error: 'not accepted' }
    const renamed = { ...steve, name: 'SteveNow' }
    const expiresAt = '2027-01-01T00:00:00Z'
    const observed = files({
      bans: [
        { ...renamed, reason: 'griefing', source: 'Console', expiresAt },
        { ...alex, reason: null, source: null, expiresAt: null },
      ],
    })
    const imported = importObserved(
      record({ entries: [heldBan, rejected, entry('operator', griefer, 'active')] }),
      observed,
    )
    expect(imported.entries).toEqual([
      {
        ...heldBan,
        player: renamed,
        details: { reason: 'griefing', source: 'Console', expiresAt },
        error: null,
      },
      rejected,
      { list: 'ban', player: alex, state: 'active', origin: 'game', details: {}, error: null },
    ])
  })

  test('delivery removes obsolete memberships and never re-adds removed or rejected entries', () => {
    const observed = files({
      operators: [{ ...steve, level: 4, bypassesPlayerLimit: false }],
      bans: [{ ...alex, reason: null, source: null, expiresAt: null }],
      helpers: [griefer],
      unchecked: [steve],
    })
    const wanted = record({
      entries: [
        entry('operator', alex, 'active'),
        entry('ban', steve, 'pending_add'),
        entry('ban', alex, 'pending_remove'),
        entry('helper', griefer, 'pending_remove'),
        entry('helper', alex, 'pending_add'),
        entry('unchecked', steve, 'rejected'),
        entry('unchecked', alex, 'pending_add'),
      ],
    })
    expect(planDelivery(observed, wanted)).toEqual([
      { type: 'op', player: alex },
      { type: 'pardon', player: alex },
      { type: 'ban', player: steve, reason: null },
      { type: 'deop', player: steve },
      { type: 'helper_add', player: alex },
      { type: 'helper_remove', player: griefer },
      { type: 'unchecked_add', player: alex },
      { type: 'unchecked_remove', player: steve },
    ])
  })

  test('unchecked entries wait untouched without the plugin and settle from its actual membership', () => {
    const held = record({
      entries: [
        entry('unchecked', alex, 'active'),
        entry('unchecked', steve, 'pending_add'),
        entry('unchecked', griefer, 'pending_remove'),
      ],
    })
    expect(importObserved(held, files()).entries).toEqual(held.entries)
    expect(planDelivery(files(), held)).toEqual([])
    expect(settle(held, files(), files(), new Map(), javaOnly).record.entries).toEqual(held.entries)
    const before = files({ unchecked: [alex, griefer] })
    const after = files({ unchecked: [alex, steve] })
    expect(planDelivery(before, held)).toEqual([
      { type: 'unchecked_add', player: steve },
      { type: 'unchecked_remove', player: griefer },
    ])
    expect(settle(held, before, after, new Map(), javaOnly).record.entries).toEqual([
      entry('unchecked', alex, 'active'),
      entry('unchecked', steve, 'active'),
    ])
  })

  test('matching list sizes do not hide a different player and UUID casing does not create one', () => {
    const named = { uuid: 'ABCDEF01-2345-6789-ABCD-EF0123456789', name: 'Steve' }
    const wanted = record({ entries: [entry('whitelist', named, 'active')] })
    expect(whitelistToWrite(files({ whitelist: [alex] }), wanted)).toEqual([named])
    expect(
      whitelistToWrite(files({ whitelist: [{ ...named, uuid: named.uuid.toLowerCase() }] }), wanted),
    ).toBeNull()
    const pair = record({
      entries: [entry('whitelist', steve, 'active'), entry('whitelist', alex, 'active')],
    })
    expect(whitelistToWrite(files({ whitelist: [alex, steve] }), pair)).toBeNull()
  })

  test('startup files replace different identities and preserve explicit permission and ban details', () => {
    const expiresAt = '2027-01-01T00:00:00Z'
    const wanted = record({
      entries: [
        { ...entry('operator', steve, 'active'), details: { level: 0, bypassesPlayerLimit: true } },
        { ...entry('ban', alex, 'active'), details: { reason: 'griefing', source: 'Console', expiresAt } },
      ],
    })
    const observed = files({
      operators: [{ ...alex, level: 4, bypassesPlayerLimit: false }],
      bans: [{ ...griefer, reason: null, source: null, expiresAt: null }],
    })
    expect(operatorsAndBansToWrite(observed, wanted)).toEqual({
      operators: [{ ...steve, level: 0, bypassesPlayerLimit: true }],
      bans: [{ ...alex, reason: 'griefing', source: 'Console', expiresAt }],
    })
  })

  test('a failed removal keeps its specific failure or naming wait until the files confirm removal', () => {
    const cases: Array<{ list: 'operator' | 'ban'; observed: Partial<ObservedAccess>; wait: string }> = [
      {
        list: 'operator',
        observed: { operators: [{ ...steve, level: 4, bypassesPlayerLimit: false }] },
        wait: WAITS_FOR_JOIN,
      },
      {
        list: 'ban',
        observed: { bans: [{ ...steve, reason: null, source: null, expiresAt: null }] },
        wait: WAITS_FOR_START,
      },
    ]
    for (const { list, observed, wait } of cases) {
      const pending = entry(list, steve, 'pending_remove')
      const wanted = record({ entries: [pending] })
      const stillThere = files({ ...observed, onlineMode: false })
      const failures = new Map([[`${list}:${steve.uuid}`, 'connection reset']])
      expect(settle(wanted, stillThere, stillThere, new Map(), javaOnly).record.entries).toEqual([
        { ...pending, error: wait },
      ])
      expect(settle(wanted, stillThere, stillThere, failures, javaOnly).record.entries).toEqual([
        { ...pending, error: 'connection reset' },
      ])
      expect(settle(wanted, stillThere, files(), failures, javaOnly).record.entries).toEqual([])
    }
  })
})
