// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GeyserMC's download service and Xbox lookup, which give Blockly Floodgate's Paper jar (checked
 * against the hash they list for it) and the Xbox user id behind a gamertag. A gamertag their cache
 * has not seen is no player here; only a server error is a failure.
 */

import { createHash } from 'node:crypto'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { FloodgateJar, GeyserMc } from '../../app/ports/geysermc.ts'

/**
 * GeyserMC's download service and its Xbox lookup (measured 2026-10-22). The download service lists
 * a project's versions, and per version its builds, each with its jars' SHA-256; the lookup answers
 * `{"xuid": …}` for a gamertag its cache has seen, and a 400 or 404 with a message for any other.
 */
const DOWNLOADS = 'https://download.geysermc.org/v2/projects/floodgate'
const XBOX = 'https://api.geysermc.org/v2/xbox/xuid'
/** The jar for Paper and Spigot, which are one. */
const JAR = 'spigot'
/** Floodgate’s jar is about 11 MB; anything far larger is not it. */
const JAR_MAX_BYTES = 64 * 1024 * 1024
const TTL_MS = 10 * MINUTE_MS

/** The Bedrock capability for a deployment's key: GeyserMC and the key, or none without one. */
export const bedrockCapability = (floodgateKey: string | null) =>
  floodgateKey === null ? null : { floodgateKey, geyser: new GeyserMcService() }

export class GeyserMcService implements GeyserMc {
  readonly #fetch: typeof fetch
  readonly #seen = new Map<string, { at: number; xuid: string | null }>()

  constructor(deps: { fetch?: typeof fetch } = {}) {
    this.#fetch = deps.fetch ?? fetch
  }

  async latestFloodgate(): Promise<FloodgateJar | null> {
    const project = await this.#json<{ versions?: string[] }>(DOWNLOADS)
    const version = project.versions?.at(-1)
    if (version === undefined) return null
    const build = await this.#json<{
      build?: number
      downloads?: Record<string, { name?: string; sha256?: string }>
    }>(`${DOWNLOADS}/versions/${version}/builds/latest`)
    const listed = build.downloads?.[JAR]
    if (build.build === undefined || !listed?.name || !listed.sha256) return null
    const url = `${DOWNLOADS}/versions/${version}/builds/${build.build}/downloads/${JAR}`
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(MINUTE_MS) })
    if (!response.ok) throw new Error(`GeyserMC answered ${response.status} for Floodgate ${version}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > JAR_MAX_BYTES) throw new Error('Floodgate’s jar is larger than a plugin should be')
    if (createHash('sha256').update(bytes).digest('hex') !== listed.sha256)
      throw new Error(`Floodgate ${version} build ${build.build} does not match the hash GeyserMC lists`)
    return {
      version,
      build: build.build,
      fileName: listed.name,
      url,
      sha512: createHash('sha512').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    }
  }

  async xuidOf(gamertag: string): Promise<string | null> {
    const key = gamertag.toLowerCase()
    const hit = this.#seen.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.xuid
    const response = await this.#fetch(`${XBOX}/${encodeURIComponent(gamertag)}`, {
      signal: AbortSignal.timeout(5 * SECOND_MS),
    })
    // A gamertag its cache hasn't seen is a 400 with a message; only a server error is a failure.
    if (response.status >= 500) throw new Error(`GeyserMC answered ${response.status}`)
    const xuid = response.ok ? /"xuid"\s*:\s*"?(\d+)/.exec(await response.text())?.[1] : undefined
    this.#seen.set(key, { at: Date.now(), xuid: xuid ?? null })
    return xuid ?? null
  }

  async #json<T>(url: string): Promise<T> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(10 * SECOND_MS) })
    if (!response.ok) throw new Error(`GeyserMC answered ${response.status}`)
    return (await response.json()) as T
  }
}
