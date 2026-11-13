// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own Java startup cache. A JVM that starts Minecraft loads, links and warms tens of
 * thousands of classes before the game does anything, the same ones at every start. JDK 25 can
 * keep that work in a file (its AOT cache, JEP 483 and 514) and start from it. Measured on the
 * image this runs, one CPU, the server's own command with the cache added: a Fabric 26.3 server
 * with eleven mods reached `Done` in 22.5 to 25.2 s in place of 27.9 to 33.5 s, Paper 26.2 in 48
 * s in place of 53 to 55 s. What it holds is Java's and the libraries' classes, which the mod
 * loaders leave to Java's own class loader; Minecraft's and the mods' go through the loader's and
 * are loaded as ever.
 *
 * Java writes such a cache from a run of the real thing, in two halves. A start with no cache
 * records what it loads, which Java writes down as it exits (`-XX:AOTMode=record`). The start
 * after that one makes the cache from the recording before it starts the server, 5 to 16 s with
 * nothing else in the machine's memory, and starts with it; every start after only reads it. Both
 * halves at once (`-XX:AOTCacheOutput`) don't fit: that JVM starts a second one to write the cache
 * while it still holds the server's heap, and on the memory a server is given the second was
 * killed for want of it.
 *
 * So the last word of a start, the image's runner, is called through this file's script, which
 * adds to Java's options what the cache's state asks for and changes nothing else. It keeps, on
 * the volume, in the folder no archive of it holds (`.blockly-remade`, the runtime port's
 * `NOT_ARCHIVED`), so that no backup, download or resting copy carries a cache, and it counts
 * for nothing of the server's size:
 *
 * - `start.aot`, the cache;
 * - `start.aot.conf`, a recording not yet made into one;
 * - `start.aot.state`, what they were made for and how far that got: `recording`, `made`, or
 *   `failed` where a recording made no cache, which isn't tried again.
 *
 * What they were made for is the Java that runs, its options and the jar it starts: another of
 * any, a new loader or a heap of another size, starts over. Java checks a cache against what it
 * is about to run and starts without one that doesn't fit, so a cache can make a start no worse
 * than none.
 *
 * Only a server on Java 25 is given one: the image runs older Minecraft on older Java, which
 * knows none of this.
 *
 * A server that only sleeps and wakes never exits, so its recording would never be written: a
 * sleep nobody asked for that finds its Java recording is a stop for once (`CACHE_STATE`,
 * `app/operations/handlers/winding-down.ts`), and the server is then started in the background,
 * which makes the cache with nobody waiting, and sleeps as ever
 * (`app/operations/schedules/recorded-starts.ts`). Only a command of the shape `java … -jar …` is
 * given a cache, and only with room for it on the volume; one already made gives way when the
 * volume runs short. Everything here runs as the server's own user, on files that user can
 * write: nothing of it is read as root.
 *
 * Not for whether the image's scripts run (`direct-start.ts`).
 */

import type { NOT_ARCHIVED } from '../app/ports/runtime.ts'
import { DATA_DIR } from './jars.ts'
import { SHIM_DIR } from './wake-step.ts'

/** The folder on the volume that no archive holds (`NOT_ARCHIVED`): a cache is made again. */
const REMADE: (typeof NOT_ARCHIVED)[number] = '.blockly-remade'
const CACHE_DIR = `${DATA_DIR}/${REMADE}`
const CACHE = `${CACHE_DIR}/start.aot`

/** The script that the start's last word is called through, in place of the image's runner. */
export const CACHED_RUNNER = `${SHIM_DIR}/start-cache`

/** What a start that records says in the server's log. */
export const RECORDING = '[init] Recording this start, to make the next ones quicker'

/**
 * Where the script keeps how far the cache got, and what its second line reads while the Java
 * that runs is recording. Until that Java exits, nothing of the recording is written.
 */
export const CACHE_STATE = `${CACHE}.state`
export const RECORDS = 'recording'

/**
 * The one Java release given a cache: the one it was measured on. An older Java refuses the
 * options and starts nothing; a cache JDK 26 wrote stopped the server it was made for, where
 * tried. Every other release runs as it is.
 */
const JAVA = 25

/** The room a volume has to have for a recording to start, in kilobytes: several times what it and its cache take. */
const ROOM_KB = 1024 * 1024
/** The room under which a cache already made gives way: the volume is the world's first. */
const TIGHT_KB = 256 * 1024

/**
 * The script, line by line. Its words are the runner's own, then `--`, `java`, Java's options,
 * `-jar`, the jar, and the server's own. `with` runs them with more options put after `java`;
 * `make` writes the cache from the recording, with Java's options as the server has them but the
 * one that touches the whole heap first.
 */
export const CACHED_RUNNER_LINES = [
  '#!/bin/sh',
  `cache=${CACHE}; conf=$cache.conf; state=${CACHE_STATE}`,
  'plain() { exec mc-server-runner "$@"; }',
  'n=0; at=0; jar=0; file=',
  'for w; do n=$((n + 1)); if [ $at = 0 ]; then if [ "$w" = java ]; then at=$n; fi; elif [ $jar = 0 ]; then if [ "$w" = -jar ]; then jar=$n; fi; elif [ $n = $((jar + 1)) ]; then file=$w; fi; done',
  '[ -n "$BLOCKLY_START_KEY" ] && [ -n "$file" ] && [ -f "$file" ] || plain "$@"',
  `home=\${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}`,
  `[ "$(sed -n "s/^JAVA_VERSION=\\"\\([0-9]*\\).*/\\1/p" "$home/release" 2>/dev/null)" = ${JAVA} ] || plain "$@"`,
  'fp=$({ cat "$home/release"; stat -c "%s %Y" "$file"; n=0; for w; do n=$((n + 1)); if [ $n -gt $at ] && [ $n -le $((jar + 1)) ]; then printf "%s\\n" "$w"; fi; done; } 2>/dev/null | sha256sum | cut -c1-64)',
  'with() { more=$1; shift; n=0; for w; do n=$((n + 1)); if [ $n = 1 ]; then set --; fi; set -- "$@" "$w"; if [ $n = $at ]; then set -- "$@" $more; fi; done; exec mc-server-runner "$@"; }',
  `make() ( n=0; for w; do n=$((n + 1)); if [ $n = 1 ]; then set --; fi; if [ $n -gt $at ] && [ $n -lt $jar ] && [ "$w" != -XX:+AlwaysPreTouch ]; then set -- "$@" "$w"; fi; done; exec java "$@" -XX:AOTMode=create -XX:AOTConfiguration=$conf -XX:AOTCache=$cache.new -cp "$file" >/dev/null 2>&1 )`,
  `mkdir -p ${CACHE_DIR} 2>/dev/null || plain "$@"`,
  `room=$(df -Pk ${DATA_DIR} 2>/dev/null | awk "NR == 2 { print \\$4 }")`,
  'case "$room" in ""|*[!0-9]*) plain "$@";; esac',
  `if [ "$room" -lt ${TIGHT_KB} ]; then rm -f $cache $cache.new $conf $state; plain "$@"; fi`,
  'phase=; if [ "$(sed -n 1p $state 2>/dev/null)" = "$fp" ]; then phase=$(sed -n 2p $state); else rm -f $cache $cache.new $conf $state; fi',
  'if [ "$phase" = made ] && [ -s $cache ]; then with "-XX:AOTCache=$cache" "$@"; fi',
  'if [ "$phase" = failed ]; then plain "$@"; fi',
  `if [ "$phase" = ${RECORDS} ] && [ -s $conf ]; then`,
  'echo "[init] Making this server a quicker start from its last one"',
  'if make "$@" && [ -s $cache.new ] && mv -f $cache.new $cache && printf "%s\\n" "$fp" made > $state; then rm -f $conf; with "-XX:AOTCache=$cache" "$@"; fi',
  'rm -f $conf $cache $cache.new; printf "%s\\n" "$fp" failed > $state; plain "$@"',
  'fi',
  `[ "$room" -ge ${ROOM_KB} ] || plain "$@"`,
  `rm -f $conf $cache $cache.new; printf "%s\\n" "$fp" ${RECORDS} > $state || plain "$@"`,
  `echo "${RECORDING}"`,
  'with "-XX:AOTMode=record -XX:AOTConfiguration=$conf" "$@"',
]
