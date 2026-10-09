import Cloudflare from 'cloudflare'
import type { Dns01Solver } from './acme-issuer.ts'

/**
 * DNS-01 answers as TXT records in a Cloudflare zone, through Cloudflare's own SDK. The token
 * needs Zone.DNS edit on that zone only.
 */
export class CloudflareDns01 implements Dns01Solver {
  readonly #cloudflare: Cloudflare
  readonly #zoneId: string

  constructor(options: { apiToken: string; zoneId: string }) {
    this.#cloudflare = new Cloudflare({ apiToken: options.apiToken })
    this.#zoneId = options.zoneId
  }

  async present(fqdn: string, value: string): Promise<void> {
    await this.#cloudflare.dns.records.create({
      zone_id: this.#zoneId,
      type: 'TXT',
      name: fqdn,
      // TXT content is RFC 1035 character strings, quoted.
      content: `"${value}"`,
      ttl: 60,
      comment: 'ACME DNS-01 for the Blockly realtime certificate; removed once validated',
    })
  }

  async cleanup(fqdn: string, value: string): Promise<void> {
    for await (const record of this.#cloudflare.dns.records.list({
      zone_id: this.#zoneId,
      type: 'TXT',
      name: { exact: fqdn },
    })) {
      if (record.content?.replaceAll('"', '') === value)
        await this.#cloudflare.dns.records.delete(record.id, { zone_id: this.#zoneId })
    }
  }
}
