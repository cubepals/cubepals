// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import createClient, { type ClientOptions } from 'openapi-fetch'
import type { components, paths } from './generated/labrinth.ts'
import { SharedReads } from './shared-reads.ts'

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
  /**
   * The longest a read waits between its tries, all of them together. A create waits on its
   * reads, so a rate limit that would hold it longer gives up instead.
   */
  maxWaitMs?: number
  /** How long an answer is shared with the reads that ask the same (`shared-reads.ts`); 0 shares none. */
  shareMs?: number
  /** Where a read that gives up says what Modrinth answered. */
  log?: (line: string) => void
}

/** Modrinth refuses traffic that doesn't identify its application in the User-Agent. */
export function modrinthClient(userAgent: string, options: ModrinthClientOptions = {}): ModrinthClient {
  const send: Send = options.fetch ?? ((request) => fetch(request))
  const maxWaitMs = options.maxWaitMs ?? 10 * SECOND_MS
  const log = options.log ?? ((line) => console.warn(line))
  const shared = new SharedReads({ lifetimeMs: options.shareMs ?? MINUTE_MS, maxBytes: SHARED_BYTES })
  return createClient<paths>({
    baseUrl: options.baseUrl ?? MODRINTH_API,
    headers: { 'User-Agent': userAgent },
    fetch: (request) =>
      shared.read(request, (read) => patient(read as ModrinthRequest, send, maxWaitMs, log)),
  })
}

const ATTEMPTS = 3
/**
 * A project's whole version list is the largest answer: Fabulously Optimized's was 2.4 MB on
 * 2026-10-14, so this keeps a dozen such lists beside the small answers.
 */
const SHARED_BYTES = 32 * 1024 * 1024

/** Reads Modrinth takes by POST, for the hashes they carry: as safe to send again as a GET. */
const LOOKUPS = /\/version_files(\/update)?$/

/**
 * Modrinth allows 300 requests a minute per address and reports the window in X-Ratelimit-*
 * headers (docs.modrinth.com/api, "Ratelimits"). A read answered 429 waits out its Retry-After, or
 * the window's reset; a 408, a 502–504 or a dropped connection is tried again after a short pause,
 * looking files up by their hashes included (seen 2026-09-26: Modrinth's edge answered those 502
 * for minutes while small reads went through). Three tries in all, and no more waiting than
 * `maxWaitMs`: a wait Modrinth asks for that is longer gives up at once, rather than ask again
 * before it said to. A read that gives up says what it was answered, for whoever reads the logs.
 */
async function patient(
  request: ModrinthRequest,
  send: Send,
  maxWaitMs: number,
  log: (line: string) => void,
): Promise<Response> {
  const repeatable =
    request.method === 'GET' || request.method === 'HEAD' || LOOKUPS.test(new URL(request.url).pathname)
  const endpoint = `${request.method} ${new URL(request.url).pathname}`
  let waited = 0
  for (let attempt = 1; ; attempt++) {
    // Bun's and Node's type packages each declare Request; clone() returns the other one's.
    const tried: Tried = await send(request.clone() as ModrinthRequest).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    )
    if ('response' in tried && !refused(tried.response.status)) return tried.response
    const wait = waitFor(tried, attempt)
    if (!repeatable || attempt >= ATTEMPTS || wait.least > maxWaitMs - waited) {
      log(`modrinth: ${endpoint} gave up after ${tries(attempt)}: ${saidBy(tried)}`)
      if ('response' in tried) return tried.response
      throw tried.error
    }
    if ('response' in tried) await tried.response.body?.cancel()
    const ms = Math.min(maxWaitMs - waited, wait.ms)
    waited += ms
    await sleep(ms)
  }
}

type Tried = { response: Response } | { error: unknown }

/** What is worth asking again: Modrinth's edge timing out (408), a rate limit, a gateway failing. */
const refused = (status: number) => status === 408 || status === 429 || (status >= 502 && status <= 504)

/** The status and the headers that say why, or why no answer came; nothing of the request's. */
function saidBy(tried: Tried): string {
  if ('error' in tried) return tried.error instanceof Error ? tried.error.message : String(tried.error)
  const said = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'cf-ray']
    .flatMap((name) => {
      const value = tried.response.headers.get(name)
      return value === null ? [] : [`${name} ${value}`]
    })
    .join(', ')
  return said === '' ? `${tried.response.status}` : `${tried.response.status} (${said})`
}

/**
 * How long to wait before the next try, and the least Modrinth asked for: its Retry-After, or for
 * a 429 the reset of its window, with a quarter second more as it rounds to whole seconds. Without
 * either, a short pause of Blockly's own.
 */
function waitFor(tried: Tried, attempt: number): { ms: number; least: number } {
  const headers = 'response' in tried ? tried.response.headers : new Headers()
  const retryAfter = Number(headers.get('retry-after') ?? Number.NaN)
  if (Number.isFinite(retryAfter) && retryAfter >= 0)
    return { ms: retryAfter * SECOND_MS + 250, least: retryAfter * SECOND_MS }
  const reset = Number(headers.get('x-ratelimit-reset') ?? Number.NaN)
  if ('response' in tried && tried.response.status === 429 && Number.isFinite(reset) && reset >= 0)
    return { ms: reset * SECOND_MS + 250, least: reset * SECOND_MS }
  return { ms: pause(attempt), least: 0 }
}

const tries = (attempt: number) => (attempt === 1 ? '1 try' : `${attempt} tries`)
const pause = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.random() * 250
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
