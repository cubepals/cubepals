// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import createClient, { type ClientOptions } from 'openapi-fetch'
import type { components, paths } from './generated/labrinth.ts'

/**
 * Modrinth's API (Labrinth), typed from Modrinth's own OpenAPI spec (tools/openapi). Only
 * `infra/modrinth/` sees these types; the rest of Blockly sees `ModCatalog`.
 */
export type ModrinthClient = ReturnType<typeof createClient<paths>>
export type ModrinthSchemas = components['schemas']

const MODRINTH_API = 'https://api.modrinth.com/v2'

type Send = NonNullable<ClientOptions['fetch']>
type ModrinthRequest = Parameters<Send>[0]

export interface ModrinthClientOptions {
  baseUrl?: string
  /** Where requests go. Tests pass an in-memory Modrinth. */
  fetch?: Send
  /** The longest a rate-limited request waits before its next try. */
  maxWaitMs?: number
}

/** Modrinth refuses traffic that doesn't identify its application in the User-Agent. */
export function modrinthClient(userAgent: string, options: ModrinthClientOptions = {}): ModrinthClient {
  const send: Send = options.fetch ?? ((request) => fetch(request))
  const maxWaitMs = options.maxWaitMs ?? 60_000
  return createClient<paths>({
    baseUrl: options.baseUrl ?? MODRINTH_API,
    headers: { 'User-Agent': userAgent },
    fetch: (request) => patient(request, send, maxWaitMs),
  })
}

const ATTEMPTS = 3

/** Reads Modrinth takes by POST, for the hashes they carry: as safe to send again as a GET. */
const LOOKUPS = /\/version_files(\/update)?$/

/**
 * Modrinth allows 300 requests a minute per address and reports the window in X-Ratelimit-*
 * headers. A read answered 429 waits for the window to reset; a 408, a 502–504 or a dropped connection is
 * tried again after a short pause, looking files up by their hashes included (seen 2026-09-26:
 * Modrinth's edge answered those 502 for minutes while small reads went through). Three tries in all: authoring would rather stop with
 * CatalogUnavailable than hang.
 */
async function patient(request: ModrinthRequest, send: Send, maxWaitMs: number): Promise<Response> {
  const repeatable =
    request.method === 'GET' || request.method === 'HEAD' || LOOKUPS.test(new URL(request.url).pathname)
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      // Bun's and Node's type packages each declare Request; clone() returns the other one's.
      response = await send(request.clone() as ModrinthRequest)
    } catch (error) {
      if (!repeatable || attempt >= ATTEMPTS) throw error
      await sleep(Math.min(maxWaitMs, pause(attempt)))
      continue
    }
    const again =
      response.status === 408 || response.status === 429 || (response.status >= 502 && response.status <= 504)
    if (!again || !repeatable || attempt >= ATTEMPTS) return response
    await response.body?.cancel()
    await sleep(Math.min(maxWaitMs, waitFor(response, attempt)))
  }
}

function waitFor(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (response.status === 429 && Number.isFinite(reset) && reset >= 0) return reset * 1000 + 250
  return pause(attempt)
}

const pause = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.random() * 250
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
