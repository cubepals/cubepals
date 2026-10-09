import { describe, expect, test } from 'bun:test'
import type { AccessEntry, AccessRecord, ObservedAccess, PlayerRef } from './access.ts'
import {
  commandKey,
  importObserved,
  operatorsAndBansToWrite,
  planDelivery,
  settle,
  WAITS_FOR_JOIN,
  whitelistToWrite,
} from './reconcile.ts'

const steve: PlayerRef = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Steve' }
const alex: PlayerRef = { uuid: '22222222-2222-2222-2222-222222222222', name: 'Alex' }
const griefer: PlayerRef = { uuid: '33333333-3333-3333-3333-333333333333', name: 'Griefer' }

const files = (patch: Partial<ObservedAccess> = {}): ObservedAccess => ({
  onlineMode: true,
  whitelistEnabled: false,
  whitelist: [],
  operators: [],
  bans: [],
  ipBans: [],
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
})

describe('settle', () => {
  test('landed changes become active or leave the record', () => {
    const delivering = record({
      whitelistEnabledPending: true,
      entries: [entry('whitelist', steve, 'pending_add'), entry('operator', alex, 'pending_remove')],
    })
    const before = files({ operators: [{ ...alex, level: 4, bypassesPlayerLimit: false }] })
    const after = files({ whitelistEnabled: true, whitelist: [steve] })
    const { record: settled, undo } = settle(delivering, before, after, new Map())
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
    const { record: settled } = settle(delivering, files(), files(), failures)
    expect(settled.entries[0]).toMatchObject({ state: 'pending_add', error: 'connection reset' })
  })

  test('a name that resolved to another account is undone and rejected', () => {
    const newOwner: PlayerRef = { uuid: '44444444-4444-4444-4444-444444444444', name: 'steve' }
    const delivering = record({ entries: [entry('operator', steve, 'pending_add')] })
    const after = files({ operators: [{ ...newOwner, level: 4, bypassesPlayerLimit: false }] })
    const { record: settled, undo } = settle(delivering, files(), after, new Map())
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
    const { record: settled, undo } = settle(delivering, files(unchecked), after, new Map())
    expect(undo).toEqual([{ type: 'deop', player: named }])
    expect(settled.entries).toEqual([{ ...entry('operator', steve, 'pending_add'), error: WAITS_FOR_JOIN }])
  })

  test('a ban that did not land waits too, where a server that checks accounts refuses it', () => {
    const delivering = record({ entries: [entry('ban', griefer, 'pending_add')] })
    expect(settle(delivering, files(unchecked), files(unchecked), new Map()).record.entries[0]).toMatchObject(
      {
        state: 'pending_add',
        error: WAITS_FOR_JOIN,
      },
    )
    expect(settle(delivering, files(), files(), new Map()).record.entries[0]).toMatchObject({
      state: 'rejected',
    })
  })

  test('the whitelist never waits: Blockly writes it as the server keys it', () => {
    const delivering = record({ entries: [entry('whitelist', steve, 'pending_add')] })
    const after = files({ ...unchecked, whitelist: [steve] })
    expect(settle(delivering, files(unchecked), after, new Map()).record.entries[0]?.state).toBe('active')
  })
})
