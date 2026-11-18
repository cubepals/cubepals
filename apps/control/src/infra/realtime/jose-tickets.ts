// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Realtime tickets as HS256 JWTs, signed and checked by `jose` rather than by hand
 * (docs/dependency-audit.md). The audience is the deployment, so a ticket from one environment
 * never opens a session in another. Each ticket has its own id, and the realtime role (one per
 * deployment) remembers the ids it has let in until they expire, so a ticket opens one session.
 * A person's ticket names their sign-in session; an operator's names the one console it opens.
 */
import { randomUUID } from 'node:crypto'
import { MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { type JWTPayload, jwtVerify, SignJWT } from 'jose'
import type { Holder, OperatorHolder, RealtimeTickets, TicketHolder } from '../../app/ports/tickets.ts'

/** The subject of an operator's ticket starts with this, which no account's id does. */
const OPERATOR_SUBJECT = 'operator:'

/**
 * Who a verified ticket's claims name: a person's ticket has a sign-in session (`sid`) and an
 * account for its subject; an operator's has the operator (`op`), the server (`srv`) and a subject
 * that says it is an operator's. Anything else, or a mix of the two, names nobody.
 */
function holderOf({ sub, sid, op, srv }: JWTPayload): Holder | null {
  if (sub === undefined) return null
  if (op !== undefined || srv !== undefined || sub.startsWith(OPERATOR_SUBJECT)) {
    if (sid !== undefined || typeof op !== 'string' || typeof srv !== 'string') return null
    if (op === '' || srv === '' || sub !== `${OPERATOR_SUBJECT}${op}`) return null
    return { operator: op, serverId: srv }
  }
  return typeof sid === 'string' && sid !== '' ? { userId: sub, sessionId: sid } : null
}

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
    return this.#sign(userId, { sid: sessionId })
  }

  /** An operator's ticket names no account: its subject says so, and `srv` is the one console it opens. */
  issueForOperator({ operator, serverId }: OperatorHolder): Promise<string> {
    return this.#sign(`${OPERATOR_SUBJECT}${operator}`, { op: operator, srv: serverId })
  }

  #sign(subject: string, claims: Record<string, string>): Promise<string> {
    const now = this.#now()
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setAudience(this.#audience)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + this.#ttlSeconds * SECOND_MS))
      .sign(this.#key)
  }

  async verify(ticket: string): Promise<Holder | null> {
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
    const holder = holderOf(payload)
    const { jti, exp } = payload
    if (holder === null || jti === undefined || exp === undefined) return null
    this.#forgetExpired()
    if (this.#used.has(jti)) return null
    this.#used.set(jti, exp * SECOND_MS)
    return holder
  }

  #forgetExpired() {
    const now = this.#now().getTime()
    for (const [jti, expires] of this.#used) if (expires < now) this.#used.delete(jti)
  }
}
