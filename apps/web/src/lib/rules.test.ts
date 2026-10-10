// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  AddNoteInput,
  AddPlayerInput,
  CreateServerInput,
  CreateWorldInput,
  PlatformControlsInput,
  SaveIdentityInput,
} from '@blockly/contracts'
import * as rules from './rules'

/**
 * The words are Blockly's; the bounds are the API's. These check the two still agree, so a
 * field can never accept something the server then refuses, or refuse something it would take.
 */
describe('what Blockly says about what was typed', () => {
  test('an address that is wrong says which part of it is', () => {
    expect(rules.address('')).toBeNull()
    expect(rules.address('sunset-valley')).toBeNull()
    expect(rules.address('ab')).toContain('at least 3')
    expect(rules.address('a'.repeat(41))).toContain('up to 40')
    expect(rules.address('sunset valley')).toContain('letters, numbers and hyphens')
    expect(rules.address('-sunset')).toContain('between words')
    expect(rules.address('sunset--valley')).toContain('between words')
  })

  test('an email says what an email looks like, and an empty field says nothing yet', () => {
    expect(rules.email('')).toBeNull()
    expect(rules.email('  ')).toBeNull()
    expect(rules.email('notanemail')).toBe('That doesn’t look like an email address.')
    expect(rules.email('two@places')).not.toBeNull()
    expect(rules.email('someone@example.test')).toBeNull()
  })

  test('a Minecraft name follows Mojang’s own rules', () => {
    expect(rules.playerName('Notch')).toBeNull()
    expect(rules.playerName('a_b-c')).toContain('letters, numbers and underscores')
    expect(rules.playerName('ab')).toContain('3 to 16')
    expect(rules.playerName('a'.repeat(17))).toContain('3 to 16')
  })

  test('every bound matches the one the API enforces', () => {
    // A name of 40 is fine, 41 is not — and the contract says the same.
    expect(rules.serverName('n'.repeat(40))).toBeNull()
    expect(rules.serverName('n'.repeat(41))).not.toBeNull()
    expect(CreateServerInput.safeParse({ name: 'n'.repeat(41) }).success).toBe(false)
    expect(
      SaveIdentityInput.safeParse({ serverId: crypto.randomUUID(), description: 'd'.repeat(1001) }).success,
    ).toBe(false)
    expect(rules.description('d'.repeat(1001))).not.toBeNull()
    expect(rules.description('d'.repeat(1000))).toBeNull()
    // Ten characters is what the deployment's auth is configured to require
    // (`infra/auth/better-auth.ts`, `minPasswordLength`).
    expect(rules.password('123456789')).not.toBeNull()
    expect(rules.password('1234567890')).toBeNull()
    // A Minecraft name, a world's name and a seed.
    expect(AddPlayerInput.safeParse({ serverId: crypto.randomUUID(), name: 'ab' }).success).toBe(false)
    expect(rules.playerName('ab')).not.toBeNull()
    expect(rules.worldName('w'.repeat(41))).not.toBeNull()
    expect(CreateWorldInput.safeParse({ serverId: crypto.randomUUID(), name: 'w'.repeat(41) }).success).toBe(
      false,
    )
    expect(rules.seed('s'.repeat(33))).not.toBeNull()
    // A note: up to 128 characters, and something in it.
    const note = (body: string) => AddNoteInput.safeParse({ serverId: crypto.randomUUID(), body }).success
    expect(rules.note('n'.repeat(128))).toBeNull()
    expect(note('n'.repeat(128))).toBe(true)
    expect(rules.note('n'.repeat(129))).toBe('A note is up to 128 characters.')
    expect(note('n'.repeat(129))).toBe(false)
    expect(rules.note('   ')).toBe('Write something first.')
    expect(note('   ')).toBe(false)
    // The counts the admin forms take as text: the API wants a whole number, so a field that
    // takes one says so rather than letting the server refuse it.
    expect(rules.wholeNumber('12')).toBeNull()
    expect(rules.wholeNumber('twelve')).not.toBeNull()
    expect(rules.wholeNumber('-1')).not.toBeNull()
    expect(rules.wholeNumber('')).toBeNull()
    const switches = {
      provisioningEnabled: true,
      startsEnabled: true,
      publicListingEnabled: true,
      uploadsEnabled: true,
      storingEnabled: true,
      expiringEnabled: false,
      maxFreeAccounts: 30,
      dailySpendLimitCents: 1000,
    }
    // The largest the form takes, six digits of dollars, is a limit the API takes too.
    const most = Number.parseInt('999999', 10) * 100
    expect(rules.wholeNumber('999999')).toBeNull()
    expect(
      PlatformControlsInput.safeParse({
        ...switches,
        maxServers: 1,
        maxRunningServers: 1,
        dailySpendLimitCents: most,
      }).success,
    ).toBe(true)
    expect(
      PlatformControlsInput.safeParse({ ...switches, maxServers: -1, maxRunningServers: 1 }).success,
    ).toBe(false)
    expect(
      PlatformControlsInput.safeParse({ ...switches, maxServers: 12, maxRunningServers: 1 }).success,
    ).toBe(true)
  })
})
