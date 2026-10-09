import { promises as dns } from 'node:dns'

/**
 * The realtime hostname must have no AAAA record (§19.6): WebTransport arrives over UDP on the
 * dedicated IPv4 only, and a browser that finds an IPv6 address tries it first and fails. Checked
 * when the realtime role starts in `acme` mode.
 */
export async function assertIpv4Only(
  hostname: string,
  resolve6: (hostname: string) => Promise<string[]> = dns.resolve6,
): Promise<void> {
  const addresses = await resolve6(hostname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return []
    throw error
  })
  if (addresses.length > 0)
    throw new Error(
      `${hostname} has an AAAA record (${addresses.join(', ')}). Browsers would try IPv6 first, where the realtime role gets no UDP; remove it.`,
    )
}
