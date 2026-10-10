// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holds a fake server's access lists (whitelist, operators, player and IP bans) as the running
 * server does: read from their files as it starts, kept in memory, and each saved whole over its
 * file when a command changes it. It does not decide what a command does to a list, or who a name
 * is: the access commands and the name cache do (`access-commands.ts`, `names.ts`).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Entry = Record<string, unknown>

export class AccessLists {
  /** The lists as the running server holds them, by file name. */
  readonly #lists = new Map<string, Entry[]>()
  /** The volume they were read from, where they are saved. */
  #dir = ''

  /** As the server starts: every list from its file, created empty where missing. */
  async load(dir: string): Promise<void> {
    this.#dir = dir
    for (const name of ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) {
      const entries = await this.#read(name)
      this.#lists.set(name, entries)
      await writeFile(join(this.#dir, name), JSON.stringify(entries, null, 2), { flag: 'wx' }).catch(
        () => undefined,
      )
    }
  }

  /** One list read again from its file, as `whitelist reload` does. */
  async reload(name: string): Promise<void> {
    this.#lists.set(name, await this.#read(name))
  }

  /** A list as the running server holds it. */
  async list(name: string): Promise<Entry[]> {
    return this.held(name)
  }

  held(name: string): Entry[] {
    return this.#lists.get(name) ?? []
  }

  /** A change to a list: the server's memory, saved whole over the file. */
  async save(name: string, entries: Entry[]): Promise<void> {
    this.#lists.set(name, entries)
    await writeFile(join(this.#dir, name), JSON.stringify(entries, null, 2))
  }

  async #read(name: string): Promise<Entry[]> {
    const text = await readFile(join(this.#dir, name), 'utf8').catch(() => '[]')
    return JSON.parse(text) as Entry[]
  }
}
