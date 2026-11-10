// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Cloudflare zone's DNS records in memory, answering the requests Cloudflare's own SDK sends
 * (`infra/cloudflare/dns-records.ts`) as Cloudflare's v4 API does: records listed a page at a time
 * and filtered by type, name and comment, made, overwritten and deleted. Every record is held as
 * the SDK's own type says one comes back. A name in `refusing` is refused as the API refuses a
 * record, with its error envelope. Nothing else of the API is here.
 */
import { randomUUID } from 'node:crypto'
import type Cloudflare from 'cloudflare'

type ARecord = Cloudflare.DNS.RecordResponse.ARecord

/** The API's own refusal of a record it won't make: an error in its envelope, with a 400. */
const REFUSED = { code: 81057, message: 'Record already exists.' }

export class CloudflareZone {
  readonly records = new Map<string, ARecord>()
  /** Names whose records the zone refuses to make or change. */
  readonly refusing = new Set<string>()
  /** Each request the SDK sent, as `METHOD path`. */
  readonly requests: string[] = []
  readonly #zoneId: string
  readonly #perPage: number

  constructor(zoneId: string, perPage = 2) {
    this.#zoneId = zoneId
    this.#perPage = perPage
  }

  /** A record made outside the control plane, such as Terraform's wildcard. */
  add(record: { name: string; content: string; comment?: string }): ARecord {
    const now = new Date().toISOString()
    const made: ARecord = {
      id: randomUUID().replaceAll('-', ''),
      type: 'A',
      ttl: 300,
      proxied: false,
      proxiable: true,
      meta: {},
      created_on: now,
      modified_on: now,
      ...record,
    }
    this.records.set(made.id, made)
    return made
  }

  /** The SDK's `fetch`. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace(/^\/client\/v4/, '')
    this.requests.push(`${method} ${path}`)
    const base = `/zones/${this.#zoneId}/dns_records`
    if (path === base && method === 'GET') return this.#list(url.searchParams)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Partial<ARecord>) : {}
    if (path === base && method === 'POST') return this.#write(body, null)
    const id = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
    if (id === null || !this.records.has(id))
      return answer(404, null, [{ code: 81044, message: 'Record not found.' }])
    if (method === 'PUT') return this.#write(body, id)
    if (method === 'DELETE') {
      this.records.delete(id)
      return answer(200, { id })
    }
    return answer(405, null, [{ code: 10000, message: `${method} isn't answered here` }])
  }

  #list(query: URLSearchParams): Response {
    const type = query.get('type')
    const name = query.get('name.exact')?.toLowerCase()
    const comment = query.get('comment.exact')?.toLowerCase()
    const matching = [...this.records.values()].filter(
      (record) =>
        (type === null || record.type === type) &&
        (name === undefined || record.name.toLowerCase() === name) &&
        (comment === undefined || record.comment?.toLowerCase() === comment),
    )
    const page = Number(query.get('page') ?? 1)
    const perPage = Number(query.get('per_page') ?? this.#perPage)
    const result = matching.slice((page - 1) * perPage, page * perPage)
    return answer(200, result, [], {
      page,
      per_page: perPage,
      count: result.length,
      total_count: matching.length,
      total_pages: Math.ceil(matching.length / perPage),
    })
  }

  #write(body: Partial<ARecord>, id: string | null): Response {
    if (body.name !== undefined && this.refusing.has(body.name)) return answer(400, null, [REFUSED])
    const now = new Date().toISOString()
    const before = id === null ? undefined : this.records.get(id)
    const record: ARecord = {
      id: id ?? randomUUID().replaceAll('-', ''),
      name: body.name ?? '',
      type: 'A',
      ttl: body.ttl ?? 1,
      content: body.content,
      proxied: body.proxied ?? false,
      proxiable: true,
      meta: {},
      created_on: before?.created_on ?? now,
      modified_on: now,
      ...(body.comment === undefined ? {} : { comment: body.comment }),
    }
    this.records.set(record.id, record)
    return answer(200, record)
  }
}

/** Cloudflare's v4 envelope around a result, or around the errors that refused one. */
function answer(
  status: number,
  result: unknown,
  errors: { code: number; message: string }[] = [],
  resultInfo?: Record<string, number>,
): Response {
  const body = { success: errors.length === 0, errors, messages: [], result, result_info: resultInfo }
  return Response.json(body, { status })
}
