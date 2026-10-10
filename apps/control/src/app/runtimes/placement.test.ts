// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { decidePlacement, type NewServer, type PlacementRule, rolloutBucket } from './placement.ts'

const server = (overrides: Partial<NewServer> = {}): NewServer => ({
  serverId: randomUUID(),
  ownerId: 'owner-a',
  plan: 'plus',
  regionKey: 'eu',
  memoryMb: 3072,
  storageGb: 10,
  ...overrides,
})

const rule = (overrides: Partial<PlacementRule> = {}): PlacementRule => ({
  id: randomUUID(),
  provider: 'fleet',
  enabled: true,
  percent: 100,
  accounts: [],
  regions: [],
  plans: [],
  note: '',
  ...overrides,
})

const targets = (room: Record<string, boolean> = {}, runs = ['fly', 'fleet'], full: string[] = []) => ({
  defaultProvider: 'fly',
  providers: runs,
  runs: (provider: string) => runs.includes(provider),
  atLimit: (provider: string) => full.includes(provider),
  hasRoom: async (provider: string) => room[provider] ?? true,
})

describe('placement', () => {
  test('with no rules every new server goes to the default runtime', async () => {
    const placed = await decidePlacement(server(), [], targets())
    expect(placed).toMatchObject({ provider: 'fly', ruleId: null, reason: 'the default runtime' })
    expect(placed.considered).toEqual([
      { provider: 'fly', ruleId: null, outcome: 'chosen', detail: 'the default runtime' },
    ])
  })

  test('an allowlisted account goes to the rule’s runtime; everyone else stays on the default', async () => {
    const canary = rule({ accounts: ['owner-a'], note: 'the five canary owners' })
    const listed = await decidePlacement(server({ ownerId: 'owner-a' }), [canary], targets())
    expect(listed).toMatchObject({ provider: 'fleet', ruleId: canary.id })
    expect(listed.considered.at(-1)?.detail).toBe('matched the rule: the five canary owners')
    const other = await decidePlacement(server({ ownerId: 'owner-b' }), [canary], targets())
    expect(other.provider).toBe('fly')
    expect(other.considered[0]).toMatchObject({
      outcome: 'not_matched',
      detail: 'its owner is not on the rule',
    })
  })

  test('regions and plans narrow a rule', async () => {
    const eu = rule({ regions: ['eu'], plans: ['plus'] })
    expect((await decidePlacement(server(), [eu], targets())).provider).toBe('fleet')
    expect((await decidePlacement(server({ regionKey: 'us' }), [eu], targets())).provider).toBe('fly')
    expect((await decidePlacement(server({ plan: 'free' }), [eu], targets())).provider).toBe('fly')
  })

  test('a share is stable per server and close to what was asked for', async () => {
    const five = rule({ percent: 5 })
    const ids = Array.from({ length: 4000 }, () => randomUUID())
    const chosen = await Promise.all(
      ids.map((serverId) => decidePlacement(server({ serverId }), [five], targets())),
    )
    const share = chosen.filter((placed) => placed.provider === 'fleet').length / ids.length
    expect(share).toBeGreaterThan(0.035)
    expect(share).toBeLessThan(0.065)
    // The same server lands the same way every time, and a bigger share keeps the ones already in.
    for (const serverId of ids.slice(0, 200)) {
      const bucket = rolloutBucket(five.id, serverId)
      expect(rolloutBucket(five.id, serverId)).toBe(bucket)
      const at5 = (await decidePlacement(server({ serverId }), [five], targets())).provider
      const at20 = (await decidePlacement(server({ serverId }), [{ ...five, percent: 20 }], targets()))
        .provider
      if (at5 === 'fleet') expect(at20).toBe('fleet')
    }
    expect((await decidePlacement(server(), [rule({ percent: 0 })], targets())).provider).toBe('fly')
  })

  test('a runtime with no room is passed over for the next rule, then the default, and that is recorded', async () => {
    const fleet = rule()
    const placed = await decidePlacement(server(), [fleet], targets({ fleet: false }))
    expect(placed).toMatchObject({
      provider: 'fly',
      ruleId: null,
      reason: 'the default runtime: fleet had no room',
    })
    expect(placed.considered[0]).toMatchObject({ provider: 'fleet', outcome: 'no_room' })
    const boat = rule({ provider: 'boat' })
    const next = await decidePlacement(
      server(),
      [fleet, boat],
      targets({ fleet: false }, ['fly', 'fleet', 'boat']),
    )
    expect(next).toMatchObject({ provider: 'boat', ruleId: boat.id })
  })

  test('a runtime at its provider’s limit takes nothing; a full default overflows to one with room', async () => {
    const fleet = rule()
    const capped = await decidePlacement(server(), [fleet], targets({}, ['fly', 'fleet'], ['fleet']))
    expect(capped.provider).toBe('fly')
    expect(capped.considered[0]).toMatchObject({ provider: 'fleet', outcome: 'no_room' })
    const overflow = await decidePlacement(server(), [], targets({}, ['fly', 'fleet'], ['fly']))
    // No rule sent it: it has no fallback, and waits for room where it went (`fallbackFor`).
    expect(overflow).toMatchObject({
      provider: 'fleet',
      ruleId: null,
      reason: "overflow: fly is at its provider's limit",
    })
    // Nowhere with room: the default, where the server waits for room as it always has.
    const nowhere = await decidePlacement(server(), [], targets({ fleet: false }, ['fly', 'fleet'], ['fly']))
    expect(nowhere.provider).toBe('fly')
    expect(nowhere.reason).toBe('the default runtime: fly, fleet had no room')
  })

  test('a disabled rule, or one for a runtime this deployment doesn’t run, places nothing', async () => {
    // A rule that is off isn't considered at all: the decision lists only what placed the server.
    const off = await decidePlacement(server(), [rule({ enabled: false })], targets())
    expect(off.provider).toBe('fly')
    expect(off.considered).toEqual([
      { provider: 'fly', ruleId: null, outcome: 'chosen', detail: 'the default runtime' },
    ])
    const elsewhere = await decidePlacement(server(), [rule({ provider: 'boat' })], targets())
    expect(elsewhere.provider).toBe('fly')
    expect(elsewhere.considered[0]).toMatchObject({ provider: 'boat', outcome: 'not_run' })
  })

  test('the first matching rule wins, so a rule for the default runtime can keep accounts off a canary', async () => {
    const keep = rule({ provider: 'fly', accounts: ['owner-a'] })
    const canary = rule()
    expect(await decidePlacement(server({ ownerId: 'owner-a' }), [keep, canary], targets())).toMatchObject({
      provider: 'fly',
      ruleId: keep.id,
    })
    expect((await decidePlacement(server({ ownerId: 'owner-b' }), [keep, canary], targets())).provider).toBe(
      'fleet',
    )
  })
})
