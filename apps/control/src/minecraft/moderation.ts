// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about the plugins that moderate a Paper server, and the files Cubepals writes
 * for them: LibertyBans (AGPL-3.0) keeps warnings, mutes and bans, LuckPerms (MIT) gives helpers
 * the right to use them in game, and ChatSentinel (GPL-3.0) filters chat where the owner wants it.
 * Command names and file shapes are known here and nowhere else.
 *
 * Every player reaches a server from the edge's address (§15.1), so nothing here may punish an
 * address: an IP ban would lock everyone out. LibertyBans' address commands are not offered, every
 * player is denied the permission to use them through its full name, operators included, and the
 * plugin neither records addresses nor reads one punishment as reaching another account on it.
 *
 * Measured on Paper 1.21.11 with LibertyBans 1.1.4, LuckPerms 5.5.71 and ChatSentinel 2.0.3:
 * - LibertyBans takes a player's UUID as the target, so a command reaches exactly the player
 *   Blockly means on every kind of server; a name it hasn't met it resolves through Mojang, which on
 *   a server that doesn't check accounts is someone else.
 * - Its commands run apart from the console, so their reply never comes back over RCON.
 * - LuckPerms writes a user's file within two seconds of `lp user <uuid> parent add`.
 * - LibertyBans and LuckPerms fill whatever their settings file leaves out with their own defaults,
 *   so the carried files hold only what Cubepals changes. ChatSentinel doesn't.
 */

import type { PinnedMod } from '../domain/mods/artifact.ts'
import type { CarriedFile } from '../domain/revision/carried.ts'

/** Each plugin's project on Modrinth, as a pinned plugin records it. */
export const LIBERTYBANS = 'PgXAUxLZ'
export const LUCKPERMS = 'Vebnzrzj'
export const CHATSENTINEL = 'd1aRSTsI'

/** Whether a server's plugins include this Modrinth project. */
export const pinsProject = (mods: readonly PinnedMod[], projectId: string): boolean =>
  mods.some(
    (m) => m.source.catalog === 'modrinth' && 'projectId' in m.source && m.source.projectId === projectId,
  )

/** Whether a server runs the moderation tools: punishments, and helpers to give them in game. */
export const runsModeration = (mods: readonly PinnedMod[]): boolean =>
  pinsProject(mods, LIBERTYBANS) && pinsProject(mods, LUCKPERMS)

/** Whether a server filters what players write in chat. */
export const filtersChat = (mods: readonly PinnedMod[]): boolean => pinsProject(mods, CHATSENTINEL)

/** The folders the moderation plugins keep their settings in; the files under them are Cubepals'. */
const MODERATION_FOLDERS = ['plugins/LibertyBans/', 'plugins/LuckPerms/', 'plugins/ChatSentinel/'] as const

/** The LuckPerms group whose members are a server's helpers. */
export const HELPER_GROUP = 'helper'

/** Where LuckPerms keeps each player it holds anything for, one file each, named by their UUID. */
export const LUCKPERMS_USERS = 'plugins/LuckPerms/yaml-storage/users'

/** The helper group's file, which only the moderation tools carry. */
export const HELPER_GROUP_FILE = `plugins/LuckPerms/yaml-storage/groups/${HELPER_GROUP}.yml`

/** The line before each user file `READ_ACCESS_FILES` prints. */
export const USER_MARK = '==user=='

/**
 * The commands a helper may use: warn, mute, kick and ban players and take it back, see a player's
 * history and who is muted or banned, and hear of what other helpers, the chat filter and, where a
 * server runs it, the Grim anticheat see.
 */
const HELPER_PERMISSIONS = [
  'libertybans.commands',
  ...['ban', 'mute', 'warn', 'kick'].flatMap((kind) => [
    `libertybans.${kind}.do.target.uuid`,
    `libertybans.${kind}.do.notify`,
  ]),
  ...['ban', 'mute', 'warn'].flatMap((kind) => [
    `libertybans.${kind}.undo.target.uuid`,
    `libertybans.${kind}.undo.notify`,
  ]),
  ...['history', 'warns', 'banlist', 'mutelist'].map((list) => `libertybans.list.${list}`),
  'chatsentinel.notify',
  'grim.alerts',
  'grim.alerts.enable-on-join',
]

/** Punishing an address, which behind the edge is everyone's. Nobody may, operators included. */
const ADDRESS_PERMISSIONS = ['ban', 'mute', 'warn', 'kick'].flatMap((kind) =>
  ['do', 'undo'].flatMap((way) =>
    ['ip', 'both'].map((target) => `libertybans.${kind}.${way}.target.${target}`),
  ),
)

const yamlList = (items: readonly string[]) => items.map((item) => `- ${item}\n`).join('')

/**
 * LuckPerms keeps its data as files Blockly can read (`yaml-storage/`), and reads them again when
 * they change. The two groups are Cubepals': `default`, which everyone is in, holds the address
 * denials; `helper` holds what helpers may do.
 */
const LUCKPERMS_FILES: readonly CarriedFile[] = [
  {
    path: 'plugins/LuckPerms/config.yml',
    content:
      '# Written by Cubepals at every start: its data kept as files Cubepals reads.\nstorage-method: yaml\n',
  },
  {
    path: 'plugins/LuckPerms/yaml-storage/groups/default.yml',
    content: `# Written by Cubepals at every start: behind Cubepals' edge, an address is everyone's.\nname: default\npermissions:\n${ADDRESS_PERMISSIONS.map((node) => `- ${node}:\n    value: false\n`).join('')}`,
  },
  {
    path: HELPER_GROUP_FILE,
    content: `# Written by Cubepals at every start: what a server's helpers may do.\nname: ${HELPER_GROUP}\npermissions:\n${yamlList(HELPER_PERMISSIONS)}parents:\n- default\n`,
  },
]

/**
 * LibertyBans' own commands under their plain names, without the ones for addresses or for finding
 * accounts by address, which behind the edge would name everyone. It records no addresses, and a
 * punishment reaches the player it names and nobody who shares their address.
 */
const LIBERTYBANS_FILES: readonly CarriedFile[] = [
  {
    path: 'plugins/LibertyBans/config.yml',
    content: `# Written by Cubepals at every start: no punishment reaches an address.
enforcement:
  address-strictness: LENIENT
  alts-registry:
    should-register-on-connection: false
commands:
  aliases:
${['ban', 'mute', 'warn', 'kick', 'unban', 'unmute', 'unwarn', 'banlist', 'mutelist', 'history', 'warns']
  .map((alias) => `  - ${alias}\n`)
  .join('')}`,
  },
  {
    // A banned player is told how long and why, and not to appeal at a website and a Discord its
    // defaults name only as "website" and "discord". A notice that wasn't silent says nothing more.
    path: 'plugins/LibertyBans/lang/messages_en.yml',
    content: `# Written by Cubepals at every start: what a banned player reads.
additions:
  bans:
    layout:
      - '&7&lBanned&f'
      - '&cDuration: &e%TIME_REMAINING%&f'
      - ''
      - '&c&lReason&f'
      - '&7%REASON%'
formatting:
  silence:
    not-silent: ''
`,
  },
]

/**
 * The files the moderation tools carry, and the chat filter's settings where it is on. Those are
 * ChatSentinel's own file with Cubepals' changes (`app/moderation/chatsentinel-config.yml`): it
 * fails to start on a file that leaves a module's settings out. It blocks a message, never rewrites
 * it, so what is shown stays the player's own signed message (enforce-secure-profile).
 */
export function moderationFiles(chatFilter: string | null): CarriedFile[] {
  return [
    ...LIBERTYBANS_FILES,
    ...LUCKPERMS_FILES,
    ...(chatFilter === null ? [] : [{ path: 'plugins/ChatSentinel/config.yml', content: chatFilter }]),
  ]
}

/** Whether a carried file is one of the moderation plugins'. */
export const isModerationFile = (file: CarriedFile): boolean =>
  MODERATION_FOLDERS.some((folder) => file.path.startsWith(folder))

export type PunishmentKind = 'warn' | 'mute' | 'ban'

/** A reason as one line of plain text, as a command carries it. */
const plain = (text: string) =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 120)

/**
 * One punishment, for the player with this UUID. A mute or ban lasts `minutes`, or for good where
 * that is null; a warning just stands. An empty reason is LibertyBans' own ("No reason stated.").
 */
export function punishCommand(p: {
  kind: PunishmentKind
  playerUuid: string
  minutes: number | null
  reason: string
}): string {
  const reason = plain(p.reason)
  const length =
    p.kind === 'warn' ? [] : [p.minutes === null ? 'perm' : `${Math.max(1, Math.ceil(p.minutes))}m`]
  return ['libertybans', p.kind, p.playerUuid, ...length, ...(reason ? [reason] : [])].join(' ')
}

/**
 * The commands that give a punishment so that it holds. LibertyBans refuses a mute or ban while one
 * stands for the player, so that one is taken back first and the newest given is the one in force
 * (measured: an `unban` then a `ban` in one RCON session, three times over, left the new ban).
 */
export function giveCommands(p: Parameters<typeof punishCommand>[0]): string[] {
  return p.kind === 'warn' ? [punishCommand(p)] : [liftCommand(p.kind, p.playerUuid), punishCommand(p)]
}

/** Takes back a player's mute or ban. A warning is taken back by its number, which Blockly never learns. */
export const liftCommand = (kind: Exclude<PunishmentKind, 'warn'>, playerUuid: string): string =>
  `libertybans ${kind === 'mute' ? 'unmute' : 'unban'} ${playerUuid}`

/** Who is a helper, by their UUID: LuckPerms names a player it has never seen by it too. */
export const helperCommand = (playerUuid: string, helper: boolean): string =>
  `lp user ${playerUuid} parent ${helper ? 'add' : 'remove'} ${HELPER_GROUP}`

/**
 * The helpers in LuckPerms' user files, as `READ_ACCESS_FILES` prints them: each file's text after
 * a `USER_MARK` line. A user file holds `uuid:`, `name:` and a `parents:` list.
 */
export function parseHelpers(text: string): Array<{ uuid: string; name: string }> {
  const helpers: Array<{ uuid: string; name: string }> = []
  for (const file of text.split(USER_MARK)) {
    const uuid = /^uuid:\s*'?([0-9a-fA-F-]{36})'?\s*$/m.exec(file)?.[1]
    const name = /^name:\s*'?([^'\n]*)'?\s*$/m.exec(file)?.[1]
    const parents = /^parents:\s*\n((?:\s*-\s*.+\n?)*)/m.exec(file)?.[1] ?? ''
    const isHelper = parents
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*-\s*/, '')
          .replace(/['"]/g, '')
          .trim(),
      )
      .includes(HELPER_GROUP)
    if (uuid && isHelper)
      helpers.push({ uuid: uuid.toLowerCase(), name: name && name !== 'null' ? name : '' })
  }
  return helpers
}
