// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about Grim (GPL-3.0-or-later), the anticheat Stop cheaters runs, and the step
 * of a start that writes its punishments file. Grim undoes a move the game can't make on its own;
 * what happens after that, an alert, a removal through the reporter's `cubepals-remove`, is its
 * `plugins/GrimAC/punishments.yml`, which Cubepals writes from private configuration
 * (`STOP_CHEATERS`) or, without it, the public default here: alerts and logs, and nothing more.
 *
 * The file is the owner's where they made it their own: a file Cubepals didn't write, whose
 * commands are more than Grim's own actions, is left as it is, and the start says so (`own`). A file
 * Cubepals replaces that it didn't write is kept beside it as `.before-cubepals`, and put back when
 * Stop cheaters goes off. One already kept is never written over: the newer is kept as
 * `.before-cubepals.<seconds since 1970>` instead, so nothing an owner wrote is lost.
 *
 * Not for which servers run it or the jar: that is `app/stop-cheaters/` and `app/compat/`.
 */

import type { PinnedMod } from '../domain/mods/artifact.ts'
import { DATA_DIR } from './jars.ts'
import { USER_MARK } from './moderation.ts'

/** Grim Anticheat on Modrinth. */
export const GRIM = 'LJNGWSvH'

/** The name Grim's own `plugin.yml` gives it, as an uploaded jar's pin carries it. */
const GRIM_PLUGIN = 'grimac'

/** Whether the owner runs Grim as their own plugin: pinned from the catalog, or an upload of it. */
export const runsOwnGrim = (mods: readonly PinnedMod[]): boolean =>
  mods.some(
    (mod) =>
      ('projectId' in mod.source && mod.source.projectId === GRIM) ||
      mod.name.toLowerCase().replace(/\s+/g, '') === GRIM_PLUGIN,
  )

export const PUNISHMENTS_FILE = 'plugins/GrimAC/punishments.yml'
/** Where the owner's file goes while Cubepals' is in its place. */
const KEPT_FILE = `${PUNISHMENTS_FILE}.before-cubepals`
/** Where the volume remembers whether the last start wrote Cubepals' file or left the owner's. */
const MARK = '.blockly-stop-cheaters'

/** The first line of every file Cubepals writes, which is how a later start knows it as Cubepals'. */
const WRITTEN_BY_CUBEPALS = '# Written by Cubepals'

/** Grim's own actions: a punishments file of only these punishes nobody. */
const BUILT_IN_ACTIONS = ['alert', 'log', 'webhook', 'proxy'] as const

/** A group of Grim's checks with what its violations bring: here, an alert and a log line. */
const group = (name: string, checks: readonly string[], every: number) =>
  [
    `  ${name}:`,
    '    remove-violations-after: 300',
    '    checks:',
    ...checks.map((check) => `      - "${check}"`),
    '    commands:',
    `      - "${every}:${every} [alert]"`,
    `      - "${every}:${every} [log]"`,
  ].join('\n')

/**
 * The public default: Grim's own groups of checks, telling helpers and keeping a log, and never
 * removing or banning anyone.
 */
export const DEFAULT_PUNISHMENTS = `${WRITTEN_BY_CUBEPALS} at every start while Stop cheaters is on.
# Alerts and logs only: nobody is removed or banned.
Punishments:
${[
  group('Simulation', ['Simulation', 'GroundSpoof', 'Timer', 'TimerLimit', 'NoFall'], 100),
  group('Knockback', ['Knockback', 'Explosion'], 5),
  group('Post', ['Post'], 20),
  group('BadPackets', ['BadPackets', 'PacketOrder', 'Crash'], 20),
  group('Reach', ['Reach'], 5),
  group('Combat', ['Killaura', 'Aim'], 20),
  group('Autoclicker', ['Autoclicker'], 20),
  group(
    'Misc',
    ['Vehicle', 'Sprint', 'Place', 'Baritone', 'FastBreak', 'TransactionOrder', 'Elytra', 'Chat', 'Exploit'],
    10,
  ),
].join('\n')}
`

/** A file as Cubepals writes it: with its first line, so the next start knows it as Cubepals'. */
const asWritten = (punishments: string): string =>
  punishments.startsWith(WRITTEN_BY_CUBEPALS)
    ? punishments
    : `${WRITTEN_BY_CUBEPALS} at every start while Stop cheaters is on.\n${punishments}`

/** The file's text in base64; set only while Stop cheaters is on. */
export const STOP_CHEATERS_ENV = 'BLOCKLY_STOP_CHEATERS'
/** Set once, after "Use Cubepals' settings": the owner's own file makes way too. */
const STOP_CHEATERS_OURS_ENV = 'BLOCKLY_STOP_CHEATERS_OURS'

/** The variables the step reads: the file where Stop cheaters is on, and whether to take over the owner's. */
export function stopCheatersEnv(
  placed: { punishments: string; takeOver: boolean } | null,
): Record<string, string> {
  if (placed === null) return {}
  return {
    [STOP_CHEATERS_ENV]: Buffer.from(asWritten(placed.punishments), 'utf8').toString('base64'),
    ...(placed.takeOver ? { [STOP_CHEATERS_OURS_ENV]: 'TRUE' } : {}),
  }
}

const COMMAND_LINE = `^[[:space:]]*-[[:space:]]*["']?[0-9]+:[0-9]+[[:space:]]`
const BUILT_IN_LINE = `[0-9]+:[0-9]+[[:space:]]+\\[(${BUILT_IN_ACTIONS.join('|')})\\]`

/**
 * The step, on a server that can run Grim. On: a file Cubepals wrote, none, or one whose commands
 * are all Grim's own actions is replaced (kept first as `.before-cubepals` where it isn't Cubepals',
 * or under a timestamped name where one is kept already), and `own` is marked for any other, one
 * with no command lines it can read included. Off, where a start marked it on: Cubepals' file goes
 * and the kept one comes back. Runs as root, so what it writes is handed to the volume's owner,
 * and it replaces any link on the way (`volume-links.ts`).
 */
export const STOP_CHEATERS_STEP = [
  `unlinked ${PUNISHMENTS_FILE}; unlinked ${KEPT_FILE}; unlinked ${MARK};`,
  `p=${DATA_DIR}/${PUNISHMENTS_FILE}; k=${DATA_DIR}/${KEPT_FILE}; m=${DATA_DIR}/${MARK};`,
  `ours() { head -n 1 "$p" 2>/dev/null | grep -q '^${WRITTEN_BY_CUBEPALS}'; };`,
  `cmds() { grep -E '${COMMAND_LINE.replaceAll("'", `'"'"'`)}' "$p"; };`,
  `builtin() { cmds >/dev/null && ! cmds | grep -Evq '${BUILT_IN_LINE}'; };`,
  `if [ -n "$${STOP_CHEATERS_ENV}" ]; then`,
  `if [ -f "$p" ] && ! ours && ! builtin && [ "$${STOP_CHEATERS_OURS_ENV}" != TRUE ]; then echo own > "$m";`,
  `else mkdir -p "$(dirname "$p")" && { [ ! -f "$p" ] || ours || { if [ -e "$k" ]; then mv -fT "$p" "$k.$(date +%s)";`,
  `else mv -fT "$p" "$k"; fi; }; }`,
  `&& printf %s "$${STOP_CHEATERS_ENV}" | base64 -d > "$p" && echo ours > "$m"`,
  `&& chown -h "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" "$(dirname "$p")" "$p" || exit 1; fi;`,
  `elif [ -f "$m" ]; then if ours; then rm -f "$p"; if [ -f "$k" ]; then mv -fT "$k" "$p"; fi; fi; rm -f "$m"; fi;`,
].join(' ')

/** What a start's mark says it did, as the access sync reads it back. */
export const readStopCheatersMark = (text: string | undefined): 'ours' | 'own' | null =>
  text?.trim() === 'own' ? 'own' : text?.trim() === 'ours' ? 'ours' : null

/** The shell that prints the mark, for the access sync's one exec. */
export const PRINT_MARK = `cat ${MARK} 2>/dev/null || true`

/** Grim leaves a player with this permission unchecked; a server's owner gives it through LuckPerms. */
export const EXEMPT = 'grim.exempt'

/** Gives a player Grim's exemption, by their UUID, or takes it back. */
export const uncheckedCommand = (playerUuid: string, unchecked: boolean): string =>
  unchecked
    ? `lp user ${playerUuid} permission set ${EXEMPT} true`
    : `lp user ${playerUuid} permission unset ${EXEMPT}`

/**
 * The players LuckPerms' user files give Grim's exemption, as the access sync prints them: each
 * file's text after a `USER_MARK` line. A permission set true is listed by its name, or by its name
 * with `value: true` under it.
 */
export function parseUnchecked(text: string): Array<{ uuid: string; name: string }> {
  const unchecked: Array<{ uuid: string; name: string }> = []
  const given = new RegExp(
    `^\\s*-\\s*'?${EXEMPT.replace('.', '\\.')}'?\\s*(:\\s*\\n\\s*value:\\s*true)?\\s*$`,
    'm',
  )
  for (const file of text.split(USER_MARK)) {
    const uuid = /^uuid:\s*'?([0-9a-fA-F-]{36})'?\s*$/m.exec(file)?.[1]
    const name = /^name:\s*'?([^'\n]*)'?\s*$/m.exec(file)?.[1]
    if (uuid && given.test(file))
      unchecked.push({ uuid: uuid.toLowerCase(), name: name && name !== 'null' ? name : '' })
  }
  return unchecked
}
