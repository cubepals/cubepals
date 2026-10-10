// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import createClient, { type ClientOptions } from 'openapi-fetch'
import type { components, paths } from './generated/machines.ts'
import { flyCredentials } from './token.ts'

/**
 * The Fly Machines API, typed from Fly's own OpenAPI spec (tools/openapi). Only `infra/fly/` sees
 * these types; the rest of Blockly sees `MinecraftRuntime`.
 */
export type FlyClient = ReturnType<typeof createClient<paths>>
export type FlySchemas = components['schemas']

const FLY_API = 'https://api.machines.dev'

export class FlyApiError extends Error {
  readonly status: number

  constructor(status: number, what: string, detail: unknown) {
    super(`Fly: ${what} failed with ${status}${detail ? `: ${JSON.stringify(detail).slice(0, 200)}` : ''}`)
    this.name = 'FlyApiError'
    this.status = status
  }
}

type Send = NonNullable<ClientOptions['fetch']>
type FlyRequest = Parameters<Send>[0]

export interface FlyClientOptions {
  baseUrl?: string
  /** Where requests go. Tests pass an in-memory Fly API. */
  fetch?: Send
  /** Requests per second per action per machine, and the burst. Fly's limits by default. */
  pace?: { perSecond: number; burst: number }
}

export function flyClient(token: string, options: FlyClientOptions = {}): FlyClient {
  const send: Send = options.fetch ?? ((request) => fetch(request))
  const buckets = new TokenBuckets(options.pace?.perSecond ?? 1, options.pace?.burst ?? 3)
  return createClient<paths>({
    baseUrl: options.baseUrl ?? FLY_API,
    headers: { Authorization: flyCredentials(token).authorization },
    fetch: (request) => paced(request, send, buckets),
  })
}

/**
 * Fly allows about one request a second per action per machine, with a small burst. Each request
 * waits for its turn; a 429 waits out Retry-After, and so does a 502–504 on a request that is safe
 * to repeat. Generic retry libraries would still need this Fly-specific status and header handling.
 */
async function paced(request: FlyRequest, send: Send, buckets: TokenBuckets): Promise<Response> {
  const key = `${request.method} ${new URL(request.url).pathname}`
  const repeatable = request.method === 'GET' || request.method === 'DELETE' || request.method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    await buckets.take(key)
    // Bun's and Node's type packages each declare Request; clone() returns the other one's.
    const response = await send(request.clone() as FlyRequest)
    const again = response.status === 429 || (repeatable && response.status >= 502 && response.status <= 504)
    if (!again || attempt >= 4) return response
    await response.body?.cancel()
    await sleep(retryDelayMs(response, attempt))
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250
}

class TokenBuckets {
  readonly #perSecond: number
  readonly #burst: number
  readonly #buckets = new Map<string, { tokens: number; at: number }>()

  constructor(perSecond: number, burst: number) {
    this.#perSecond = perSecond
    this.#burst = burst
  }

  async take(key: string): Promise<void> {
    for (;;) {
      const now = Date.now()
      const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, at: now }
      bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1000) * this.#perSecond)
      bucket.at = now
      this.#buckets.set(key, bucket)
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return
      }
      await sleep(((1 - bucket.tokens) / this.#perSecond) * 1000)
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
