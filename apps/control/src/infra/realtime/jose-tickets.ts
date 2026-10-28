// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Realtime tickets as HS256 JWTs, signed and checked by `jose` rather than by hand
 * (docs/dependency-audit.md). The audience is the deployment, so a ticket from one environment
 * never opens a session in another. Each ticket has its own id, and the realtime role (one per
 * deployment) remembers the ids it has let in until they expire, so a ticket opens one session.
 */
import { randomUUID } from 'node:crypto'
import { MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { jwtVerify, SignJWT } from 'jose'
import type { RealtimeTickets, TicketHolder } from '../../app/ports/tickets.ts'

/** Realtime tickets as `jose` signs and checks them, each one good for one session. */
export class JoseRealtimeTickets implements RealtimeTickets {
  readonly #key: Uint8Array
  readonly #audience: string
  readonly #ttlSeconds: number
  readonly #now: () => Date
  /** Ids of tickets already used, with when each expires. */
  readonly #used = new Map<string, number>()

  constructor(secret: string, audience: string, options: { ttlSeconds?: number; now?: () => Date } = {}) {
    this.#key = new TextEncoder().encode(secret)
    this.#audience = audience
    this.#ttlSeconds = options.ttlSeconds ?? MINUTE_S
    this.#now = options.now ?? (() => new Date())
  }

  issue({ userId, sessionId }: TicketHolder): Promise<string> {
    const now = this.#now()
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(this.#audience)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + this.#ttlSeconds * SECOND_MS))
      .sign(this.#key)
  }

  async verify(ticket: string): Promise<TicketHolder | null> {
    const payload = await jwtVerify(ticket, this.#key, {
      algorithms: ['HS256'],
      audience: this.#audience,
      requiredClaims: ['sub', 'exp', 'jti'],
      currentDate: this.#now(),
    }).then(
      (verified) => verified.payload,
      () => null,
    )
    if (payload === null) return null
    const { sub, jti, exp, sid } = payload
    if (sub === undefined || jti === undefined || exp === undefined || typeof sid !== 'string' || sid === '')
      return null
    this.#forgetExpired()
    if (this.#used.has(jti)) return null
    this.#used.set(jti, exp * SECOND_MS)
    return { userId: sub, sessionId: sid }
  }

  #forgetExpired() {
    const now = this.#now().getTime()
    for (const [jti, expires] of this.#used) if (expires < now) this.#used.delete(jti)
  }
}
