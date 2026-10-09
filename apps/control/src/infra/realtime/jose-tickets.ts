import { jwtVerify, SignJWT } from 'jose'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'

/**
 * Realtime tickets as HS256 JWTs, signed and checked by `jose` rather than by hand
 * (docs/dependency-audit.md). The audience is the deployment, so a ticket from one environment
 * never opens a session in another.
 */
export class JoseRealtimeTickets implements RealtimeTickets {
  readonly #key: Uint8Array
  readonly #audience: string
  readonly #ttlSeconds: number
  readonly #now: () => Date

  constructor(secret: string, audience: string, options: { ttlSeconds?: number; now?: () => Date } = {}) {
    this.#key = new TextEncoder().encode(secret)
    this.#audience = audience
    this.#ttlSeconds = options.ttlSeconds ?? 60
    this.#now = options.now ?? (() => new Date())
  }

  issue(userId: string): Promise<string> {
    const now = this.#now()
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(this.#audience)
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + this.#ttlSeconds * 1000))
      .sign(this.#key)
  }

  async verify(ticket: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(ticket, this.#key, {
        algorithms: ['HS256'],
        audience: this.#audience,
        requiredClaims: ['sub', 'exp'],
        currentDate: this.#now(),
      })
      return payload.sub ?? null
    } catch {
      return null
    }
  }
}
