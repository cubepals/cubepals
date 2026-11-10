// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The records the control plane writes in its Cloudflare zone, through Cloudflare's own SDK, with
 * a token that may edit that zone's DNS and nothing else: the realtime certificate's DNS-01
 * answers, and the play names' own A records (`app/edge/play-records.ts`). Not for the records
 * Terraform keeps (infra/terraform/modules/dns), which neither touches.
 */
import Cloudflare, { type ClientOptions } from 'cloudflare'
import type { PlayRecord, PlayRecords } from '../../app/ports/play-records.ts'

/** The zone, and a token that may edit its DNS (CLOUDFLARE_ZONE_ID, CLOUDFLARE_DNS_API_TOKEN). */
interface ZoneAccess {
  apiToken: string
  zoneId: string
}

/** For tests: what the SDK sends its requests with, and how often it tries again. */
type Transport = Pick<ClientOptions, 'fetch' | 'maxRetries'>

/**
 * DNS-01 answers as TXT records in a Cloudflare zone, through Cloudflare's own SDK: the solver
 * `AcmeIssuer` (infra/acme) is given. The token needs Zone.DNS edit on that zone only.
 */
export class CloudflareDns01 {
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

/**
 * The TTL the play names' wildcard records have (`play_v4` in infra/terraform/modules/dns): a
 * name's own record is kept as long, so a resolver holds either answer the same while one moves.
 */
const PLAY_TTL_SECONDS = 300

/**
 * The play names' own A records, each marked as this deployment's by its comment, which is how
 * they are found again: a deployment lists and changes only records with its own mark, so two
 * deployments sharing the zone (staging and production) never touch each other's. DNS-only, as
 * Cloudflare's proxy doesn't carry Minecraft.
 */
export class CloudflarePlayRecords implements PlayRecords {
  readonly #cloudflare: Cloudflare
  readonly #zoneId: string
  readonly #mark: string

  constructor(zone: ZoneAccess & { deploymentId: string }, transport: Transport = {}) {
    this.#cloudflare = new Cloudflare({ apiToken: zone.apiToken, ...transport })
    this.#zoneId = zone.zoneId
    this.#mark = `Blockly ${zone.deploymentId}: a play name's own address, kept by the control plane`
  }

  async list(): Promise<PlayRecord[]> {
    const held: PlayRecord[] = []
    for await (const record of this.#cloudflare.dns.records.list({
      zone_id: this.#zoneId,
      type: 'A',
      comment: { exact: this.#mark },
    })) {
      // The filter ignores case; the mark is exact.
      if (record.type === 'A' && record.comment === this.#mark)
        held.push({ id: record.id, name: record.name, ipv4: record.content ?? '' })
    }
    return held
  }

  async create(name: string, ipv4: string): Promise<void> {
    await this.#cloudflare.dns.records.create({ zone_id: this.#zoneId, ...this.#record(name, ipv4) })
  }

  async update(record: PlayRecord): Promise<void> {
    await this.#cloudflare.dns.records.update(record.id, {
      zone_id: this.#zoneId,
      ...this.#record(record.name, record.ipv4),
    })
  }

  async remove(id: string): Promise<void> {
    await this.#cloudflare.dns.records.delete(id, { zone_id: this.#zoneId })
  }

  #record(name: string, ipv4: string) {
    return {
      type: 'A' as const,
      name,
      content: ipv4,
      ttl: PLAY_TTL_SECONDS,
      proxied: false,
      comment: this.#mark,
    }
  }
}

/** The play names' own records and each region's address, when the deployment keeps any. */
export function playRecordsFor(
  play: { regionIpv4: Readonly<Record<string, string>>; records: ZoneAccess | null },
  deploymentId: string,
): { records: PlayRecords; regionIpv4: Readonly<Record<string, string>> } | null {
  return play.records === null
    ? null
    : { records: new CloudflarePlayRecords({ ...play.records, deploymentId }), regionIpv4: play.regionIpv4 }
}
