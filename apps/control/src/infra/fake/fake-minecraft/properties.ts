// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads and writes a fake server's `server.properties`: the file the image writes from the
 * environment as the server starts, and the `white-list` line the server reads and rewrites. It
 * holds nothing in memory; what the running game plays by is the server's (`fake-minecraft.ts`).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Env = Readonly<Record<string, string>>

/** What the image writes as the server starts: the environment, keeping `white-list` once set. */
export async function writeProperties(dir: string, env: Env): Promise<void> {
  const file = join(dir, 'server.properties')
  const existing = await readFile(file, 'utf8').catch(() => null)
  const whitelist = existing === null ? 'false' : (/^white-list=(.*)$/m.exec(existing)?.[1] ?? 'false')
  const properties = {
    difficulty: env.DIFFICULTY ?? 'easy',
    gamemode: env.MODE ?? 'survival',
    pvp: env.PVP ?? 'true',
    'view-distance': env.VIEW_DISTANCE ?? '10',
    'simulation-distance': env.SIMULATION_DISTANCE ?? '10',
    'max-players': env.MAX_PLAYERS ?? '20',
    motd: env.MOTD ?? 'A Minecraft Server',
    'spawn-protection': env.SPAWN_PROTECTION ?? '16',
    'level-name': env.LEVEL ?? 'world',
    'online-mode': (env.ONLINE_MODE ?? 'TRUE').toLowerCase(),
    'enforce-whitelist': (env.ENFORCE_WHITELIST ?? 'FALSE').toLowerCase(),
    'white-list': whitelist,
  }
  await writeFile(
    file,
    `${Object.entries(properties)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  )
}

/** Whether the whitelist is on, as the file says now. */
export async function whitelistOn(dir: string): Promise<boolean> {
  const properties = await readFile(join(dir, 'server.properties'), 'utf8').catch(() => '')
  return /^white-list=true$/m.test(properties)
}

/** The whitelist turned on or off: only its line of the file changes. */
export async function turnWhitelist(dir: string, on: boolean): Promise<void> {
  const file = join(dir, 'server.properties')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace(/^white-list=.*$/m, `white-list=${on}`))
}
