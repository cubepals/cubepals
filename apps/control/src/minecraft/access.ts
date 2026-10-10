// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AccessCommand, ObservedAccess, PlayerRef } from '../domain/access/access.ts'
import { normalizeUuid } from './console.ts'
import { DATA_DIR } from './jars.ts'

/**
 * How live administration reaches a running server: console commands out, the server's own
 * access files back in. Command names and file formats are known here and nowhere else.
 */

export function accessCommand(command: AccessCommand): string {
  switch (command.type) {
    case 'whitelist_mode':
      return `whitelist ${command.enabled ? 'on' : 'off'}`
    case 'whitelist_add':
      return `whitelist add ${command.player.name}`
    case 'whitelist_remove':
      return `whitelist remove ${command.player.name}`
    case 'op':
      return `op ${command.player.name}`
    case 'deop':
      return `deop ${command.player.name}`
    case 'ban':
      return command.reason
        ? `ban ${command.player.name} ${plain(command.reason)}`
        : `ban ${command.player.name}`
    case 'pardon':
      return `pardon ${command.player.name}`
    case 'pardon_ip':
      return `pardon-ip ${command.ip}`
    case 'whitelist_reload':
      return 'whitelist reload'
  }
}

const plain = (text: string) =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 120)

const FILES = ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'] as const
const PROPERTY_MARK = 'server.properties'

/** One exec that prints every access file between markers, plus the whitelist property. */
export const READ_ACCESS_FILES: readonly string[] = [
  'sh',
  '-c',
  [
    `cd ${DATA_DIR}`,
    `for f in ${FILES.join(' ')}; do printf '@@%s@@\\n' "$f"; cat "$f" 2>/dev/null || printf '[]'; printf '\\n'; done`,
    `printf '@@${PROPERTY_MARK}@@\\n'`,
    `grep -E '^(white-list|online-mode)=' server.properties 2>/dev/null || true`,
  ].join('; '),
]

export class AccessFilesUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessFilesUnreadable'
  }
}

function sections(stdout: string): Map<string, string> {
  const parts = new Map<string, string>()
  const pattern = /^@@(.+?)@@$/gm
  const marks = [...stdout.matchAll(pattern)]
  marks.forEach((mark, i) => {
    const start = (mark.index ?? 0) + mark[0].length
    const end = marks[i + 1]?.index ?? stdout.length
    parts.set(mark[1] ?? '', stdout.slice(start, end).trim())
  })
  return parts
}

function jsonArray(text: string | undefined, file: string): Record<string, unknown>[] {
  if (!text) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AccessFilesUnreadable(`${file} is not valid JSON`)
  }
  if (!Array.isArray(value)) throw new AccessFilesUnreadable(`${file} is not a list`)
  return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function player(entry: Record<string, unknown>): PlayerRef | null {
  const uuid = str(entry.uuid)
  if (uuid === null) return null
  return { uuid: normalizeUuid(uuid), name: str(entry.name) ?? '' }
}

export function parseAccessFiles(stdout: string): ObservedAccess {
  const parts = sections(stdout)
  if (!parts.has(PROPERTY_MARK)) throw new AccessFilesUnreadable('The access files could not be read')

  const whitelist = jsonArray(parts.get('whitelist.json'), 'whitelist.json').flatMap((e) => player(e) ?? [])
  const operators = jsonArray(parts.get('ops.json'), 'ops.json').flatMap((e) => {
    const p = player(e)
    if (p === null) return []
    return [
      {
        ...p,
        level: typeof e.level === 'number' ? e.level : 4,
        bypassesPlayerLimit: e.bypassesPlayerLimit === true,
      },
    ]
  })
  const bans = jsonArray(parts.get('banned-players.json'), 'banned-players.json').flatMap((e) => {
    const p = player(e)
    if (p === null) return []
    const expires = str(e.expires)
    return [
      {
        ...p,
        reason: str(e.reason),
        source: str(e.source),
        expiresAt: expires === 'forever' ? null : expires,
      },
    ]
  })
  const ipBans = jsonArray(parts.get('banned-ips.json'), 'banned-ips.json').flatMap((e) => {
    const ip = str(e.ip)
    return ip === null ? [] : [{ ip }]
  })
  const property = parts.get(PROPERTY_MARK) ?? ''
  return {
    // Minecraft's own default, where the property is missing, is to check accounts.
    onlineMode: !/online-mode=false/.test(property),
    whitelistEnabled: /white-list=true/.test(property),
    whitelist,
    operators,
    bans,
    ipBans,
  }
}

export interface AccessLists {
  whitelist: PlayerRef[]
  operators: Array<PlayerRef & { level: number; bypassesPlayerLimit: boolean }>
  bans: Array<PlayerRef & { reason: string | null; source: string | null; expiresAt: string | null }>
}

/**
 * The files for these lists, in the server's own format, indented as it indents them. A ban's
 * date is when it was written: the record doesn't keep one, and the server only shows it.
 */
export function accessFiles(lists: Partial<AccessLists>, now: Date): Partial<Record<AccessFile, string>> {
  const files: Partial<Record<AccessFile, string>> = {}
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  if (lists.whitelist)
    files['whitelist.json'] = json(lists.whitelist.map((p) => ({ uuid: p.uuid, name: p.name })))
  if (lists.operators)
    files['ops.json'] = json(
      lists.operators.map((p) => ({
        uuid: p.uuid,
        name: p.name,
        level: p.level,
        bypassesPlayerLimit: p.bypassesPlayerLimit,
      })),
    )
  if (lists.bans)
    files['banned-players.json'] = json(
      lists.bans.map((p) => ({
        uuid: p.uuid,
        name: p.name,
        created: `${now.toISOString().slice(0, 19).replace('T', ' ')} +0000`,
        source: p.source ?? 'Cubepals',
        expires: p.expiresAt ?? 'forever',
        reason: p.reason ?? 'Banned by an operator.',
      })),
    )
  return files
}

type AccessFile = 'whitelist.json' | 'ops.json' | 'banned-players.json'

/**
 * One exec that writes these files, and with `forgetNames` also the server's cache of which name
 * is which player. Each file is written into rather than replaced, and handed back to whoever owns
 * the data directory, so the server — which does not run as root — can go on saving it.
 *
 * The server reads the whitelist again when told to (`whitelist reload`); operators and bans only
 * as it starts, so those are written just before a restart. The name cache is forgotten after a
 * server changes whether it checks accounts: it would name each player the old way.
 */
export function writeAccessFiles(files: Partial<Record<AccessFile, string>>, forgetNames: boolean): string[] {
  // `ls -n` rather than `chown --reference`, which only GNU's chown has.
  const steps = [`cd ${DATA_DIR}`, `owner=$(ls -nd . | awk '{print $3":"$4}')`]
  const contents: string[] = []
  for (const name of ['whitelist.json', 'ops.json', 'banned-players.json'] as const) {
    const content = files[name]
    if (content === undefined) continue
    contents.push(content)
    steps.push(`printf '%s' "$${contents.length}" > ${name}`, `chown "$owner" ${name}`)
  }
  if (forgetNames) steps.push('rm -f usercache.json')
  return ['sh', '-c', steps.join(' && '), 'blockly-access', ...contents]
}
