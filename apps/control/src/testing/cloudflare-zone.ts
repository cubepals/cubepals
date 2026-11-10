// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Cloudflare zone's DNS records in memory, answering the requests Cloudflare's own SDK sends
 * (`infra/cloudflare/dns-records.ts`) as Cloudflare's v4 API does: records listed a page at a time
 * and filtered by type, name and comment, made, overwritten and deleted. Every record is held as
 * the SDK's own type says one comes back. A name in `refusing` is refused with a bare 400, and an
 * unknown record or method with a bare 404 or 405: the status alone, which the SDK turns into its
 * own errors. No error code or message of the API's is written here. Nothing else of the API is.
 */
import { randomUUID } from 'node:crypto'
import type Cloudflare from 'cloudflare'

type ARecord = Cloudflare.DNS.RecordResponse.ARecord

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
    if (id === null || !this.records.has(id)) return refused(404)
    if (method === 'PUT') return this.#write(body, id)
    if (method === 'DELETE') {
      this.records.delete(id)
      return answer(200, { id })
    }
    return refused(405)
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
    return answer(200, result, {
      page,
      per_page: perPage,
      count: result.length,
      total_count: matching.length,
      total_pages: Math.ceil(matching.length / perPage),
    })
  }

  #write(body: Partial<ARecord>, id: string | null): Response {
    if (body.name !== undefined && this.refusing.has(body.name)) return refused(400)
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

/** Cloudflare's v4 envelope around a result. */
function answer(status: number, result: unknown, resultInfo?: Record<string, number>): Response {
  return Response.json(
    { success: true, errors: [], messages: [], result, result_info: resultInfo },
    { status },
  )
}

/** A refusal by its status alone: what it means is the SDK's to say. */
function refused(status: number): Response {
  return new Response(null, { status })
}
