// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A release's item art, the way BlueMap gets it: from the release's own client jar, found through
 * Mojang's version manifest and checked against the SHA-1 the manifest gives, so Blockly never
 * bundles a texture. Only what draws items is kept (item definitions, models, item and block
 * textures: about 2 MB of a 40 MB jar), in one zip per release on this machine's disk, and in
 * memory once read. Browsers could fetch the jar themselves (every endpoint allows any origin,
 * checked 2026-10-07), but each would then download all 40 MB to check it, and tell Mojang who
 * looked at whose server.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { type ClientAssets, type ClientFiles, ClientJarRejected } from '../../app/ports/minecraft.ts'

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** A client jar is about 40 MB; anything far larger isn't one. */
const MAX_JAR_BYTES = 200 * 1024 * 1024
const KEPT =
  /^assets\/minecraft\/(items\/[a-z0-9_]+\.json|models\/(item|block)\/[a-z0-9_/]+\.json|textures\/(item|block)\/[a-z0-9_/]+\.png)$/
const PREFIX = 'assets/minecraft/'

export class MojangClientAssets implements ClientAssets {
  readonly #root: string
  readonly #fetch: typeof fetch
  readonly #manifest: string
  readonly #open = new Map<string, Promise<ClientFiles>>()

  /** `root`: where the kept files live between restarts; `manifest`, for tests, another manifest. */
  constructor(deps: { root: string; fetch?: typeof fetch; manifest?: string }) {
    this.#root = deps.root
    this.#fetch = deps.fetch ?? fetch
    this.#manifest = deps.manifest ?? MANIFEST
  }

  open(gameVersion: string): Promise<ClientFiles> {
    if (!/^[0-9a-z][0-9a-z._-]{0,40}$/.test(gameVersion)) return Promise.reject(new Error('Not a release'))
    let opening = this.#open.get(gameVersion)
    if (opening === undefined) {
      opening = this.#load(gameVersion)
      // A failure is asked again next time; a success is kept.
      opening.catch(() => this.#open.delete(gameVersion))
      this.#open.set(gameVersion, opening)
    }
    return opening
  }

  async #load(gameVersion: string): Promise<ClientFiles> {
    const path = join(this.#root, `${gameVersion}.zip`)
    const kept = await readFile(path).catch(() => null)
    const zip = kept ?? (await this.#fetchKept(gameVersion, path))
    const files = new Map(Object.entries(unzipSync(new Uint8Array(zip))))
    return { read: (name) => files.get(name) ?? null }
  }

  /** Downloads the jar, checks it, and keeps what draws items; the jar itself is let go. */
  async #fetchKept(gameVersion: string, path: string): Promise<Uint8Array> {
    const manifest = (await this.#json(this.#manifest)) as { versions?: { id: string; url: string }[] }
    const listed = manifest.versions?.find((v) => v.id === gameVersion)
    if (listed === undefined) throw new Error(`Mojang lists no release ${gameVersion}`)
    const version = (await this.#json(listed.url)) as {
      downloads?: { client?: { url: string; sha1: string; size: number } }
    }
    const client = version.downloads?.client
    if (client === undefined) throw new Error(`Release ${gameVersion} has no client`)
    if (client.size > MAX_JAR_BYTES)
      throw new ClientJarRejected(`${client.size} bytes is larger than a client jar`)
    const response = await this.#fetch(client.url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error(`Mojang answered ${response.status} for the client jar`)
    const jar = new Uint8Array(await response.arrayBuffer())
    const sha1 = createHash('sha1').update(jar).digest('hex')
    if (sha1 !== client.sha1) throw new ClientJarRejected(`its SHA-1 is ${sha1}, not ${client.sha1}`)
    const entries = unzipSync(jar, { filter: (file) => KEPT.test(file.name) })
    const zip = zipSync(
      Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name.slice(PREFIX.length), bytes])),
    )
    await mkdir(this.#root, { recursive: true })
    // Written whole, then put in place: a reader never finds half of it.
    await writeFile(`${path}.part`, zip)
    await rename(`${path}.part`, path)
    return zip
  }

  async #json(url: string): Promise<unknown> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Mojang answered ${response.status} for ${url}`)
    return response.json()
  }
}
