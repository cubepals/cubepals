// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { JoseRealtimeTickets } from './jose-tickets.ts'

const SECRET = 'ticket-secret-0123456789abcdef'
const at = (iso: string) => () => new Date(iso)

describe('JoseRealtimeTickets', () => {
  const tickets = new JoseRealtimeTickets(SECRET, 'local', { now: at('2026-09-19T12:00:00Z') })

  test('a fresh ticket names its user', async () => {
    expect(await tickets.verify(await tickets.issue('user-1'))).toBe('user-1')
  })

  test('a ticket past its minute is refused', async () => {
    const ticket = await tickets.issue('user-1')
    const later = new JoseRealtimeTickets(SECRET, 'local', { now: at('2026-09-19T12:01:01Z') })
    expect(await later.verify(ticket)).toBeNull()
  })

  test("another deployment's ticket is refused", async () => {
    const staging = new JoseRealtimeTickets(SECRET, 'staging', { now: at('2026-09-19T12:00:00Z') })
    expect(await tickets.verify(await staging.issue('user-1'))).toBeNull()
  })

  test('a ticket signed with another secret is refused', async () => {
    const forger = new JoseRealtimeTickets('some-other-secret-0123456789', 'local', {
      now: at('2026-09-19T12:00:00Z'),
    })
    expect(await tickets.verify(await forger.issue('user-1'))).toBeNull()
  })

  test('a ticket with its subject swapped is refused', async () => {
    const [header, payload, signature] = (await tickets.issue('user-1')).split('.')
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
