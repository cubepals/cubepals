// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answers the console commands that change who may play on a fake server (whitelist, op and deop,
 * ban and pardon, by name or address) in vanilla's own words, and makes the change they report. It
 * does not hold the lists or name players: the lists and the name cache do (`lists.ts`,
 * `names.ts`); the game commands and the dispatch of every command are the server's
 * (`fake-minecraft.ts`).
 */

import type { AccessLists } from './lists.ts'
import { dashed, type NameCache } from './names.ts'
import { turnWhitelist, whitelistOn } from './properties.ts'

/** What the access commands read and change on one server; built afresh for each command. */
export interface AccessServer {
  /** The volume, whose `server.properties` holds whether the whitelist is on. */
  dir: string
  enforcesWhitelist: boolean
  checksAccounts: boolean
  lists: AccessLists
  names: NameCache
  /** Who is playing, by UUID: a ban, or a whitelist that no longer holds them, kicks them. */
  online: Map<string, string>
}

export async function whitelist(server: AccessServer, args: string[]): Promise<string> {
  const [action, name = ''] = args
  if (action === 'on' || action === 'off') {
    await turnWhitelist(server.dir, action === 'on')
    if (action === 'on') await kickUnlisted(server)
    return action === 'on' ? 'Whitelist is now turned on' : 'Whitelist is now turned off'
  }
  if (action === 'reload') {
    await server.lists.reload('whitelist.json')
    await kickUnlisted(server)
    return 'Reloaded the whitelist'
  }
  const profile = await server.names.resolve(name, server.checksAccounts)
  if (profile === null) return 'That player does not exist'
  const list = await server.lists.list('whitelist.json')
  if (action === 'add') {
    if (list.some((e) => e.uuid === dashed(profile.uuid))) return 'Player is already whitelisted'
    await server.lists.save('whitelist.json', [...list, { uuid: dashed(profile.uuid), name: profile.name }])
    return `Added ${profile.name} to the whitelist`
  }
  if (action === 'remove') {
    if (!list.some((e) => e.uuid === dashed(profile.uuid))) return 'Player is not whitelisted'
    await server.lists.save(
      'whitelist.json',
      list.filter((e) => e.uuid !== dashed(profile.uuid)),
    )
    return `Removed ${profile.name} from the whitelist`
  }
  return 'Unknown or incomplete command, see below for error'
}

export async function op(server: AccessServer, verb: 'op' | 'deop', name: string): Promise<string> {
  const profile = await server.names.resolve(name, server.checksAccounts)
  if (profile === null) return 'That player does not exist'
  const ops = await server.lists.list('ops.json')
  const uuid = dashed(profile.uuid)
  if (verb === 'op') {
    if (ops.some((e) => e.uuid === uuid)) return 'Nothing changed. The player already is an operator'
    await server.lists.save('ops.json', [
      ...ops,
      { uuid, name: profile.name, level: 4, bypassesPlayerLimit: false },
    ])
    return `Made ${profile.name} a server operator`
  }
  if (!ops.some((e) => e.uuid === uuid)) return 'Nothing changed. The player is not an operator'
  await server.lists.save(
    'ops.json',
    ops.filter((e) => e.uuid !== uuid),
  )
  return `Made ${profile.name} no longer a server operator`
}

export async function ban(
  server: AccessServer,
  name: string,
  reason: string,
  source: string,
): Promise<string> {
  const profile = await server.names.resolve(name, server.checksAccounts)
  if (profile === null) return 'That player does not exist'
  const bans = await server.lists.list('banned-players.json')
  const uuid = dashed(profile.uuid)
  if (bans.some((e) => e.uuid === uuid)) return 'Nothing changed. The player is already banned'
  const entry = {
    uuid,
    name: profile.name,
    created: stamp(new Date()),
    source,
    expires: 'forever',
    reason: reason || 'Banned by an operator.',
  }
  await server.lists.save('banned-players.json', [...bans, entry])
  server.online.delete(uuid)
  return `Banned ${profile.name}: ${entry.reason}`
}

export async function pardon(server: AccessServer, name: string): Promise<string> {
  const bans = await server.lists.list('banned-players.json')
  const profile = await server.names.resolve(name, server.checksAccounts)
  const entry = profile === null ? undefined : bans.find((e) => e.uuid === profile.uuid)
  if (entry === undefined) return "Nothing changed. The player isn't banned"
  await server.lists.save(
    'banned-players.json',
    bans.filter((e) => e !== entry),
  )
  return `Unbanned ${entry.name}`
}

export async function banIp(lists: AccessLists, ip: string, reason: string, source: string): Promise<string> {
  const bans = await lists.list('banned-ips.json')
  if (bans.some((e) => e.ip === ip)) return 'Nothing changed. That IP is already banned'
  const entry = {
    ip,
    created: stamp(new Date()),
    source,
    expires: 'forever',
    reason: reason || 'Banned by an operator.',
  }
  await lists.save('banned-ips.json', [...bans, entry])
  return `Banned IP ${ip}: ${entry.reason}`
}

export async function pardonIp(lists: AccessLists, ip: string): Promise<string> {
  const bans = await lists.list('banned-ips.json')
  if (!bans.some((e) => e.ip === ip)) return "Nothing changed. That IP isn't banned"
  await lists.save(
    'banned-ips.json',
    bans.filter((e) => e.ip !== ip),
  )
  return `Unbanned IP ${ip}`
}

/** With the whitelist enforced, whoever it no longer holds is kicked. */
async function kickUnlisted(server: AccessServer): Promise<void> {
  if (!server.enforcesWhitelist || !(await whitelistOn(server.dir))) return
  const listed = new Set(server.lists.held('whitelist.json').map((e) => e.uuid))
  for (const uuid of [...server.online.keys()]) if (!listed.has(uuid)) server.online.delete(uuid)
}

/** Vanilla's ban timestamp: `2026-09-19 07:00:00 +0000`. */
const stamp = (at: Date) => `${at.toISOString().slice(0, 19).replace('T', ' ')} +0000`
