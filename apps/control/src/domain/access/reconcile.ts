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
  ]
}

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
    if (isPending(entry)) {
      entries.push(entry)
    } else if (found) {
      entries.push({ ...entry, state: 'active', player: found.player, details: found.details, error: null })
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
export function targetOf(record: AccessRecord): Target {
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
    ...add('ban').map((e) => ({ type: 'ban' as const, player: e.player, reason: e.details.reason ?? null })),
    ...remove('operator').map((o) => ({ type: 'deop' as const, player: o.player })),
    ...observed.ipBans.map((b) => ({ type: 'pardon_ip' as const, ip: b.ip })),
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
 * doesn't check accounts, or one that just changed, is not the way Blockly holds them. Null when
 * the files already match.
 */
export function operatorsAndBansToWrite(
  observed: ObservedAccess,
  record: AccessRecord,
): Pick<ObservedAccess, 'operators' | 'bans'> | null {
  const target = [...targetOf(record).entries.values()].filter((e) => e.list !== 'whitelist')
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

/** What an operator or ban that can't land yet says, after "Not applied yet —". */
export const WAITS_FOR_JOIN = 'it takes effect when they next join.'

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
 * not the command output, whose wording changes between Minecraft versions.
 */
export function settle(
  record: AccessRecord,
  before: ObservedAccess,
  after: ObservedAccess,
  failures: ReadonlyMap<string, string>,
): Settlement {
  const present = new Map(observedEntries(after).map((o) => [entryKey(o.list, o.player.uuid), o]))
  const existedBefore = new Set(observedEntries(before).map((o) => entryKey(o.list, o.player.uuid)))
  const undo: AccessCommand[] = []
  const entries: AccessEntry[] = []

  for (const entry of record.entries) {
    const key = entryKey(entry.list, entry.player.uuid)
    const failure = failures.get(key) ?? null
    const found = present.get(key)
    // On a server that doesn't check accounts, the console names a player it hasn't met the way
    // an account would be named, so an operator or ban for them lands under someone else. Once
    // they have joined, the server knows the name as theirs; until then the change waits.
    const waits = !after.onlineMode && entry.list !== 'whitelist'

    if (entry.state === 'pending_add') {
      if (found) {
        entries.push({ ...entry, state: 'active', player: found.player, details: found.details, error: null })
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
          error: failure ?? (waits ? WAITS_FOR_JOIN : 'The server did not accept this change.'),
        })
      // Gone from the files: the removal landed and the entry leaves the record.
    } else {
      entries.push(found ? { ...entry, player: found.player, details: found.details } : entry)
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

function reverse(entry: ObservedEntry): AccessCommand {
  switch (entry.list) {
    case 'whitelist':
      return { type: 'whitelist_remove', player: entry.player }
    case 'operator':
      return { type: 'deop', player: entry.player }
    case 'ban':
      return { type: 'pardon', player: entry.player }
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
    case 'whitelist_mode':
    case 'pardon_ip':
    case 'whitelist_reload':
      return null
  }
}
