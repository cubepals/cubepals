// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modrinth's answers to reads, shared for a short while. Every create of one template or pack
 * asks Modrinth the same questions, and the 300 requests a minute Modrinth allows an address
 * (docs.modrinth.com/api, "Ratelimits") are the control plane's, not each create's: the same
 * read asked while one is on its way waits for that one, and an answer is kept for a minute, or
 * less when its Cache-Control says so. Modrinth sent none on 2026-10-14, and its edge
 * answered from its own cache (`cf-cache-status: HIT`).
 *
 * Keyed by the request's method and whole URL, which is everything a read depends on: the
 * User-Agent is the same on every request. Only a 200 or a 404 is kept; a refusal or an outage is
 * shared with the reads waiting on it and asked again by the next. Not for writes, or lookups
 * that carry their question in a body: those always go through.
 */

interface Kept {
  status: number
  headers: [string, string][]
  body: Uint8Array
  until: number
}

export interface SharedReadsOptions {
  /** How long an answer is kept, at most. */
  lifetimeMs: number
  /** The most answer bytes kept at once; the oldest answers go first. */
  maxBytes: number
}

export class SharedReads {
  readonly #lifetimeMs: number
  readonly #maxBytes: number
  /** Oldest first: a Map keeps insertion order, and a read answered from it moves to the end. */
  readonly #kept = new Map<string, Kept>()
  readonly #asked = new Map<string, Promise<Kept>>()
  #bytes = 0

  constructor(options: SharedReadsOptions) {
    this.#lifetimeMs = options.lifetimeMs
    this.#maxBytes = options.maxBytes
  }

  async read(request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
    if (request.method !== 'GET' || this.#lifetimeMs <= 0) return send(request)
    const key = `${request.method} ${request.url}`
    const kept = this.#kept.get(key)
    if (kept !== undefined && kept.until > Date.now()) {
      this.#kept.delete(key)
      this.#kept.set(key, kept)
      return responseOf(kept)
    }
    if (kept !== undefined) this.#forget(key)
    let asked = this.#asked.get(key)
    if (asked === undefined) {
      asked = this.#ask(key, request, send)
      this.#asked.set(key, asked)
      void asked.then(
        () => this.#asked.delete(key),
        () => this.#asked.delete(key),
      )
    }
    return responseOf(await asked)
  }

  async #ask(key: string, request: Request, send: (request: Request) => Promise<Response>): Promise<Kept> {
    const response = await send(request)
    const answer: Kept = {
      status: response.status,
      headers: [...response.headers],
      body: new Uint8Array(await response.arrayBuffer()),
      until: Date.now() + this.#keepFor(response),
    }
    const keep = (answer.status === 200 || answer.status === 404) && answer.until > Date.now()
    if (keep && answer.body.byteLength <= this.#maxBytes) {
      this.#kept.set(key, answer)
      this.#bytes += answer.body.byteLength
      for (const [oldest] of this.#kept) {
        if (this.#bytes <= this.#maxBytes) break
        this.#forget(oldest)
      }
    }
    return answer
  }

  /** The lifetime, shortened by a Cache-Control that asks for less (RFC 9111 §5.2.2). */
  #keepFor(response: Response): number {
    const control = (response.headers.get('cache-control') ?? '').toLowerCase()
    if (/(^|[\s,])(no-store|no-cache|private)\b/.test(control)) return 0
    const maxAge = /(^|[\s,])max-age=(\d+)/.exec(control)?.[2]
    if (maxAge === undefined) return this.#lifetimeMs
    const age = Number(response.headers.get('age') ?? 0) || 0
    return Math.min(this.#lifetimeMs, Math.max(0, Number(maxAge) - age) * 1000)
  }

  #forget(key: string): void {
    const kept = this.#kept.get(key)
    if (kept === undefined) return
    this.#kept.delete(key)
    this.#bytes -= kept.body.byteLength
  }
}

/** A fresh Response each time: a body can be read only once. An empty one is none, as a 204's must be. */
const responseOf = (kept: Kept): Response =>
  new Response(kept.body.byteLength === 0 ? null : kept.body, { status: kept.status, headers: kept.headers })
