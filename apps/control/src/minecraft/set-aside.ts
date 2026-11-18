// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Files set aside, a copy kept: a start that stopped because its own output named a file (a
 * datapack Minecraft can't read, a second copy of a mod) has that file moved out of the way before
 * the next start, into `.blockly-set-aside/` on the same volume, and moved back when its owner asks.
 * Blockly says what it did on the server's page (`app/servers/set-aside.ts`).
 *
 * A path here came out of a log, which anything running on the server can write, so it is never
 * trusted: `asideOf` takes only a path under the server's `mods/` or the world's `datapacks/`, of
 * plain names, never `..`, never hidden, and the step checks each line again before it moves
 * anything. Every path it moves through has its links replaced first (`volume-links.ts`).
 *
 * Not which failures name a file (`diagnosis.ts`), nor which of the named files Blockly placed
 * itself and so must not move (`app/servers/set-aside.ts`).
 */

import { DATA_DIR } from './jars.ts'

/** A file a failure named: under the server's data, or under the world it runs where `inWorld`. */
export interface Aside {
  path: string
  inWorld: boolean
}

/** Where the copies are kept, under the server's data. */
const ASIDE_DIR = '.blockly-set-aside'

/** The variable the step reads: one line per file, `aside|back world|server <path>`. */
export const SET_ASIDE_VARIABLE = 'BLOCKLY_SET_ASIDE'

/** One part of a path: a plain name that isn't hidden, so never `.`, `..` or one of Blockly's own. */
const PART = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/**
 * The file a log named, where it is one a fix may move: a mod jar under the server's `mods/` (given
 * as `/data/mods/…`, `mods/…` or a bare file name, which loaders print for a jar in `mods/`), or a
 * datapack in the world's `datapacks/`. Null for anything else.
 */
export function asideOf(named: string, inWorld: boolean): Aside | null {
  const path = inWorld
    ? named
    : named.startsWith(`${DATA_DIR}/`)
      ? named.slice(DATA_DIR.length + 1)
      : named.includes('/')
        ? named
        : `mods/${named}`
  const parts = path.split('/')
  if (!parts.every((part) => PART.test(part)) || named.includes('..')) return null
  if (inWorld) return parts.length === 2 && parts[0] === 'datapacks' ? { path, inWorld } : null
  return parts[0] === 'mods' && parts.length >= 2 && /\.jar$/i.test(path) ? { path, inWorld } : null
}

/** A file set aside as a start is told of it: in the world it was set aside from, where it is in one. */
export interface SetAsideFile extends Aside {
  back: boolean
  worldId?: string
}

/**
 * The variable for a start of `worldId`: each file to keep aside, and each its owner asked back. A
 * datapack set aside from one world is never looked for in another the server runs now.
 */
export function setAsideEnv(files: readonly SetAsideFile[], worldId: string): Record<string, string> {
  const lines = files
    .filter(
      (file) => asideOf(file.path, file.inWorld) !== null && (!file.inWorld || file.worldId === worldId),
    )
    .map((file) => `${file.back ? 'back' : 'aside'} ${file.inWorld ? 'world' : 'server'} ${file.path}`)
  return lines.length === 0 ? {} : { [SET_ASIDE_VARIABLE]: lines.join('\n') }
}

/** The files a start's variable asks back, each checked again. */
export function askedBack(env: Readonly<Record<string, string>>): Aside[] {
  return (env[SET_ASIDE_VARIABLE] ?? '').split('\n').flatMap((line) => {
    const [how, where, path] = line.split(' ')
    const file = how === 'back' && path !== undefined ? asideOf(path, where === 'world') : null
    return file === null ? [] : [file]
  })
}

/**
 * A command that prints, of `files`, each still kept aside (`world <path>` or `server <path>`): one
 * the step couldn't put back because something new took its place. `level` is the world's folder.
 */
export function stillKept(files: readonly Aside[], level: string): string[] {
  const tests = files
    .filter(() => PART.test(level))
    .map((file) => {
      const rel = file.inWorld ? `${level}/${file.path}` : file.path
      return `[ -e '${DATA_DIR}/${ASIDE_DIR}/${rel}' ] && echo '${file.inWorld ? 'world' : 'server'} ${file.path}';`
    })
  return ['sh', '-c', `${tests.join(' ')} true`]
}

/**
 * The step: each `aside` file still where it was is moved into the kept folder, unless a copy of
 * that path is kept there already: one a put back couldn't return, because something new took its
 * place, is the owner's to get back, and is never overwritten. Each `back` file is moved back where
 * nothing has taken its place.
 * A line that isn't one `setAsideEnv` writes is passed over. It runs as root, after Blockly's own
 * steps have placed what they place, and before the image starts.
 */
export const SET_ASIDE_STEP = [
  `printf '%s\\n' "$${SET_ASIDE_VARIABLE}" | while read -r how where p; do`,
  `case "$p" in ''|/*|*..*|.*|*/.*|*[!A-Za-z0-9._+/-]*) continue;; esac;`,
  'case "$where" in world) rel="$LEVEL/$p";; server) rel="$p";; *) continue;; esac;',
  `kept="${ASIDE_DIR}/$rel"; unlinked "$rel"; unlinked "$kept";`,
  `if [ "$how" = aside ] && [ -e "${DATA_DIR}/$rel" ] && [ ! -e "${DATA_DIR}/$kept" ]; then`,
  `mkdir -p "$(dirname "${DATA_DIR}/$kept")"; mv -T "${DATA_DIR}/$rel" "${DATA_DIR}/$kept" && echo "[cubepals] Set aside $rel" >&2;`,
  `elif [ "$how" = back ] && [ -e "${DATA_DIR}/$kept" ] && [ ! -e "${DATA_DIR}/$rel" ]; then`,
  `mkdir -p "$(dirname "${DATA_DIR}/$rel")"; mv -T "${DATA_DIR}/$kept" "${DATA_DIR}/$rel" && echo "[cubepals] Put back $rel" >&2; fi;`,
  'done;',
].join(' ')
