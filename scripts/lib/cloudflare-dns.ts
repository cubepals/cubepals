/**
 * One DNS record in a Cloudflare zone, made or corrected to what a script wants. The token needs
 * only "Edit zone DNS" on that zone. Used by staging.ts to put staging.cubepals.com on Fly.
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

/** `name` as a DNS-only CNAME to `target`, so the host behind it can get its own certificate. */
export async function pointCname(token: string, zone: string, name: string, target: string): Promise<void> {
  const cloudflare = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    const answer = (await response.json()) as Answer<T>
    if (!answer.success)
      throw new Error(`Cloudflare ${path}: ${answer.errors.map((e) => e.message).join('; ')}`)
    return answer.result
  }
  const [found] = await cloudflare<{ id: string }[]>(`/zones?name=${zone}`)
  if (!found) throw new Error(`Cloudflare has no zone ${zone} this token can reach`)
  const records = `/zones/${found.id}/dns_records`
  const [record] = await cloudflare<DnsRecord[]>(`${records}?name=${name}`)
  const body = JSON.stringify({ type: 'CNAME', name, content: target, proxied: false, ttl: 1 })
  if (!record) await cloudflare(records, { method: 'POST', body })
  else if (record.type !== 'CNAME' || record.content !== target || record.proxied)
    await cloudflare(`${records}/${record.id}`, { method: 'PUT', body })
}
