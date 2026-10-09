import { PNG } from 'pngjs'
import type { PlayerProfiles, SkinPixels } from '../../app/ports/minecraft.ts'

/**
 * Mojang profile lookups (api.minecraftservices.com). Names change hands, so a lookup is cached
 * briefly and never treated as permanent.
 */
const BASE = 'https://api.minecraftservices.com/minecraft/profile/lookup'
const TTL_MS = 10 * 60_000
/** Where an account's textures are listed, and the one host Mojang serves the textures from. */
const SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile'
const TEXTURES = 'textures.minecraft.net'
/** A skin is a few kilobytes; anything much larger is not one. */
const SKIN_MAX_BYTES = 256 * 1024

type Profile = { uuid: string; name: string }

export class MojangProfiles implements PlayerProfiles {
  readonly #cache = new Map<string, { at: number; profile: Profile | null }>()
  readonly #fetch: typeof fetch

  constructor(deps: { fetch?: typeof fetch } = {}) {
    this.#fetch = deps.fetch ?? fetch
  }

  byName(name: string): Promise<Profile | null> {
    return this.#cached(`name:${name.toLowerCase()}`, `${BASE}/name/${encodeURIComponent(name)}`)
  }

  byUuid(uuid: string): Promise<Profile | null> {
    return this.#cached(`uuid:${uuid.toLowerCase()}`, `${BASE}/${encodeURIComponent(uuid.replace(/-/g, ''))}`)
  }

  /** Not cached here: whoever asks for faces keeps them (app/access/faces.ts). */
  async skinOf(uuid: string): Promise<SkinPixels | null> {
    const listed = await this.#fetch(`${SESSION}/${encodeURIComponent(uuid.replace(/-/g, ''))}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (listed.status === 404 || listed.status === 204) return null
    if (!listed.ok) throw new Error(`Mojang answered ${listed.status}`)
    const body = (await listed.json()) as { properties?: { name?: string; value?: string }[] }
    const encoded = body.properties?.find((p) => p.name === 'textures')?.value
    if (!encoded) return null
    const textures = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string } }
    }
    const url = skinUrl(textures.textures?.SKIN?.url)
    if (url === null) return null

    const response = await this.#fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Mojang's textures answered ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > SKIN_MAX_BYTES) return null
    const png = PNG.sync.read(bytes)
    return { width: png.width, height: png.height, rgba: new Uint8Array(png.data) }
  }

  async #cached(key: string, url: string): Promise<Profile | null> {
    const hit = this.#cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.profile
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (response.status === 404 || response.status === 204) {
      this.#cache.set(key, { at: Date.now(), profile: null })
      return null
    }
    if (!response.ok) throw new Error(`Mojang answered ${response.status}`)
    const body = (await response.json()) as { id?: string; name?: string }
    const profile = body.id && body.name ? { uuid: body.id, name: body.name } : null
    this.#cache.set(key, { at: Date.now(), profile })
    return profile
  }
}

/** Mojang lists textures over plain http; they are fetched over https, and only from its host. */
function skinUrl(listed: string | undefined): URL | null {
  if (!listed) return null
  try {
    const url = new URL(listed)
    if (url.hostname !== TEXTURES) return null
    url.protocol = 'https:'
    return url
  } catch {
    return null
  }
}
