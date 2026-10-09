import { z } from 'zod'
import { type BuiltLoader, type LoaderBuilds, LoaderBuildsUnavailable } from '../../app/ports/loaders.ts'

/**
 * Each server type's own build list, read the way the image's installer reads it when no build is
 * pinned (mc-image-helper's LATEST, RECOMMENDED and default channel), so a pin is what the server
 * would have booted that day. None of them has an SDK or a published API description beyond
 * Paper's, and each answer is one small JSON document; checked on 2026-09-19 against the live
 * services (docs/dependency-audit.md).
 */
const FABRIC = 'https://meta.fabricmc.net/v2/versions/loader'
const QUILT = 'https://meta.quiltmc.org/v3/versions/loader'
const PAPER = 'https://fill.papermc.io/v3/projects/paper/versions'
const FORGE = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const NEOFORGE = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'

/** A build list changes a few times a week; a revision made a few minutes later pins the same. */
const TTL_MS = 10 * 60_000
/** Paper's API turns away requests that don't say who is asking. */
const USER_AGENT = 'blockly-control-plane (loader build pins)'

const FabricLoaders = z.array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) }))
const QuiltLoaders = z.array(z.object({ loader: z.object({ version: z.string() }) }))
const PaperBuilds = z.array(z.object({ id: z.number().int(), channel: z.string() }))
const ForgePromotions = z.object({ promos: z.record(z.string(), z.string()) })
const NeoForgeVersions = z.object({ versions: z.array(z.string()) })

export class UpstreamLoaderBuilds implements LoaderBuilds {
  readonly #fetch: typeof fetch
  readonly #cache = new Map<string, { at: number; value: unknown }>()

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.#fetch = options.fetch ?? fetch
  }

  async current(loader: BuiltLoader, gameVersion: string): Promise<string | null> {
    const version = encodeURIComponent(gameVersion)
    switch (loader) {
      case 'fabric': {
        // An unknown game version is a 400 with an empty list.
        const loaders = await this.#read(loader, `${FABRIC}/${version}`, FabricLoaders, [400, 404])
        return loaders?.find((l) => l.loader.stable)?.loader.version ?? null
      }
      case 'quilt': {
        const loaders = await this.#read(loader, `${QUILT}/${version}`, QuiltLoaders, [404])
        return newest((loaders ?? []).map((l) => l.loader.version).filter(isRelease))
      }
      case 'paper': {
        const builds = await this.#read(loader, `${PAPER}/${version}/builds`, PaperBuilds, [404])
        const stable = (builds ?? []).filter((b) => b.channel === 'STABLE').map((b) => b.id)
        return stable.length === 0 ? null : String(Math.max(...stable))
      }
      case 'forge': {
        const promotions = await this.#read(loader, FORGE, ForgePromotions, [])
        return promotions?.promos[`${gameVersion}-recommended`] ?? null
      }
      case 'neoforge': {
        const all = await this.#read(loader, NEOFORGE, NeoForgeVersions, [])
        const prefix = neoForgePrefix(gameVersion)
        return newest((all?.versions ?? []).filter((v) => v.startsWith(prefix) && isRelease(v)))
      }
    }
  }

  /** The parsed answer, or null where the service says it has nothing for that version. */
  async #read<T>(
    loader: BuiltLoader,
    url: string,
    shape: z.ZodType<T>,
    nothing: number[],
  ): Promise<T | null> {
    const hit = this.#cache.get(url)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T | null
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new LoaderBuildsUnavailable(loader, error instanceof Error ? error.message : String(error))
    }
    if (nothing.includes(response.status)) {
      this.#cache.set(url, { at: Date.now(), value: null })
      return null
    }
    if (!response.ok) throw new LoaderBuildsUnavailable(loader, `answered ${response.status}`)
    const parsed = shape.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) throw new LoaderBuildsUnavailable(loader, 'answered in a shape it never used before')
    this.#cache.set(url, { at: Date.now(), value: parsed.data })
    return parsed.data
  }
}

/** Betas, release candidates and snapshots carry a suffix after a dash. */
const isRelease = (version: string) => !version.includes('-')

/** The highest of dotted numeric versions, compared part by part. */
function newest(versions: readonly string[]): string | null {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  let best: string | null = null
  for (const version of versions) {
    if (best === null) {
      best = version
      continue
    }
    const [a, b] = [parts(version), parts(best)]
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0)
      if (diff !== 0) {
        if (diff > 0) best = version
        break
      }
    }
  }
  return best
}

/**
 * NeoForge numbers its builds after the game version it's for: 1.21.8 → 21.8.x, 1.21 → 21.0.x,
 * and the year-numbered releases keep their own numbers with the patch spelled out: 26.2 →
 * 26.2.0.x, 26.1.2 → 26.1.2.x.
 */
function neoForgePrefix(gameVersion: string): string {
  const [major = '0', minor = '0', patch = '0'] = gameVersion.split('.')
  return major === '1' ? `${minor}.${patch}.` : `${major}.${minor}.${patch}.`
}
