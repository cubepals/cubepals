import type { PlayAddress, PlayAddressing, RegionCatalog } from '../app/ports/platform.ts'
import { checkSlug } from '../domain/server/slug.ts'

/** Addresses are the slug plus configuration. Nothing here is persisted. */
export class ConfiguredPlayAddressing implements PlayAddressing {
  readonly #domains: readonly string[]
  readonly #port: number

  constructor(play: { domain: string; aliases: readonly string[]; port: number }) {
    this.#domains = [play.domain, ...play.aliases]
    this.#port = play.port
  }

  primary(slug: string): PlayAddress {
    return { hostname: `${slug}.${this.#domains[0]}`, port: this.#port }
  }

  all(slug: string): readonly PlayAddress[] {
    return this.#domains.map((domain) => ({ hostname: `${slug}.${domain}`, port: this.#port }))
  }

  domains() {
    return this.#domains.map((domain, i) => ({ domain, alias: i > 0 }))
  }

  domainFor(hostname: string): string | null {
    const host = normalized(hostname)
    return this.#domains.find((domain) => host.endsWith(`.${domain}`)) ?? null
  }

  slugFor(hostname: string): string | null {
    const host = normalized(hostname)
    for (const domain of this.#domains) {
      if (!host.endsWith(`.${domain}`)) continue
      const label = host.slice(0, -(domain.length + 1))
      if (label.includes('.')) return null
      return checkSlug(label).ok ? label : null
    }
    return null
  }
}

/** How an edge reports a hostname: any case, maybe a port, maybe a trailing dot. */
const normalized = (hostname: string) => hostname.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')

export class ConfiguredRegionCatalog implements RegionCatalog {
  readonly #regions: readonly { key: string; label: string }[]

  constructor(regions: readonly { key: string; label: string }[]) {
    this.#regions = regions
  }

  get defaultKey(): string {
    const first = this.#regions[0]
    if (first === undefined) throw new Error('At least one region must be configured')
    return first.key
  }

  list() {
    return this.#regions
  }

  label(key: string): string | null {
    return this.#regions.find((r) => r.key === key)?.label ?? null
  }
}
