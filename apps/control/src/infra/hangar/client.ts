/**
 * Hangar's API (hangar.papermc.io), typed from Hangar's own OpenAPI spec (tools/openapi), its
 * public `/api/v1` routes only. Only `infra/hangar/` sees these types; the rest of Blockly sees
 * `ModCatalog`.
 */
import createClient, { type ClientOptions } from 'openapi-fetch'
import type { components, paths } from './generated/hangar.ts'

export type HangarClient = ReturnType<typeof createClient<paths>>
export type HangarSchemas = components['schemas']

const HANGAR_API = 'https://hangar.papermc.io'

type Send = NonNullable<ClientOptions['fetch']>
type HangarRequest = Parameters<Send>[0]

export interface HangarClientOptions {
  baseUrl?: string
  /** Where requests go. Tests pass an in-memory Hangar. */
  fetch?: Send
  /** The longest a rate-limited request waits before its next try. */
  maxWaitMs?: number
}

/**
 * Reads need no key: anonymous use sees exactly what is public. Hangar asks every client for "a
 * meaningful `User-Agent` header" (its API docs, read 2026-10-09).
 */
export function hangarClient(userAgent: string, options: HangarClientOptions = {}): HangarClient {
  const send: Send = options.fetch ?? ((request) => fetch(request))
  const maxWaitMs = options.maxWaitMs ?? 10_000
  return createClient<paths>({
    baseUrl: options.baseUrl ?? HANGAR_API,
    headers: { 'User-Agent': userAgent },
    fetch: (request) => patient(request, send, maxWaitMs),
  })
}

const ATTEMPTS = 3

/**
 * Hangar allows 20 requests every 5 seconds, "with an initial overdraft for extra leniency", and
 * says no more about how it refuses one past that. Every call here is a read, so a 429, a 502–504
 * or a dropped connection is tried again: after the Retry-After it sends, or a pause that covers
 * the window. Three tries in all; authoring would rather stop with CatalogUnavailable than hang.
 */
async function patient(request: HangarRequest, send: Send, maxWaitMs: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      // Bun's and Node's type packages each declare Request; clone() returns the other one's.
      response = await send(request.clone() as HangarRequest)
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error
      await sleep(Math.min(maxWaitMs, 1000 * attempt))
      continue
    }
    const again = response.status === 429 || (response.status >= 502 && response.status <= 504)
    if (!again || attempt >= ATTEMPTS) return response
    await response.body?.cancel()
    const retryAfter = Number(response.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt
    await sleep(Math.min(maxWaitMs, wait))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
