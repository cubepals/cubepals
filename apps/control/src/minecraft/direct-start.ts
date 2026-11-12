// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A boot that changed nothing starts the server at once. The image's scripts work out, at every
 * start, the command the server runs with: which jar, which Java flags, as which user. They get
 * there through a dozen steps that each start a JVM of their own or ask the network (the loader's
 * launcher, the jars already on the volume, `server.properties`), and where nothing they read has
 * changed since the last boot, they arrive at the same command. Measured on a Fabric 26.3 server
 * with eleven mods, one CPU: Java started 11 s after the container with the scripts and 1.7 s
 * after it without them.
 *
 * So the scripts' last call, the one that runs the server, goes through a stand-in
 * (`SERVER_RUNNER`, which the image reads) that writes down the command, the directory, the user
 * and the variables the scripts added to its environment, with a key for everything the scripts
 * decide by: this entrypoint's whole environment as Blockly's own steps left it, and the scripts
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
 * A record is used once: a boot that starts from it takes it away, and puts it back only when the
 * server has stayed up. One that fell over is then started by the scripts the next time, as if
 * there had been no record.
 *
 * Not for what the scripts skip while they do run (`wake-step.ts`), or for a resume from memory,
 * which starts nothing.
 */

import { DATA_DIR } from './jars.ts'
import { SHIM_DIR } from './wake-step.ts'

/**
 * What the last boot's scripts ran: the key, the user, the directory, how many variables they
 * added and those, one a line, then the command, a word a line.
 */
const RECORD = `${DATA_DIR}/.blockly-start`
const RUNNER = `${SHIM_DIR}/server-runner`
/** The names in the entrypoint's environment, for the stand-in to tell what the scripts added. */
const GIVEN = `${SHIM_DIR}/given-names`
/** How long a server started at once has to stay up for its record to be used again. */
const KEPT_AFTER_S = 90
/**
 * The variables that differ from one boot of a machine to the next and say nothing of what the
 * scripts would do: the provider's own, and the shell's.
 */
const PASSING = 'FLY_.*|HOSTNAME|PWD|OLDPWD|SHLVL|_|TERM|BLOCKLY_START_KEY'

/**
 * The stand-in, line by line: it writes down what it is asked to run, then runs it. Variables are
 * read from awk's own table of them, which keeps a value whole whatever is in it; one that runs
 * over several lines is said as `!`, and nothing is written down.
 */
const RUNNER_LINES = [
  '#!/bin/sh',
  `added=$(awk "BEGIN { while ((getline name < \\"${GIVEN}\\") > 0) given[name]; for (name in ENVIRON) if (!(name in given) && name !~ /^(${PASSING})$/) { if (ENVIRON[name] ~ /\\n/) print \\"!\\"; else print name \\"=\\" ENVIRON[name] } }" | sort)`,
  `if [ -n "$BLOCKLY_START_KEY" ] && ! printf "%s\\n" "$added" | grep -q -x "!"; then { echo "$BLOCKLY_START_KEY"; echo "$(id -u):$(id -g)"; pwd; printf "%s\\n" "$added" | grep -c .; printf "%s\\n" "$added" | grep .; for word; do printf "%s\\n" "$word"; done; } > ${RECORD}.new && mv ${RECORD}.new ${RECORD}; fi`,
  'exec mc-server-runner "$@"',
]

/**
 * The step, after every other of Blockly's and before the image's own entrypoint, which it leaves
 * to run wherever it doesn't start the server itself. Its lines hold no single quote but the
 * stand-in's, so the stand-in is written as one argument per line.
 */
export const DIRECT_START_STEP = [
  `printf '%s\\n' ${RUNNER_LINES.map((line) => `'${line}'`).join(' ')} > ${RUNNER} && chmod 755 ${RUNNER} && export SERVER_RUNNER=${RUNNER};`,
  `awk "BEGIN { for (name in ENVIRON) print name }" > ${GIVEN};`,
  `export BLOCKLY_START_KEY=$({ awk "BEGIN { for (name in ENVIRON) if (name !~ /^(${PASSING})$/) print name \\"=\\" ENVIRON[name] }" | sort; cat /image/scripts/start*; } 2>/dev/null | sha256sum | cut -c1-64);`,
  `if [ "$(sed -n 1p ${RECORD} 2>/dev/null)" = "$BLOCKLY_START_KEY" ]; then`,
  // The record's lines: the key, the user, the directory, the count of variables, those, the words.
  `{ read -r key; read -r as; read -r dir; read -r added; there=1; case "$added" in ""|*[!0-9]*) there=0; added=0;; esac;`,
  'left=$added; while [ "$left" -gt 0 ]; do read -r skipped; left=$((left - 1)); done;',
  `set --; while IFS= read -r word; do set -- "$@" "$word"; done; } < ${RECORD};`,
  // Every jar the command names is still there, or the scripts fetch what is missing.
  'for word; do case "$word" in *.jar) [ -f "$dir/$word" ] || [ -f "$word" ] || there=0;; esac; done;',
  'me="$(id -u):$(id -g)"; if [ "$as" != "$me" ] && [ "$me" != 0:0 ]; then there=0; fi;',
  'if [ $there = 1 ] && [ $# -gt 0 ] && cd "$dir"; then',
  // Only now the variables the scripts added: a boot left to the scripts must not find them set.
  `{ read -r key; read -r as; read -r dir; read -r left; while [ "$left" -gt 0 ]; do IFS= read -r variable; export "$variable"; left=$((left - 1)); done; } < ${RECORD};`,
  `mv ${RECORD} ${RECORD}.last;`,
  `(sleep ${KEPT_AFTER_S}; kill -0 $$ 2>/dev/null && mv ${RECORD}.last ${RECORD}) >/dev/null 2>&1 &`,
  // As the image's own start leaves things for the server: its mask, and names resolved its way.
  'umask 0002; if [ "$me" = 0:0 ]; then echo "hosts: files dns" > /etc/nsswitch.conf; fi;',
  // Said as the image says its own hand-over to Java, which is what a start's progress reads (`logs.ts`).
  'echo "[init] Starting the Minecraft server at once: nothing changed since the last start";',
  'if [ "$as" = "$me" ]; then exec mc-server-runner "$@"; else exec gosu "$as" mc-server-runner "$@"; fi;',
  'fi; set --;',
  'fi;',
].join(' ')
