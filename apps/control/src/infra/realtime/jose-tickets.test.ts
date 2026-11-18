// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { SignJWT } from 'jose'
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

  describe("an operator's ticket", () => {
    const OPERATOR = { operator: 'ops-agent', serverId: '6f1c2c49-6c39-4d3c-9d0b-0f8f2d0f6a11' }
    /** A ticket signed with the right secret and audience, with whatever claims a test gives it. */
    const signed = (subject: string, claims: Record<string, string>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setAudience('local')
        .setJti(crypto.randomUUID())
        .setIssuedAt(new Date('2026-09-19T12:00:00Z'))
        .setExpirationTime(new Date('2026-09-19T12:01:00Z'))
        .sign(new TextEncoder().encode(SECRET))

    test('names the operator and the one server, and no account or sign-in', async () => {
      expect(await tickets.verify(await tickets.issueForOperator(OPERATOR))).toEqual(OPERATOR)
    })

    test('opens one session, as a person’s does', async () => {
      const ticket = await tickets.issueForOperator(OPERATOR)
      expect(await tickets.verify(ticket)).toEqual(OPERATOR)
      expect(await tickets.verify(ticket)).toBeNull()
    })

    test('is refused when it also names a sign-in session, or when its subject is an account', async () => {
      const mixed = { sid: 'session-1', op: OPERATOR.operator, srv: OPERATOR.serverId }
      expect(await tickets.verify(await signed(`operator:${OPERATOR.operator}`, mixed))).toBeNull()
      const asAccount = { op: OPERATOR.operator, srv: OPERATOR.serverId }
      expect(await tickets.verify(await signed('user-1', asAccount))).toBeNull()
    })

    test('is refused without its server, or with an operator subject and a sign-in instead', async () => {
      expect(await tickets.verify(await signed('operator:ops-agent', { op: 'ops-agent' }))).toBeNull()
      expect(await tickets.verify(await signed('operator:ops-agent', { sid: 'session-1' }))).toBeNull()
    })

    test('is refused past its minute, as a person’s is', async () => {
      const ticket = await tickets.issueForOperator(OPERATOR)
      const later = new JoseRealtimeTickets(SECRET, 'local', { now: at('2026-09-19T12:01:01Z') })
      expect(await later.verify(ticket)).toBeNull()
    })

    test('a person’s ticket never reads as an operator’s', async () => {
      expect(await tickets.verify(await tickets.issue(HOLDER))).toEqual(HOLDER)
      expect(await tickets.verify(await signed('user-1', { sid: 'session-1' }))).toEqual(HOLDER)
    })
  })
})
