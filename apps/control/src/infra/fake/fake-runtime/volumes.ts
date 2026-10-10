// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps each server's storage as directories under the fake's root: its volumes, and the copies
 * its snapshots are. It knows nothing of boxes, handles or power: which directory a server uses
 * now, and when one is made or let go, are the runtime's (`fake-runtime.ts`).
 */

import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The directories of one fake provider in one deployment. */
export class Volumes {
  readonly #root: string
  readonly #deployment: string
  readonly #provider: string

  constructor(root: string, deployment: string, provider: string) {
    this.#root = root
    this.#deployment = deployment
    this.#provider = provider
  }

  /** A new, empty volume for the server. */
  async create(key: string): Promise<string> {
    return mkdtemp(join(await this.#home(key), 'volume-'))
  }

  /** Everything in `from` copied into `to`. */
  async copy(from: string, to: string): Promise<void> {
    await cp(from, to, { recursive: true })
  }

  /** A copy of the volume at `from`, kept as the server's snapshot `id`, and how many bytes it holds. */
  async snapshot(key: string, id: string, from: string): Promise<{ dir: string; sizeBytes: number }> {
    const dir = join(await this.#home(key), `snapshot-${id}`)
    await cp(from, dir, { recursive: true })
    return { dir, sizeBytes: await sizeOf(dir) }
  }

  /** A volume or a snapshot gone; one already gone is fine. */
  async remove(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true })
  }

  /** Everything the server had on disk gone. */
  async removeAll(key: string): Promise<void> {
    await rm(this.#homeOf(key), { recursive: true, force: true })
  }

  async #home(key: string): Promise<string> {
    const dir = this.#homeOf(key)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** Where a server's storage lives; a second fake keeps its own, as two providers never share disks. */
  #homeOf(key: string): string {
    return this.#provider === 'fake'
      ? join(this.#root, this.#deployment, key)
      : join(this.#root, this.#deployment, this.#provider, key)
  }
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
  return total
}
