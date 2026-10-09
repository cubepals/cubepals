/**
 * Decides who a name is to a fake server, the way vanilla 26.x does (measured on real servers on
 * 2026-09-23): its name cache, `usercache.json`, then Mojang, then, where accounts aren't
 * checked, a UUID derived from the name. It does not decide who may join: the access lists and
 * the server do (`lists.ts`, `fake-minecraft.ts`).
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlayerProfiles } from '../../../app/ports/minecraft.ts'

type Player = { uuid: string; name: string }

/** One server's name cache: what it read as it started, and every name it has named since. */
export class NameCache {
  readonly #profiles: Pick<PlayerProfiles, 'byName'>
  /** Which name is which player, by lower-cased name. */
  #names = new Map<string, Player>()
  /** The volume it was read from, where it is saved. */
  #dir = ''

  constructor(profiles: Pick<PlayerProfiles, 'byName'>) {
    this.#profiles = profiles
  }

  /** As the server starts: the cache from its file. */
  async load(dir: string): Promise<void> {
    this.#dir = dir
    const text = await readFile(join(dir, 'usercache.json'), 'utf8').catch(() => '[]')
    const cached = JSON.parse(text) as Array<{ uuid: string; name: string }>
    this.#names = new Map(cached.map((e) => [e.name.toLowerCase(), { uuid: e.uuid, name: e.name }]))
  }

  /** A name in a command, the way vanilla looks it up: its cache, Mojang, then the name itself. */
  async resolve(name: string, checksAccounts: boolean): Promise<{ uuid: string; name: string } | null> {
    const known = this.#names.get(name.toLowerCase())
    if (known !== undefined) return known
    const account = await this.#profiles.byName(name)
    const found =
      account !== null
        ? { uuid: dashed(account.uuid), name: account.name }
        : checksAccounts || !/^\S{1,16}$/.test(name)
          ? null
          : { uuid: offlineUuid(name.toLowerCase()), name: name.toLowerCase() }
    if (found !== null) await this.remember(found)
    return found
  }

  async remember(player: { uuid: string; name: string }): Promise<void> {
    this.#names.set(player.name.toLowerCase(), player)
    await writeFile(
      join(this.#dir, 'usercache.json'),
      JSON.stringify(
        [...this.#names.values()].map((p) => ({ ...p, expiresOn: '2099-01-01 00:00:00 +0000' })),
      ),
    )
  }
}

export const checksAccounts = (env: Readonly<Record<string, string>>) =>
  (env.ONLINE_MODE ?? 'TRUE').toUpperCase() !== 'FALSE'

/** What a server that doesn't check accounts calls the player with this exact name. */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x30
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  return dashed(hash.toString('hex'))
}

export function dashed(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
