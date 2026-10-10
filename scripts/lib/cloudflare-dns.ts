// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One DNS record in a Cloudflare zone, made or corrected to what a script wants, and the account
 * that holds the zone. The token needs only "Edit zone DNS" on that zone. Used by staging.ts to put
 * its play domain on Fly's edge and staging.cubepals.com on its Worker.
 */

interface Answer<T> {
  success: boolean
  result: T
  errors: { message: string }[]
}

interface DnsRecord {
  id: string
  type: string
  content: string
  proxied: boolean
}

async function cloudflare<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  const answer = (await response.json()) as Answer<T>
  if (!answer.success)
    throw new Error(`Cloudflare ${path}: ${answer.errors.map((e) => e.message).join('; ')}`)
  return answer.result
}

async function zoneOf(token: string, zone: string): Promise<{ id: string; account: { id: string } }> {
  const [found] = await cloudflare<{ id: string; account: { id: string } }[]>(token, `/zones?name=${zone}`)
  if (!found) throw new Error(`Cloudflare has no zone ${zone} this token can reach`)
  return found
}

/** The id of the account the zone belongs to, which its Workers and buckets live in. */
export const zoneAccount = async (token: string, zone: string): Promise<string> =>
  (await zoneOf(token, zone)).account.id

/**
 * One record, by its name and type. DNS-only unless `proxied`: then Cloudflare answers for it,
 * as a Worker's route needs. A CNAME can't share its name, so one of another type there goes.
 */
export async function pointRecord(
  token: string,
  zone: string,
  want: { type: 'A' | 'AAAA' | 'CNAME'; name: string; content: string; proxied?: boolean },
): Promise<void> {
  const records = `/zones/${(await zoneOf(token, zone)).id}/dns_records`
  const named = await cloudflare<DnsRecord[]>(token, `${records}?name=${want.name}`)
  const conflicting = named.filter(
    (r) => r.type !== want.type && (r.type === 'CNAME' || want.type === 'CNAME'),
  )
  for (const other of conflicting) await cloudflare(token, `${records}/${other.id}`, { method: 'DELETE' })
  const record = named.find((r) => r.type === want.type)
  const proxied = want.proxied ?? false
  const body = JSON.stringify({ ...want, proxied, ttl: 1 })
  if (!record) await cloudflare(token, records, { method: 'POST', body })
  else if (record.content !== want.content || record.proxied !== proxied)
    await cloudflare(token, `${records}/${record.id}`, { method: 'PUT', body })
}
