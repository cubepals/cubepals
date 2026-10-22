// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AccessCommand,
  type AccessEntry,
  type AccessList,
  type AccessRecord,
  type EntryDetails,
  entryKey,
  type ObservedAccess,
  type PlayerRef,
} from './access.ts'

interface ObservedEntry {
  list: AccessList
  player: PlayerRef
  details: EntryDetails
}

function observedEntries(observed: ObservedAccess): ObservedEntry[] {
  return [
    ...observed.whitelist.map((player) => ({ list: 'whitelist' as const, player, details: {} })),
    ...observed.operators.map(({ level, bypassesPlayerLimit, ...player }) => ({
      list: 'operator' as const,
      player,
      details: { level, bypassesPlayerLimit },
    })),
    ...observed.bans.map(({ reason, source, expiresAt, ...player }) => ({
      list: 'ban' as const,
      player,
      details: {
        ...(reason === null ? {} : { reason }),
        ...(source === null ? {} : { source }),
        ...(expiresAt === null ? {} : { expiresAt }),
      },
    })),
    ...(observed.helpers ?? []).map((player) => ({ list: 'helper' as const, player, details: {} })),
    ...(observed.unchecked ?? []).map((player) => ({ list: 'unchecked' as const, player, details: {} })),
  ]
}

/** An entry the server can't show: a helper or an unchecked player where LuckPerms doesn't run. */
const unseen = (entry: AccessEntry, observed: ObservedAccess) =>
  (entry.list === 'helper' && observed.helpers === null) ||
  (entry.list === 'unchecked' && observed.unchecked === null)

/**
 * The player as the files name them, or by the record's name where they name nobody: LuckPerms
 * keeps no name for a helper who hasn't joined yet.
 */
const seenAs = (found: ObservedEntry, entry: AccessEntry): PlayerRef =>
  found.player.name === '' ? { ...found.player, name: entry.player.name } : found.player

const isPending = (e: AccessEntry) => e.state === 'pending_add' || e.state === 'pending_remove'

/**
 * Folds in-game changes into the record. Entries Blockly is still delivering are left alone;
 * everything else follows the files, because an in-game operator is a legitimate writer.
 */
export function importObserved(record: AccessRecord, observed: ObservedAccess): AccessRecord {
  const seen = new Map(observedEntries(observed).map((o) => [entryKey(o.list, o.player.uuid), o]))
  const entries: AccessEntry[] = []

  for (const entry of record.entries) {
    const key = entryKey(entry.list, entry.player.uuid)
    const found = seen.get(key)
    seen.delete(key)
    if (isPending(entry) || unseen(entry, observed)) {
      entries.push(entry)
    } else if (found) {
      entries.push({
        ...entry,
        state: 'active',
        player: seenAs(found, entry),
        details: found.details,
        error: null,
      })
    } else if (entry.state === 'rejected') {
      entries.push(entry)
    }
    // An active entry missing from the files was removed in game: drop it.
  }
  for (const found of seen.values()) {
    entries.push({ ...found, state: 'active', origin: 'game', error: null })
  }

  return {
    ...record,
    whitelistEnabled:
      record.whitelistEnabledPending === null ? observed.whitelistEnabled : record.whitelistEnabled,
    entries,
  }
}

interface Target {
  whitelistEnabled: boolean
  entries: Map<string, AccessEntry>
}

/** Where the server should end up: everything Blockly holds, minus what it is removing. */
function targetOf(record: AccessRecord): Target {
  const entries = new Map<string, AccessEntry>()
  for (const entry of record.entries) {
    if (entry.state === 'active' || entry.state === 'pending_add')
      entries.set(entryKey(entry.list, entry.player.uuid), entry)
  }
  return { whitelistEnabled: record.whitelistEnabledPending ?? record.whitelistEnabled, entries }
}

/**
 * The commands that move the observed operators, bans and whitelist switch to the target. Who is
 * on the whitelist is not among them: `whitelistToWrite` writes that list whole, before these run,
 * so turning the whitelist on never kicks someone who is being added.
 */
export function planDelivery(observed: ObservedAccess, record: AccessRecord): AccessCommand[] {
  const target = targetOf(record)
  const current = new Map(observedEntries(observed).map((o) => [entryKey(o.list, o.player.uuid), o]))
  const add = (list: AccessList) =>
    [...target.entries.values()].filter((e) => e.list === list && !current.has(entryKey(list, e.player.uuid)))
  const remove = (list: AccessList) =>
    [...current.values()].filter((o) => o.list === list && !target.entries.has(entryKey(list, o.player.uuid)))

  const commands: AccessCommand[] = [
    ...add('operator').map((e) => ({ type: 'op' as const, player: e.player })),
    ...remove('ban').map((o) => ({ type: 'pardon' as const, player: o.player })),
    // A ban turns out a player who is on with no reason given; the kick before it gives them one.
    ...add('ban').flatMap((e): AccessCommand[] => {
      const reason = e.details.reason ?? null
      const ban = { type: 'ban' as const, player: e.player, reason }
      return reason === null ? [ban] : [{ type: 'kick', player: e.player, reason }, ban]
    }),
    ...remove('operator').map((o) => ({ type: 'deop' as const, player: o.player })),
    ...observed.ipBans.map((b) => ({ type: 'pardon_ip' as const, ip: b.ip })),
    ...(observed.helpers === null
      ? []
      : [
          ...add('helper').map((e) => ({ type: 'helper_add' as const, player: e.player })),
          ...remove('helper').map((o) => ({ type: 'helper_remove' as const, player: o.player })),
        ]),
    ...(observed.unchecked === null
      ? []
      : [
          ...add('unchecked').map((e) => ({ type: 'unchecked_add' as const, player: e.player })),
          ...remove('unchecked').map((o) => ({ type: 'unchecked_remove' as const, player: o.player })),
        ]),
  ]
  if (observed.whitelistEnabled !== target.whitelistEnabled) {
    commands.push({ type: 'whitelist_mode', enabled: target.whitelistEnabled })
  }
  return commands
}

/**
 * The whitelist to write, where it differs from the file: every player Blockly holds on it, as
 * this server knows them. A server resolves a name given to `whitelist add` itself, and one that
 * doesn't check accounts resolves it to a different player than the one who joins with it
 * (§15.1), so the list is written whole and reloaded instead. Null when the file already says this.
 */
export function whitelistToWrite(observed: ObservedAccess, record: AccessRecord): PlayerRef[] | null {
  const target = [...targetOf(record).entries.values()]
    .filter((e) => e.list === 'whitelist')
    .map((e) => e.player)
  const have = new Set(observed.whitelist.map((p) => p.uuid.toLowerCase()))
  const same =
    target.length === observed.whitelist.length && target.every((p) => have.has(p.uuid.toLowerCase()))
  return same ? null : target
}

/**
 * The operators and bans to write where the files hold anyone else, for a server that has to
 * read them as it starts: the console names players the server's own way, which on a server that
 * doesn't check accounts, or one that just changed, is not the way Blockly holds them, and it can't
 * name a Bedrock player it hasn't met. Null when the files already match.
 */
export function operatorsAndBansToWrite(
  observed: ObservedAccess,
  record: AccessRecord,
): Pick<ObservedAccess, 'operators' | 'bans'> | null {
  const target = [...targetOf(record).entries.values()].filter(
    (e) => e.list === 'operator' || e.list === 'ban',
  )
  const want = target.map((e) => entryKey(e.list, e.player.uuid)).sort()
  const have = [
    ...observed.operators.map((p) => entryKey('operator', p.uuid)),
    ...observed.bans.map((p) => entryKey('ban', p.uuid)),
  ].sort()
  if (want.length === have.length && want.every((key, i) => key === have[i])) return null
  return {
    operators: target
      .filter((e) => e.list === 'operator')
      .map((e) => ({
        ...e.player,
        level: e.details.level ?? 4,
        bypassesPlayerLimit: e.details.bypassesPlayerLimit ?? false,
      })),
    bans: target
      .filter((e) => e.list === 'ban')
      .map((e) => ({
        ...e.player,
        reason: e.details.reason ?? null,
        source: e.details.source ?? null,
        expiresAt: e.details.expiresAt ?? null,
      })),
  }
}

/** The lists the console names players for in its own way, which a server that doesn't check accounts gets wrong. */
const NAMED_BY_CONSOLE: ReadonlySet<AccessList> = new Set(['operator', 'ban'])

/** What an operator or ban that can't land yet says, after "Not applied yet —". */
export const WAITS_FOR_JOIN = 'it takes effect when they next join.'
/** What a pardon that can't land yet says: a banned player can't join to be named. */
export const WAITS_FOR_START = 'it takes effect when the server next starts.'

export interface Settlement {
  record: AccessRecord
  /**
   * Commands that undo a side effect Blockly did not intend: a name that resolved to a different
   * account on the server (the name changed hands between lookup and delivery).
   */
  undo: AccessCommand[]
}

/**
 * Judges each pending entry against the files as they are after delivery. The files decide,
 * not the command output, whose wording changes between Minecraft versions. `metFirst` says which
 * players the console can name only once the server has met them, on any server: a Bedrock player,
 * whom the server's name lookup finds only in its cache of players who have joined.
 */
export function settle(
  record: AccessRecord,
  before: ObservedAccess,
  after: ObservedAccess,
  failures: ReadonlyMap<string, string>,
  metFirst: (player: PlayerRef) => boolean,
): Settlement {
  const present = new Map(observedEntries(after).map((o) => [entryKey(o.list, o.player.uuid), o]))
  const existedBefore = new Set(observedEntries(before).map((o) => entryKey(o.list, o.player.uuid)))
  const undo: AccessCommand[] = []

  // What the files can't show is left as it is.
  const entries: AccessEntry[] = record.entries.filter((entry) => unseen(entry, after))
  for (const entry of record.entries.filter((e) => !unseen(e, after))) {
    const key = entryKey(entry.list, entry.player.uuid)
    const failure = failures.get(key) ?? null
    const found = present.get(key)
    const waits = waitsToBeNamed(entry, after, metFirst)

    if (entry.state === 'pending_add') {
      if (found) {
        entries.push({
          ...entry,
          state: 'active',
          player: seenAs(found, entry),
          details: found.details,
          error: null,
        })
        continue
      }
      const impostor = [...present.values()].find(
        (o) =>
          o.list === entry.list &&
          o.player.name.toLowerCase() === entry.player.name.toLowerCase() &&
          !existedBefore.has(entryKey(o.list, o.player.uuid)),
      )
      if (impostor) {
        undo.push(reverse(impostor))
        present.delete(entryKey(impostor.list, impostor.player.uuid))
      }
      if (waits) {
        entries.push({ ...entry, error: failure ?? WAITS_FOR_JOIN })
      } else if (impostor) {
        entries.push({ ...entry, state: 'rejected', error: 'That name now belongs to a different player.' })
      } else if (failure) {
        entries.push({ ...entry, error: failure })
      } else {
        entries.push({ ...entry, state: 'rejected', error: 'The server did not accept this change.' })
      }
    } else if (entry.state === 'pending_remove') {
      if (found)
        entries.push({
          ...entry,
          error: failure ?? (waits ? pardonWaits(entry) : 'The server did not accept this change.'),
        })
      // Gone from the files: the removal landed and the entry leaves the record.
    } else {
      entries.push(found ? { ...entry, player: seenAs(found, entry), details: found.details } : entry)
    }
  }

  const pending = record.whitelistEnabledPending
  const whitelistLanded = pending !== null && after.whitelistEnabled === pending
  return {
    record: {
      ...record,
      whitelistEnabled: whitelistLanded ? pending : after.whitelistEnabled,
      whitelistEnabledPending: whitelistLanded ? null : pending,
      reseedRequired: false,
      entries,
    },
    undo,
  }
}

/**
 * Whether the console can't name this entry's player yet. On a server that doesn't check accounts,
 * it names a player it hasn't met the way an account would be named, so an operator or ban for them
 * lands under someone else; a `metFirst` player it can't name at all. Once they have joined, the
 * server knows the name as theirs; until then the change waits. A helper is named by their UUID,
 * which is exact on every server.
 */
const waitsToBeNamed = (
  entry: AccessEntry,
  after: ObservedAccess,
  metFirst: (player: PlayerRef) => boolean,
) => NAMED_BY_CONSOLE.has(entry.list) && (!after.onlineMode || metFirst(entry.player))

/** What a removal that waits says: a banned player can't join to be named, so a pardon waits for a start. */
const pardonWaits = (entry: AccessEntry) => (entry.list === 'ban' ? WAITS_FOR_START : WAITS_FOR_JOIN)

function reverse(entry: ObservedEntry): AccessCommand {
  switch (entry.list) {
    case 'whitelist':
      return { type: 'whitelist_remove', player: entry.player }
    case 'operator':
      return { type: 'deop', player: entry.player }
    case 'ban':
      return { type: 'pardon', player: entry.player }
    case 'helper':
      return { type: 'helper_remove', player: entry.player }
    case 'unchecked':
      return { type: 'unchecked_remove', player: entry.player }
  }
}

/** The key a delivery failure is filed under, so settle can attribute it to its entry. */
export function commandKey(command: AccessCommand): string | null {
  switch (command.type) {
    case 'whitelist_add':
    case 'whitelist_remove':
      return entryKey('whitelist', command.player.uuid)
    case 'op':
    case 'deop':
      return entryKey('operator', command.player.uuid)
    case 'ban':
    case 'pardon':
      return entryKey('ban', command.player.uuid)
    case 'helper_add':
    case 'helper_remove':
      return entryKey('helper', command.player.uuid)
    case 'unchecked_add':
    case 'unchecked_remove':
      return entryKey('unchecked', command.player.uuid)
    case 'whitelist_mode':
    case 'pardon_ip':
    case 'whitelist_reload':
    // A kick changes no list: the ban after it decides.
    case 'kick':
      return null
  }
}
