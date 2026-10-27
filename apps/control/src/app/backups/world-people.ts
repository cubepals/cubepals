// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who could join the server a world came from (docs/world-import.md § Who can join): its
 * whitelist, operators and bans, read from the files beside its `server.properties`, each player
 * named as the server the world goes to knows them. Reading them lets nobody in: its owner chooses
 * who comes (`accessFrom`). Not for the world's own files, which `world-reading.ts` reads.
 */
import { isBedrockUuid, MOST_WORLD_PEOPLE, type PeopleChoice } from '@blockly/contracts'
import type { WorldPeopleJson, WorldPersonJson } from '@blockly/db'
import type { AccessEntry, SeededAccess } from '../../domain/access/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { offlineUuid } from '../access/identity.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'

/** The files a server keeps who may join it in, beside its `server.properties`. */
const ACCESS_FILES = ['whitelist.json', 'ops.json', 'banned-players.json'] as const

/** What of a read upload its server's files are found by (`Read` in `world-reading.ts`). */
interface Read {
  archive: { kept: ReadonlyMap<string, Uint8Array> }
  holds: { properties: string | null }
  world: { folder: string }
}

/** One row of a server's access file, as Minecraft writes them; anything else in it is skipped. */
interface Listed {
  uuid: string
  name: string
  reason: string | null
  expires: string | null
}

/**
 * Who could join the server the upload came from, for a server that checks accounts where
 * `onlineMode` says so; null where the upload has none of its files. A player the server knew by
 * an account keeps it; one an offline-mode server made up from a name is looked up as an account,
 * and a name nobody has is left out and named. A ban that has run out is gone. Null too where
 * there is nobody to choose.
 */
export async function peopleOf(
  read: Read,
  onlineMode: boolean,
  profiles: PlayerProfiles,
  now = new Date(),
): Promise<WorldPeopleJson | null> {
  const dir = serverFolder(read)
  const lists = ACCESS_FILES.map((file) => read.archive.kept.get(`${dir}${file}`))
  if (lists.every((raw) => raw === undefined)) return null
  const [whitelist, operators, bans] = lists.map((raw) => listedIn(raw).slice(0, MOST_WORLD_PEOPLE)) as [
    Listed[],
    Listed[],
    Listed[],
  ]
  const unknown = new Set<string>()
  const known = new Map<string, WorldPersonJson | null>()
  const named = async (listed: Listed): Promise<WorldPersonJson | null> => {
    const key = `${listed.uuid}:${listed.name}`
    if (!known.has(key)) known.set(key, await asTheyAre(listed, onlineMode, profiles))
    const person = known.get(key) ?? null
    if (person === null) unknown.add(listed.name)
    return person
  }
  // One at a time: a name on several lists is looked up once, and Mojang is asked at a walk.
  const each = async (rows: Listed[]) => {
    const found: Array<{ row: Listed; person: WorldPersonJson }> = []
    for (const row of rows) {
      const person = await named(row)
      if (person !== null) found.push({ row, person })
    }
    return found
  }
  const properties = read.holds.properties === null ? undefined : read.archive.kept.get(read.holds.properties)
  const people: WorldPeopleJson = {
    whitelistOn:
      properties !== undefined && /^white-list\s*=\s*true\s*$/m.test(new TextDecoder().decode(properties)),
    whitelist: (await each(whitelist)).map(({ person }) => person),
    operators: (await each(operators)).map(({ person }) => person),
    bans: (await each(bans.filter((ban) => !ranOut(ban, now)))).map(({ row, person }) => ({
      ...person,
      reason: row.reason,
    })),
    unknown: [...unknown],
  }
  // Nothing to choose from: a server open to all that let nobody in, made nobody operator and banned nobody.
  const empty =
    !people.whitelistOn &&
    [people.whitelist, people.operators, people.bans, people.unknown].every((list) => list.length === 0)
  return empty ? null : people
}

/** The folder the server's own files are in: its `server.properties`', else the one above the world. */
function serverFolder(read: Read): string {
  const properties = read.holds.properties
  if (properties !== null) return properties.slice(0, properties.lastIndexOf('/') + 1)
  const world = read.world.folder.slice(0, -1)
  return world.includes('/') ? world.slice(0, world.lastIndexOf('/') + 1) : ''
}

/** The player a row names to the server a world goes to; null where no account has the name. */
async function asTheyAre(
  listed: Listed,
  onlineMode: boolean,
  profiles: PlayerProfiles,
): Promise<WorldPersonJson | null> {
  if (isBedrockUuid(listed.uuid)) return { uuid: listed.uuid, name: listed.name }
  if (!onlineMode) return { uuid: offlineUuid(listed.name), name: listed.name }
  if (listed.uuid !== offlineUuid(listed.name)) return { uuid: listed.uuid, name: listed.name }
  const profile = await profiles.byName(listed.name).catch(() => null)
  return profile === null ? null : { uuid: normalizeUuid(profile.uuid).toLowerCase(), name: profile.name }
}

/** A ban Minecraft would no longer hold: one whose `expires` has passed. */
function ranOut(ban: Listed, now: Date): boolean {
  if (ban.expires === null || ban.expires === 'forever') return false
  const at = Date.parse(ban.expires.replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'))
  return !Number.isNaN(at) && at < now.getTime()
}

/** The rows of one of a server's access files; none where it is missing or can't be read. */
function listedIn(raw: Uint8Array | undefined): Listed[] {
  if (raw === undefined) return []
  try {
    const rows: unknown = JSON.parse(new TextDecoder().decode(raw))
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row: unknown) => {
      const { uuid, name, reason, expires } = (row ?? {}) as Record<string, unknown>
      if (typeof uuid !== 'string' || typeof name !== 'string' || !/^[0-9a-f-]{32,36}$/i.test(uuid)) return []
      return [
        {
          uuid: normalizeUuid(uuid).toLowerCase(),
          name,
          reason: typeof reason === 'string' ? reason : null,
          expires: typeof expires === 'string' ? expires : null,
        },
      ]
    })
  } catch {
    return []
  }
}

/**
 * Who its owner let in from the server a world came from, as access entries for the server it goes
 * to: each player chosen on its whitelist, those of them chosen as operators, and its bans unless
 * they said not to. A UUID that isn't one of its players is ignored.
 */
export function accessFrom(people: WorldPeopleJson, choice: PeopleChoice): SeededAccess {
  const everyone = new Map([...people.whitelist, ...people.operators].map((p) => [p.uuid, p]))
  const chosen = choice.letIn.flatMap((uuid) => everyone.get(uuid.toLowerCase()) ?? [])
  const operators = new Set(people.operators.map((p) => p.uuid))
  const entry = (
    list: AccessEntry['list'],
    player: WorldPersonJson,
    reason?: string | null,
  ): AccessEntry => ({
    list,
    player: { uuid: player.uuid, name: player.name },
    state: 'pending_add',
    origin: 'blockly',
    details: reason ? { reason } : {},
    error: null,
  })
  const madeOperators = new Set(choice.operators.map((uuid) => uuid.toLowerCase()))
  // A player let in who was also banned is let in: the owner said so.
  const letIn = new Set(chosen.map((player) => player.uuid))
  return {
    whitelistOn: choice.whitelistOn,
    entries: [
      ...chosen.map((player) => entry('whitelist', player)),
      ...chosen
        .filter((player) => operators.has(player.uuid) && madeOperators.has(player.uuid))
        .map((player) => entry('operator', player)),
      ...(choice.keepBans
        ? people.bans.filter((ban) => !letIn.has(ban.uuid)).map((ban) => entry('ban', ban, ban.reason))
        : []),
    ],
  }
}
