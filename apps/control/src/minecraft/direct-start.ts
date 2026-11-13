// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A boot that changed nothing starts the server at once. The image's scripts work out, at every
 * start, the command the server runs with: which jar, which Java flags. They get there through a
 * dozen steps that each start a JVM of their own or ask the network (the loader's launcher, the
 * jars already on the volume, `server.properties`), and where nothing they read has changed since
 * the last boot, they arrive at the same command. Measured on a Fabric 26.3 server with eleven
 * mods, one CPU: Java started 11 s after the container with the scripts and 1.7 s after it
 * without them.
 *
 * So the scripts' last call, the one that runs the server, goes through a stand-in
 * (`SERVER_RUNNER`, which the image reads) that writes down the command, the directory and the
 * variables the scripts added to its environment, with a key for everything the scripts decide
 * by: this entrypoint's whole environment as Blockly's own steps left it, and the scripts
 * themselves. A later boot that comes to the same key runs what was written down. Anything else,
 * a changed setting, a new jar list, a new icon, another image, comes to another key and goes
 * through the scripts, which write it down afresh.
 *
 * The variables matter as much as the command: the image's runner stops the server over RCON with
 * a password the scripts export where the entrypoint was given none, and a server started without
 * it isn't stopped but killed when its time is up, its world unsaved. A value that runs over
 * several lines can't be written down a line each, so a boot whose scripts added one is not
 * written down at all.
 *
 * The record is on the volume, which the server and whatever its owner installed on it can write.
 * So nothing in it is read as root: this entrypoint, which is root, only asks, as the user the
 * volume belongs to, whether the record is good, and hands over to that user to run it. A record
 * someone rewrote runs what they wrote as the user they already are; it never chooses the user,
 * and root never runs a word or takes a variable from it. A volume that belongs to root is left
 * to the scripts.
 *
 * A record is used once: the boot that starts from it takes it away first, and puts it back only
 * when the server has stayed up. One that fell over, or a record that won't read, is then started
 * by the scripts the next time, as if there had been no record. And a boot that goes through the
 * scripts takes away whatever record it found before they run, so the only record there can be is
 * the one the last scripts wrote: an older one would start the server with what those scripts
 * have since changed, the password it is stopped with among it.
 *
 * Not for what the scripts skip while they do run (`wake-step.ts`), or for a resume from memory,
 * which starts nothing.
 */

import { DATA_DIR } from './jars.ts'
import { SHIM_DIR } from './wake-step.ts'

/**
 * What the last boot's scripts ran: the key, the directory, how many variables they added and
 * those, one a line, then the command, a word a line.
 */
const RECORD = `${DATA_DIR}/.blockly-start`
const RUNNER = `${SHIM_DIR}/server-runner`
const STARTER = `${SHIM_DIR}/direct-start`
/** The names in the entrypoint's environment, for the stand-in to tell what the scripts added. */
const GIVEN = `${SHIM_DIR}/given-names`
/** How long a server started at once has to stay up for its record to be used again. */
const KEPT_AFTER_S = 90
/**
 * The variables that differ from one boot of a machine to the next and say nothing of what the
 * scripts would do: the provider's own, and the shell's.
 */
const PASSING = 'FLY_.*|HOSTNAME|PWD|OLDPWD|SHLVL|_|TERM|BLOCKLY_START_KEY'
const VARIABLE = '^[A-Za-z_][A-Za-z0-9_]*='

/**
 * The stand-in, line by line: it writes down what it is asked to run, then runs it. Variables are
 * read from awk's own table of them, which keeps a value whole whatever is in it; one that runs
 * over several lines is said as `!`, and nothing is written down.
 */
const RUNNER_LINES = [
  '#!/bin/sh',
  `added=$(awk "BEGIN { while ((getline name < \\"${GIVEN}\\") > 0) given[name]; for (name in ENVIRON) if (!(name in given) && name !~ /^(${PASSING})$/) { if (ENVIRON[name] ~ /\\n/) print \\"!\\"; else print name \\"=\\" ENVIRON[name] } }" | sort)`,
  `if [ -n "$BLOCKLY_START_KEY" ] && ! printf "%s\\n" "$added" | grep -q -x "!"; then { echo "$BLOCKLY_START_KEY"; pwd; printf "%s\\n" "$added" | grep -c .; printf "%s\\n" "$added" | grep .; for word; do printf "%s\\n" "$word"; done; } > ${RECORD}.new && mv -f ${RECORD}.new ${RECORD}; fi`,
  'exec mc-server-runner "$@"',
]

/**
 * What reads the record, as the volume's own user, line by line. `check` says whether a start
 * from it would hold: its key is this boot's, its lines read as they were written, every jar its
 * command names is there. `run` takes the record away, then starts the server from it; whatever
 * fails after that leaves no record, so the next boot is the scripts'. `forget` takes it away for
 * a boot the scripts are about to run.
 */
const STARTER_LINES = [
  '#!/bin/sh',
  `record=${RECORD}; mode=$1`,
  'if [ "$mode" = forget ]; then rm -f $record $record.last; exit 0; fi',
  '[ "$(sed -n 1p $record 2>/dev/null)" = "$BLOCKLY_START_KEY" ] || exit 1',
  'if [ "$mode" = run ]; then mv -f $record $record.last || exit 1; record=$record.last; fi',
  '{ read -r key; read -r dir; read -r added; case "$added" in ""|*[!0-9]*) exit 1;; esac',
  `while [ "$added" -gt 0 ]; do IFS= read -r variable; printf "%s\\n" "$variable" | grep -q -E "${VARIABLE}" || exit 1; if [ "$mode" = run ]; then export "$variable"; fi; added=$((added - 1)); done`,
  'set --; while IFS= read -r word; do set -- "$@" "$word"; done; } < $record',
  '[ $# -gt 0 ] || exit 1',
  'for word; do case "$word" in *.jar) [ -f "$dir/$word" ] || [ -f "$word" ] || exit 1;; esac; done',
  'cd "$dir" || exit 1',
  '[ "$mode" = run ] || exit 0',
  `(sleep ${KEPT_AFTER_S}; kill -0 $$ 2>/dev/null && mv -f ${RECORD}.last ${RECORD}) >/dev/null 2>&1 &`,
  'exec mc-server-runner "$@"',
]

const written = (path: string, lines: readonly string[]): string =>
  `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')} > ${path} && chmod 755 ${path}`

/**
 * The step, after every other of Blockly's and before the image's own entrypoint, which it leaves
 * to run wherever it doesn't hand the start over. Its lines hold no single quote but the two
 * files', so each of those is written as one argument per line.
 */
export const DIRECT_START_STEP = [
  `${written(RUNNER, RUNNER_LINES)} && ${written(STARTER, STARTER_LINES)} && export SERVER_RUNNER=${RUNNER};`,
  `awk "BEGIN { for (name in ENVIRON) print name }" > ${GIVEN};`,
  `export BLOCKLY_START_KEY=$({ awk "BEGIN { for (name in ENVIRON) if (name !~ /^(${PASSING})$/) print name \\"=\\" ENVIRON[name] }" | sort; cat /image/scripts/start*; } 2>/dev/null | sha256sum | cut -c1-64);`,
  // Whose the volume is, which the image's own start makes the server's user; never root's.
  `owner=$(ls -ldn ${DATA_DIR} | awk "{ print \\$3 \\":\\" \\$4 }"); me="$(id -u):$(id -g)"; direct=;`,
  `case "$owner" in 0:*|*:0|*[!0-9:]*|"") ;; "$me") direct=${STARTER};; *) if [ "$me" = 0:0 ]; then direct="gosu $owner ${STARTER}"; fi;; esac;`,
  'if [ -n "$direct" ] && $direct check; then',
  // As the image's own start leaves things for the server: its mask, and names resolved its way.
  'umask 0002; if [ "$me" = 0:0 ]; then echo "hosts: files dns" > /etc/nsswitch.conf; fi;',
  // Said as the image says its own hand-over to Java, which is what a start's progress reads (`logs.ts`).
  'echo "[init] Starting the Minecraft server at once: nothing changed since the last start";',
  'exec $direct run;',
  'fi;',
  // Left to the scripts: no record from before them outlives this boot.
  'if [ -n "$direct" ]; then $direct forget; fi;',
].join(' ')
