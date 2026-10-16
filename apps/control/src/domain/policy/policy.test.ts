// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { entitlementsFor } from '../account/entitlements.ts'
import { newStanding } from '../account/standing.ts'
import type { MemoryTier } from '../server/size.ts'
import { evaluate, FULL, PER_MINUTE, type PolicyFacts } from './policy.ts'

/** A server playing plain Minecraft on this size. */
const plain = (tier: MemoryTier) => ({ tier, loader: 'vanilla' as const, modded: false })

const facts = (patch: Partial<PolicyFacts> = {}): PolicyFacts => ({
  deployment: { archives: false, billing: false },
  controls: {
    provisioningEnabled: true,
    startsEnabled: true,
    publicListingEnabled: true,
    uploadsEnabled: true,
    storingEnabled: true,
    expiringEnabled: false,
    maxServers: 40,
    maxRunningServers: 15,
    maxFreeAccounts: 30,
    dailySpendLimitCents: 1000,
  },
  standing: newStanding('u1'),
  serverCeiling: null,
  emailVerified: true,
  entitlements: entitlementsFor('free'),
  owned: { servers: 0, running: 0 },
  global: { servers: 0, running: 0 },
  room: { runtimes: true, queuedCreateMs: 0 },
  // No reserve and no free share, so the caps trip where they are set; `room.test.ts` has both.
  roomRules: { wakeReserve: 0, createWaitMs: MINUTE_MS, freeShare: 1 },
  createsInLastHour: 0,
  unitsThisMonth: 0,
  carriedThisMonth: 0,
  today: { left: 2, back: 'Back at midnight, in 3 h 12 min' },
  totalLeft: 20,
  extraUnitsAllowed: 0,
  extraOffBecause: null,
  extraMayRise: true,
  chippedInLeft: 0,
  owedCents: 0,
  actionsInLastMinute: 0,
  freeHeld: false,
  freeSharedBecause: null,
  ...patch,
})

describe('evaluate', () => {
  test('a new account may create a small server', () => {
    expect(evaluate(facts(), { kind: 'create_server', memoryTier: '3g' })).toEqual({ ok: true })
  })

  test('deployment support is checked before the plan', () => {
    const decision = evaluate(facts({ entitlements: entitlementsFor('free') }), { kind: 'upload_mod' })
    expect(decision).toMatchObject({ ok: false, code: 'deployment_unsupported' })
    const supported = facts({ deployment: { archives: true, billing: false } })
    expect(evaluate(supported, { kind: 'upload_mod' })).toMatchObject({ ok: false, code: 'not_entitled' })
    const both = facts({
      deployment: { archives: true, billing: false },
      entitlements: entitlementsFor('plus'),
    })
    expect(evaluate(both, { kind: 'upload_mod' })).toEqual({ ok: true })
    // Every plan downloads its own world, wherever the deployment keeps archives.
    expect(evaluate(supported, { kind: 'create_archive' })).toEqual({ ok: true })
    expect(evaluate(supported, { kind: 'download_archive' })).toEqual({ ok: true })
    expect(evaluate(facts(), { kind: 'download_archive' })).toMatchObject({ code: 'deployment_unsupported' })
  })

  test('the kill switch stops creation but not starting existing servers', () => {
    const paused = facts({ controls: { ...facts().controls, provisioningEnabled: false } })
    expect(evaluate(paused, { kind: 'create_server', memoryTier: '3g' })).toMatchObject({
      code: 'platform_paused',
    })
    expect(evaluate(paused, { kind: 'start_server', runs: plain('3g') })).toEqual({ ok: true })
  })

  test('suspension outranks entitlements', () => {
    const suspended = facts({ standing: { ...newStanding('u1'), status: 'suspended' } })
    expect(evaluate(suspended, { kind: 'start_server', runs: plain('3g') })).toMatchObject({
      code: 'account_suspended',
    })
  })

  test('plan limits count owned and running servers', () => {
    expect(
      evaluate(facts({ owned: { servers: 1, running: 0 } }), { kind: 'create_server', memoryTier: '3g' }),
    ).toMatchObject({
      code: 'limit_reached',
    })
    expect(
      evaluate(facts({ owned: { servers: 1, running: 1 } }), { kind: 'start_server', runs: plain('3g') }),
    ).toMatchObject({
      code: 'limit_reached',
    })
    expect(evaluate(facts(), { kind: 'create_server', memoryTier: '8g' })).toMatchObject({
      code: 'not_entitled',
    })
  })

  test('a restart keeps the running slot it holds, and nothing else changes', () => {
    const atLimits = facts({ owned: { servers: 1, running: 1 }, global: { servers: 15, running: 15 } })
    expect(evaluate(atLimits, { kind: 'restart_server', runs: plain('3g') })).toEqual({ ok: true })
    expect(evaluate(atLimits, { kind: 'restart_server', runs: plain('8g') })).toMatchObject({
      code: 'not_entitled',
    })
    const paused = facts({ controls: { ...facts().controls, startsEnabled: false } })
    expect(evaluate(paused, { kind: 'restart_server', runs: plain('3g') })).toMatchObject({
      code: 'platform_paused',
    })
    // The free plan's 2 hours a day.
    const today = (left: number) => facts({ today: { left, back: 'Back at midnight, in 3 h 12 min' } })
    expect(evaluate(today(0), { kind: 'restart_server', runs: plain('3g') })).toMatchObject({
      code: 'limit_reached',
    })
    expect(evaluate(today(0.5), { kind: 'start_server', runs: plain('3g') })).toEqual({ ok: true })
    // A size the free plan sold before still starts; a bigger one it never sold doesn't.
    expect(evaluate(facts(), { kind: 'start_server', runs: plain('4g') })).toEqual({ ok: true })
    expect(evaluate(facts(), { kind: 'create_server', memoryTier: '4g' })).toMatchObject({
      code: 'not_entitled',
    })
    expect(evaluate(facts(), { kind: 'start_server', runs: plain('8g') })).toMatchObject({
      code: 'not_entitled',
    })
  })

  test('a server playing what the plan does not run waits, whole, for the plan that does', () => {
    const modded = { tier: '3g' as const, loader: 'fabric' as const, modded: true }
    // Plus ended: the Cobblemon world stays exactly as it was and doesn't start on Free.
    const refused = evaluate(facts(), { kind: 'start_server', runs: modded })
    expect(refused).toMatchObject({ ok: false, code: 'not_entitled' })
    expect(refused.ok ? '' : refused.message).toBe(
      'Mods, plugins and modpacks come with Plus. Its world is safe, and it starts again with Plus.',
    )
    // An empty Fabric server is still a server type Free doesn't run.
    const fabric = evaluate(facts(), { kind: 'start_server', runs: { ...modded, modded: false } })
    expect(fabric.ok ? '' : fabric.message).toBe(
      'This server’s type comes with Plus. Its world is safe, and it starts again with Plus.',
    )
    // Plain Paper is plain Minecraft, and runs on Free.
    expect(evaluate(facts(), { kind: 'start_server', runs: { ...plain('3g'), loader: 'paper' } })).toEqual({
      ok: true,
    })
    const plus = facts({ entitlements: entitlementsFor('plus') })
    expect(evaluate(plus, { kind: 'start_server', runs: modded })).toEqual({ ok: true })
    // A 6 GB server made before it stopped being sold keeps starting on Plus.
    expect(evaluate(plus, { kind: 'restart_server', runs: plain('6g') })).toEqual({ ok: true })
    expect(evaluate(plus, { kind: 'create_server', memoryTier: '6g' })).toMatchObject({
      code: 'not_entitled',
    })
  })

  test('unverified email blocks creation only', () => {
    const unverified = facts({ emailVerified: false })
    expect(evaluate(unverified, { kind: 'create_server', memoryTier: '3g' })).toMatchObject({
      code: 'email_unverified',
    })
    expect(evaluate(unverified, { kind: 'start_server', runs: plain('3g') })).toEqual({ ok: true })
  })

  test('console commands and access changes wait once an account sends too many a minute', () => {
    for (const kind of ['console_command', 'manage_access'] as const) {
      expect(evaluate(facts({ actionsInLastMinute: PER_MINUTE[kind] - 1 }), { kind })).toEqual({ ok: true })
      expect(evaluate(facts({ actionsInLastMinute: PER_MINUTE[kind] }), { kind })).toMatchObject({
        ok: false,
        code: 'rate_limited',
      })
    }
    // A read-only console is a restriction, which says so before any count does.
    const readOnly = newStanding('u1')
    readOnly.restrictions = { consoleCommands: true }
    expect(
      evaluate(facts({ standing: readOnly, actionsInLastMinute: 99 }), { kind: 'console_command' }),
    ).toMatchObject({ code: 'restricted' })
  })

  test('stars and notes wait past a minute’s worth, and a note needs a confirmed email', () => {
    for (const kind of ['star_server', 'leave_note'] as const) {
      expect(evaluate(facts({ actionsInLastMinute: PER_MINUTE[kind] - 1 }), { kind })).toEqual({ ok: true })
      expect(evaluate(facts({ actionsInLastMinute: PER_MINUTE[kind] }), { kind })).toMatchObject({
        ok: false,
        code: 'rate_limited',
      })
      const suspended = facts({ standing: { ...newStanding('u1'), status: 'suspended' } })
      expect(evaluate(suspended, { kind })).toMatchObject({ code: 'account_suspended' })
    }
    // Writing where strangers read it takes an address someone confirmed; a star says nothing.
    const unverified = facts({ emailVerified: false })
    expect(evaluate(unverified, { kind: 'leave_note' })).toMatchObject({ code: 'email_unverified' })
    expect(evaluate(unverified, { kind: 'star_server' })).toEqual({ ok: true })
  })

  test('a server comes back from the trash only while it fits the plan and the platform', () => {
    expect(evaluate(facts({ owned: { servers: 0, running: 0 } }), { kind: 'undelete_server' })).toEqual({
      ok: true,
    })
    expect(evaluate(facts({ owned: { servers: 1, running: 0 } }), { kind: 'undelete_server' })).toMatchObject(
      {
        code: 'limit_reached',
        message: expect.stringContaining('Delete one to restore this'),
      },
    )
    expect(
      evaluate(facts({ global: { servers: 40, running: 0 } }), { kind: 'undelete_server' }),
    ).toMatchObject({
      code: 'limit_reached',
    })
    const suspended = newStanding('u1')
    suspended.status = 'suspended'
    expect(evaluate(facts({ standing: suspended }), { kind: 'undelete_server' })).toMatchObject({
      code: 'account_suspended',
    })
    // Nothing boots, so the switch on creating servers doesn't apply.
    const paused = facts()
    paused.controls.provisioningEnabled = false
    expect(evaluate(paused, { kind: 'undelete_server' })).toEqual({ ok: true })
  })

  test('a suspended owner may still change who can join; a closed account may not (§15.1)', () => {
    const suspended = facts({ standing: { ...newStanding('u1'), status: 'suspended' } })
    expect(evaluate(suspended, { kind: 'manage_access' })).toEqual({ ok: true })
    expect(evaluate(suspended, { kind: 'console_command' })).toMatchObject({ code: 'account_suspended' })
    const closed = facts({ standing: { ...newStanding('u1'), status: 'terminated' } })
    expect(evaluate(closed, { kind: 'manage_access' })).toMatchObject({ code: 'account_suspended' })
  })

  test('snapshot backups and restores need a plan that keeps snapshots, and good standing (§15.4)', () => {
    expect(evaluate(facts(), { kind: 'snapshot_backup' })).toEqual({ ok: true })
    expect(evaluate(facts(), { kind: 'restore_backup' })).toEqual({ ok: true })
    const none = entitlementsFor('free')
    const keepsNone = facts({
      entitlements: { ...none, backupPolicy: { ...none.backupPolicy, snapshotsKept: 0 } },
    })
    expect(evaluate(keepsNone, { kind: 'snapshot_backup' })).toMatchObject({
      ok: false,
      code: 'not_entitled',
    })
    expect(evaluate(keepsNone, { kind: 'restore_backup' })).toMatchObject({ ok: false, code: 'not_entitled' })
    const suspended = facts({ standing: { ...newStanding('u1'), status: 'suspended' } })
    expect(evaluate(suspended, { kind: 'snapshot_backup' })).toMatchObject({
      ok: false,
      code: 'account_suspended',
    })
    // Snapshots are no archive: they work on a deployment without one, and ignore the start switch.
    const paused = facts({ controls: { ...facts().controls, startsEnabled: false } })
    expect(evaluate(paused, { kind: 'restore_backup' })).toEqual({ ok: true })
  })

  test('the provider’s machine limit caps servers below the admins’ cap (§19.12)', () => {
    const ceiling = facts({ serverCeiling: 21, global: { servers: 21, running: 3 } })
    expect(evaluate(ceiling, { kind: 'create_server', memoryTier: '3g' })).toMatchObject({
      code: 'platform_full',
    })
    expect(
      evaluate(facts({ serverCeiling: 21, global: { servers: 20, running: 3 } }), {
        kind: 'create_server',
        memoryTier: '3g',
      }),
    ).toEqual({ ok: true })
  })

  test('global caps guard the platform, each step answering with its own code (§15.5)', () => {
    const full = facts({ global: { servers: 40, running: 3 } })
    expect(evaluate(full, { kind: 'create_server', memoryTier: '3g' })).toMatchObject({
      code: 'platform_full',
      message: FULL,
    })
    const busy = facts({ global: { servers: 3, running: 15 } })
    expect(evaluate(busy, { kind: 'start_server', runs: plain('3g') })).toMatchObject({
      code: 'limit_reached',
    })
    // The kill switch is its own step and code.
    const paused = facts({ controls: { ...facts().controls, startsEnabled: false } })
    expect(evaluate(paused, { kind: 'start_server', runs: plain('3g') })).toMatchObject({
      code: 'platform_paused',
    })
  })
})

describe('continuations', () => {
  test('a worker re-check sees switches and standing but not quotas', () => {
    const full = facts({ owned: { servers: 1, running: 1 } })
    expect(evaluate(full, { kind: 'continue_starting' })).toEqual({ ok: true })
    const paused = facts({ controls: { ...facts().controls, startsEnabled: false } })
    expect(evaluate(paused, { kind: 'continue_starting' })).toMatchObject({ code: 'platform_paused' })
    const suspended = facts({ standing: { ...newStanding('u1'), status: 'suspended' } })
    expect(evaluate(suspended, { kind: 'continue_provisioning' })).toMatchObject({
      code: 'account_suspended',
    })
  })
})

// Every cap that holds what Cubepals can spend, one step under its limit and at it.
// The schema's defaults: 30 servers, 10 running, Free's 1 and 1, 3 an hour.
describe('money guards at their trip points', () => {
  const launch = { ...facts().controls, maxServers: 30, maxRunningServers: 10 }
  const create = { kind: 'create_server', memoryTier: '3g' } as const
  const start = { kind: 'start_server', runs: plain('3g') } as const

  test('the platform runs ten at once: the tenth starts, the eleventh is told it is busy or full', () => {
    const nine = facts({ controls: launch, global: { servers: 20, running: 9 } })
    expect(evaluate(nine, start)).toEqual({ ok: true })
    expect(evaluate(nine, create)).toEqual({ ok: true })
    const ten = facts({ controls: launch, global: { servers: 20, running: 10 } })
    const busy = {
      ok: false,
      code: 'limit_reached',
      message: 'Cubepals is busy right now. Try again in a few minutes.',
    } as const
    expect(evaluate(ten, start)).toEqual(busy)
    expect(evaluate(ten, create)).toEqual({ ok: false, code: 'platform_full', message: FULL })
    // A restart keeps the slot it holds, so it is never the one over.
    expect(evaluate(ten, { kind: 'restart_server', runs: plain('3g') })).toEqual({ ok: true })
  })

  test('thirty servers in all, held to what the provider’s machines allow', () => {
    // Production's 67 machines, less the platform's 7, at two a server.
    const ceiling = Math.floor((67 - 7) / 2)
    expect(ceiling).toBe(30)
    const at = (servers: number, cap = launch.maxServers) =>
      facts({
        controls: { ...launch, maxServers: cap },
        serverCeiling: ceiling,
        global: { servers, running: 0 },
      })
    expect(evaluate(at(29), create)).toEqual({ ok: true })
    expect(evaluate(at(30), create)).toMatchObject({
      code: 'platform_full',
      message: expect.stringContaining('full'),
    })
    expect(evaluate(at(30), { kind: 'undelete_server' })).toMatchObject({ code: 'limit_reached' })
    // An admin's cap above the provider's still stops at the provider's.
    expect(evaluate(at(30, 100), create)).toMatchObject({ code: 'platform_full' })
  })

  test('a free account makes three servers an hour at most', () => {
    const plan = entitlementsFor('free', { maxServers: 10, maxRunning: 10 })
    expect(plan.createsPerHour).toBe(3)
    expect(evaluate(facts({ entitlements: plan, createsInLastHour: 2 }), create)).toEqual({ ok: true })
    expect(evaluate(facts({ entitlements: plan, createsInLastHour: 3 }), create)).toMatchObject({
      code: 'rate_limited',
    })
    const plus = entitlementsFor('plus', { maxServers: 20, maxRunning: 20 })
    expect(evaluate(facts({ entitlements: plus, createsInLastHour: 9 }), create)).toEqual({ ok: true })
    expect(evaluate(facts({ entitlements: plus, createsInLastHour: 10 }), create)).toMatchObject({
      code: 'rate_limited',
    })
  })

  test('Free has one server and runs one; Plus has three and runs two', () => {
    const free = entitlementsFor('free')
    expect(evaluate(facts({ entitlements: free, owned: { servers: 1, running: 0 } }), create)).toMatchObject({
      code: 'limit_reached',
    })
    expect(evaluate(facts({ entitlements: free, owned: { servers: 1, running: 0 } }), start)).toEqual({
      ok: true,
    })
    expect(evaluate(facts({ entitlements: free, owned: { servers: 1, running: 1 } }), start)).toMatchObject({
      code: 'limit_reached',
    })
    const plus = entitlementsFor('plus')
    expect(evaluate(facts({ entitlements: plus, owned: { servers: 2, running: 1 } }), start)).toEqual({
      ok: true,
    })
    expect(evaluate(facts({ entitlements: plus, owned: { servers: 3, running: 2 } }), start)).toMatchObject({
      code: 'limit_reached',
    })
    expect(evaluate(facts({ entitlements: plus, owned: { servers: 3, running: 0 } }), create)).toMatchObject({
      code: 'limit_reached',
    })
  })

  test('Free’s 2 hours a day and Plus’s 120 a month: the last minute starts, none past it', () => {
    const free = entitlementsFor('free')
    const back = 'Back at midnight, in 3 h 12 min'
    expect(evaluate(facts({ entitlements: free, today: { left: 0.01, back } }), start)).toEqual({ ok: true })
    // Out for today, a start or a wake from a join is told when play is back, in the words the
    // server page and the server list use.
    expect(evaluate(facts({ entitlements: free, today: { left: 0, back } }), start)).toEqual({
      ok: false,
      code: 'limit_reached',
      message: 'You’ve played today’s 2 hours. Back at midnight, in 3 h 12 min.',
    })
    // Free has no monthly total: any number of hours this month starts while today has some left.
    expect(
      evaluate(facts({ entitlements: free, unitsThisMonth: 60, today: { left: 1, back } }), start),
    ).toEqual({
      ok: true,
    })
    const plus = entitlementsFor('plus')
    expect(evaluate(facts({ entitlements: plus, today: null, unitsThisMonth: 119.9 }), start)).toEqual({
      ok: true,
    })
    expect(evaluate(facts({ entitlements: plus, unitsThisMonth: 120 }), start)).toMatchObject({
      code: 'limit_reached',
    })
    // Waking from a join is a start too, and a restart is held to the hours as well.
    expect(
      evaluate(facts({ entitlements: plus, unitsThisMonth: 120 }), {
        kind: 'restart_server',
        runs: plain('3g'),
      }),
    ).toMatchObject({ code: 'limit_reached' })
  })

  test('every kill switch stops its own spending, and only its own', () => {
    const off = (key: 'provisioningEnabled' | 'startsEnabled' | 'uploadsEnabled' | 'publicListingEnabled') =>
      facts({ deployment: { archives: true, billing: false }, controls: { ...launch, [key]: false } })
    expect(evaluate(off('provisioningEnabled'), create)).toMatchObject({ code: 'platform_paused' })
    expect(evaluate(off('provisioningEnabled'), { kind: 'continue_provisioning' })).toMatchObject({
      code: 'platform_paused',
    })
    expect(evaluate(off('provisioningEnabled'), start)).toEqual({ ok: true })
    for (const kind of ['start_server', 'restart_server'] as const)
      expect(evaluate(off('startsEnabled'), { kind, runs: plain('3g') })).toMatchObject({
        code: 'platform_paused',
      })
    expect(evaluate(off('startsEnabled'), { kind: 'continue_starting' })).toMatchObject({
      code: 'platform_paused',
    })
    expect(evaluate(off('startsEnabled'), { kind: 'restore_archive' })).toMatchObject({
      code: 'platform_paused',
    })
    expect(evaluate(off('startsEnabled'), create)).toEqual({ ok: true })
    const plus = { deployment: { archives: true, billing: false }, entitlements: entitlementsFor('plus') }
    for (const kind of ['upload_mod', 'upload_pack'] as const) {
      expect(
        evaluate(facts({ ...plus, controls: { ...launch, uploadsEnabled: false } }), { kind }),
      ).toMatchObject({
        code: 'platform_paused',
      })
      expect(evaluate(facts({ ...plus, controls: launch }), { kind })).toEqual({ ok: true })
    }
    expect(evaluate(off('publicListingEnabled'), { kind: 'list_publicly' })).toMatchObject({
      code: 'platform_paused',
    })
  })
})

describe('extra play and money owed', () => {
  const create = { kind: 'create_server', memoryTier: '3g' } as const
  const start = { kind: 'start_server', runs: plain('3g') } as const

  test('past the hours, a start says what would help: extra play allowed, off, or used up', () => {
    const plus = entitlementsFor('plus')
    const at = (patch: Partial<PolicyFacts>) =>
      evaluate(facts({ entitlements: plus, unitsThisMonth: 120, ...patch }), start)
    expect(at({ extraUnitsAllowed: 20 })).toEqual({ ok: true })
    expect(at({ unitsThisMonth: 140, extraUnitsAllowed: 20 })).toEqual({
      ok: false,
      code: 'limit_reached',
      message:
        'You have used the extra play you allowed this month. Raise it in your account, or wait for the 1st.',
    })
    // At the ceiling there is nothing to raise.
    expect(at({ unitsThisMonth: 140, extraUnitsAllowed: 20, extraMayRise: false })).toMatchObject({
      message: 'You have used the most extra play you can allow this month. It resets on the 1st.',
    })
    expect(at({})).toMatchObject({
      message: 'You have used this month’s play time. Allow extra play in your account, or wait for the 1st.',
    })
    expect(
      at({ extraOffBecause: 'Your last payment didn’t go through, so extra hours are off until it does.' }),
    ).toMatchObject({
      message:
        'You have used this month’s play time, and it resets on the 1st. Your last payment didn’t go through, so extra hours are off until it does.',
    })
  })

  test('past the hours, a server with hours chipped in left still starts, and only that one', () => {
    const plus = entitlementsFor('plus')
    const at = (patch: Partial<PolicyFacts>) =>
      evaluate(facts({ entitlements: plus, unitsThisMonth: 120, ...patch }), start)
    expect(at({ chippedInLeft: 3.5 })).toEqual({ ok: true })
    expect(at({ chippedInLeft: 0 })).toMatchObject({ ok: false, code: 'limit_reached' })
    // Owing still stops it: what was chipped in is the server's, the debt is the account's.
    expect(at({ chippedInLeft: 3.5, owedCents: 500 })).toMatchObject({ ok: false, code: 'payment_due' })
  })

  test('money owed stops starts and new servers, and nothing else', () => {
    const owed = facts({ entitlements: entitlementsFor('plus'), owedCents: 2000 })
    const due = {
      ok: false as const,
      code: 'payment_due' as const,
      message:
        'You owe $20.00 from a payment that didn’t go through. Pay it on your account, and your servers can start again.',
    }
    expect(evaluate(owed, start)).toEqual(due)
    expect(evaluate(owed, create)).toEqual(due)
    expect(evaluate(owed, { kind: 'restart_server', runs: plain('3g') })).toEqual(due)
    expect(evaluate(owed, { kind: 'continue_starting' })).toEqual(due)
    // A world is still theirs to look at, download and say who may join; paying is still open.
    expect(
      evaluate({ ...owed, deployment: { archives: true, billing: true } }, { kind: 'download_archive' }),
    ).toEqual({
      ok: true,
    })
    expect(evaluate(owed, { kind: 'manage_access' })).toEqual({ ok: true })
    expect(
      evaluate({ ...owed, deployment: { archives: false, billing: true } }, { kind: 'billing' }),
    ).toEqual({
      ok: true,
    })
  })
})

describe('free play', () => {
  test('a held free account starts and makes nothing, and paid play and looking go on', () => {
    const held = facts({ freeHeld: true })
    for (const capability of [
      { kind: 'start_server', runs: plain('3g') },
      { kind: 'restart_server', runs: plain('3g') },
      { kind: 'create_server', memoryTier: '3g' },
    ] as const)
      expect(evaluate(held, capability)).toMatchObject({ ok: false, code: 'restricted' })
    expect(evaluate(held, { kind: 'manage_access' })).toEqual({ ok: true })
    const paid = facts({ freeHeld: true, entitlements: entitlementsFor('plus') })
    expect(evaluate(paid, { kind: 'start_server', runs: plain('3g') })).toEqual({ ok: true })
  })

  test('shared free hours say why they ran out sooner, the day’s and the 20 alike', () => {
    const start = { kind: 'start_server', runs: plain('3g') } as const
    const back = 'Back at midnight, in 3 h 12 min'
    expect(evaluate(facts({ today: { left: 0, back }, freeSharedBecause: 'email' }), start)).toMatchObject({
      message:
        'You’ve played today’s 2 hours. Back at midnight, in 3 h 12 min. Your free trial is shared with your other Cubepals account at this email.',
    })
    expect(evaluate(facts({ totalLeft: 0, freeSharedBecause: 'players' }), start)).toMatchObject({
      message:
        'You’ve played the 20 hours of your free trial. Your worlds are kept, and Plus starts them again. Your free trial is shared with another Cubepals account the same player plays on.',
    })
  })
})

describe('Free’s 20 hours in all', () => {
  test('played out, a start is refused whatever is left today, and told what helps', () => {
    const free = entitlementsFor('free')
    const today = { left: 2, back: 'Back at midnight, in 3 h 12 min' }
    const start = { kind: 'start_server', runs: plain('3g') } as const
    expect(evaluate(facts({ entitlements: free, totalLeft: 0.01, today }), start)).toEqual({ ok: true })
    expect(evaluate(facts({ entitlements: free, totalLeft: 0, today }), start)).toEqual({
      ok: false,
      code: 'limit_reached',
      message:
        'You’ve played the 20 hours of your free trial. Your worlds are kept, and Plus starts them again.',
    })
  })
})
