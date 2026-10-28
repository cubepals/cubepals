// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { JoseRealtimeTickets } from './jose-tickets.ts'

const SECRET = 'ticket-secret-0123456789abcdef'
const at = (iso: string) => () => new Date(iso)
const HOLDER = { userId: 'user-1', sessionId: 'session-1' }

describe('JoseRealtimeTickets', () => {
  const tickets = new JoseRealtimeTickets(SECRET, 'local', { now: at('2026-09-19T12:00:00Z') })

  test('a fresh ticket names its user and the sign-in session that asked for it', async () => {
    expect(await tickets.verify(await tickets.issue(HOLDER))).toEqual(HOLDER)
  })

  test('a ticket opens one session', async () => {
    const ticket = await tickets.issue(HOLDER)
    expect(await tickets.verify(ticket)).toEqual(HOLDER)
    expect(await tickets.verify(ticket)).toBeNull()
    // Another ticket for the same person still opens its own.
    expect(await tickets.verify(await tickets.issue(HOLDER))).toEqual(HOLDER)
  })

  test('a ticket naming no sign-in session opens nothing', async () => {
    expect(await tickets.verify(await tickets.issue({ userId: 'user-1', sessionId: '' }))).toBeNull()
  })

  test('a ticket past its minute is refused', async () => {
    const ticket = await tickets.issue(HOLDER)
    const later = new JoseRealtimeTickets(SECRET, 'local', { now: at('2026-09-19T12:01:01Z') })
    expect(await later.verify(ticket)).toBeNull()
  })

  test("another deployment's ticket is refused", async () => {
    const staging = new JoseRealtimeTickets(SECRET, 'staging', { now: at('2026-09-19T12:00:00Z') })
    expect(await tickets.verify(await staging.issue(HOLDER))).toBeNull()
  })

  test('a ticket signed with another secret is refused', async () => {
    const forger = new JoseRealtimeTickets('some-other-secret-0123456789', 'local', {
      now: at('2026-09-19T12:00:00Z'),
    })
    expect(await tickets.verify(await forger.issue(HOLDER))).toBeNull()
  })

  test('a ticket with its subject swapped is refused', async () => {
    const [header, payload, signature] = (await tickets.issue(HOLDER)).split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
    const swapped = Buffer.from(JSON.stringify({ ...claims, sub: 'user-2' })).toString('base64url')
    expect(await tickets.verify(`${header}.${swapped}.${signature}`)).toBeNull()
  })

  test('an unsigned ticket is refused', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'local', exp: 4102444800 })).toString(
      'base64url',
    )
    expect(await tickets.verify(`${header}.${payload}.`)).toBeNull()
  })

  test('tickets in the old hand-signed format, and noise, are refused', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'local', exp: 4102444800000 })).toString(
      'base64url',
    )
    const old = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    expect(await tickets.verify(old)).toBeNull()
    expect(await tickets.verify('')).toBeNull()
    expect(await tickets.verify('not.a.ticket')).toBeNull()
  })
})
