// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own Java startup cache. A JVM that starts Minecraft loads, links and warms tens of
 * thousands of classes before the game does anything, the same ones at every start. JDK 25 can
 * keep that work in a file (its AOT cache, JEP 483 and 514) and start from it. Measured on the
 * image this runs, one CPU, the server's own command with the cache added: a Fabric 26.3 server
 * with eleven mods reached `Done` in 22.5 to 25.2 s in place of 27.9 to 33.5 s, Paper 26.2 in 48
 * s in place of 53 to 55 s. What it links ahead is only what Java's own class loaders load. A
 * loader's own (Fabric's, Paperclip's) is kept as a parsed copy that Java matches by checksum and
 * links as ever: measured with JDK 25, a Fabric 26.3 start read 4,405 of Minecraft's 15,103
 * classes from the cache, and none of Fabric Loader's own, which its launcher loads in a loader of
 * its own too. So Paper starts from its class path where it can (`paper-launch.ts`), which puts
 * all of Paper and Minecraft in the cache. NeoForge, which the image starts through the shell
 * script its installer writes, is given none: its command has no `java` for this to find.
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
 * - `start.aot.state`, what they were made for and how far that got: `recording`, with how many
 *   recordings it has started; `made`; or `failed` where a recording made no cache, or was started
 *   twice and never written, which isn't tried again.
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
 * given a cache, and only with room for it on the volume and in the machine's memory beside the
 * heap (`SPARE_KB`); one already made gives way when the volume runs short. A start that won't
 * record leaves no `recording` behind it, so no stop waits for a recording that isn't being made. Everything here runs as the server's own user, on files that user can
 * write: nothing of it is read as root.
 *
 * Not for whether the image's scripts run (`direct-start.ts`).
 */

import type { NOT_ARCHIVED } from '../app/ports/runtime.ts'
import { DATA_DIR } from './jars.ts'
import { LAUNCH_LINES } from './paper-launch.ts'
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
 * The memory a machine has to have beside the heap (`-Xmx`) for its Java to record a start, in
 * kilobytes. Java writes the recording as it exits, and that takes memory the running server
 * doesn't: measured on Paper 26.3 with a 2,048 MB heap and Aikar's flags, about 450 MB above the
 * heap while it runs and 440 MB more as it writes the recording. The kernel's own count of a
 * machine's memory is about 180 MB under its size (4,013,292 kB on a 4 GB machine), so production's
 * 3 GB machines with a 2,048 MB heap leave about 880 MB beside it.
 *
 * With the whole heap touched at its start (`-XX:+AlwaysPreTouch`, Aikar's flags), every such exit
 * was killed for want of memory and nothing was written. So a start that records leaves that one
 * option out (`bare`), and its heap holds only the pages it used. Measured on Paper 26.2 with the
 * Via plugins and Floodgate, a 2,048 MB heap, on the image a server runs, Docker holding it to
 * 2,900 MB, about what such a machine has: with the option the exit was killed and the recording
 * was empty; without it the recording was written, and still was at 2,700 MB with 3,072 chunks
 * generated before the stop, and at 2,400 MB for a start stopped once it was up.
 */
const SPARE_KB = 768 * 1024

/** The recordings a start may begin for what it runs before one never written is given up on. */
const TRIES = 2

/**
 * How a recording is made, said beside a server's failure: a server whose recordings failed made
 * another way is tried again this way, as if it had none. A failure that says no way was made
 * before recordings left the heap untouched (`bare`) with room beside it (`SPARE_KB`), and is tried
 * again. Changed whenever a change to how a recording is made could save one that failed.
 */
const WAY = 'bare'

/**
 * The script, line by line. Its words are the runner's own, then `--`, `java`, Java's options,
 * `-jar`, the jar, and the server's own. `with` runs them with more options put after `java`, less
 * the one that touches the whole heap first where `bare` is set;
 * `make` writes the cache from the recording, with Java's options as the server has them but the
 * one that touches the whole heap first.
 */
export const CACHED_RUNNER_LINES = [
  '#!/bin/sh',
  `cache=${CACHE}; conf=$cache.conf; state=${CACHE_STATE}; way=${WAY}`,
  'plain() { exec mc-server-runner "$@"; }',
  'n=0; at=0; jar=0; file=; bare=; launch=; lstate=',
  'for w; do n=$((n + 1)); if [ $at = 0 ]; then if [ "$w" = java ]; then at=$n; fi; elif [ $jar = 0 ]; then if [ "$w" = -jar ]; then jar=$n; fi; elif [ $n = $((jar + 1)) ]; then file=$w; fi; done',
  '[ -n "$BLOCKLY_START_KEY" ] && [ -n "$file" ] && [ -f "$file" ] || plain "$@"',
  `home=\${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}`,
  `[ "$(sed -n "s/^JAVA_VERSION=\\"\\([0-9]*\\).*/\\1/p" "$home/release" 2>/dev/null)" = ${JAVA} ] || plain "$@"`,
  // Paper from its class path, where the jar is Paperclip (`paper-launch.ts`).
  ...LAUNCH_LINES,
  // What it is made for covers every jar a manifest jar names: its state's first line is their sizes and times.
  'fp=$({ cat "$home/release"; stat -c "%s %Y" "$file"; if [ "$file" = "$launch" ]; then sed -n 1p "$lstate"; fi; n=0; for w; do n=$((n + 1)); if [ $n -gt $at ] && [ $n -le $((jar + 1)) ]; then printf "%s\\n" "$w"; fi; done; } 2>/dev/null | sha256sum | cut -c1-64)',
  'with() { more=$1; shift; n=0; for w; do n=$((n + 1)); if [ $n = 1 ]; then set --; fi; if [ -n "$bare" ] && [ "$w" = -XX:+AlwaysPreTouch ]; then continue; fi; set -- "$@" "$w"; if [ $n = $at ]; then set -- "$@" $more; fi; done; exec mc-server-runner "$@"; }',
  `make() ( n=0; for w; do n=$((n + 1)); if [ $n = 1 ]; then set --; fi; if [ $n -gt $at ] && [ $n -lt $jar ] && [ "$w" != -XX:+AlwaysPreTouch ]; then set -- "$@" "$w"; fi; done; exec java "$@" -XX:AOTMode=create -XX:AOTConfiguration=$conf -XX:AOTCache=$cache.new -cp "$file" >/dev/null 2>&1 )`,
  `mkdir -p ${CACHE_DIR} 2>/dev/null || plain "$@"`,
  `room=$(df -Pk ${DATA_DIR} 2>/dev/null | awk "NR == 2 { print \\$4 }")`,
  'case "$room" in ""|*[!0-9]*) plain "$@";; esac',
  `if [ "$room" -lt ${TIGHT_KB} ]; then rm -f $cache $cache.new $conf $state; plain "$@"; fi`,
  'phase=; if [ "$(sed -n 1p $state 2>/dev/null)" = "$fp" ]; then phase=$(sed -n 2p $state); else rm -f $cache $cache.new $conf $state; fi',
  // A failure made another way is forgotten: this way may write it.
  'if [ "$phase" = failed ] && [ "$(sed -n 3p $state)" != "$way" ]; then phase=; rm -f $cache $cache.new $conf $state; fi',
  'if [ "$phase" = made ] && [ -s $cache ]; then with "-XX:AOTCache=$cache" "$@"; fi',
  'if [ "$phase" = failed ]; then plain "$@"; fi',
  `if [ "$phase" = ${RECORDS} ] && [ -s $conf ]; then`,
  'echo "[init] Making this server a quicker start from its last one"',
  'if make "$@" && [ -s $cache.new ] && mv -f $cache.new $cache && printf "%s\\n" "$fp" made > $state; then rm -f $conf; with "-XX:AOTCache=$cache" "$@"; fi',
  'rm -f $conf $cache $cache.new; printf "%s\\n" "$fp" failed "$way" > $state; plain "$@"',
  'fi',
  // The recordings started for what runs now, this one counted: one still `recording` here was never written.
  `tries=1; if [ "$phase" = ${RECORDS} ]; then tries=$(sed -n 3p $state); case "$tries" in ""|*[!0-9]*) tries=1;; esac; tries=$((tries + 1)); fi`,
  `if [ "$tries" -gt ${TRIES} ]; then rm -f $conf $cache $cache.new; printf "%s\\n" "$fp" failed "$way" > $state; plain "$@"; fi`,
  // The heap Java is given, in kilobytes, and the machine's memory: a heap not said is Java's own share, which leaves room.
  'heap=; n=0; for w; do n=$((n + 1)); if [ $n -gt $at ] && [ $n -lt $jar ]; then case "$w" in -Xmx*) heap=${w#-Xmx};; esac; fi; done',
  'case "$heap" in *[gG]) heap=$((${heap%?} * 1048576));; *[mM]) heap=$((${heap%?} * 1024));; *[kK]) heap=${heap%?};; *[!0-9]*) heap=;; ?*) heap=$((heap / 1024));; esac',
  'memory=$(awk "/^MemTotal:/ { print \\$2 }" /proc/meminfo 2>/dev/null)',
  `fits=1; case "$heap$memory" in *[!0-9]*) ;; *) if [ -n "$heap" ] && [ -n "$memory" ] && [ $((memory - heap)) -lt ${SPARE_KB} ]; then fits=; fi;; esac`,
  `if [ "$room" -lt ${ROOM_KB} ] || [ -z "$fits" ]; then rm -f $conf $cache $cache.new $state; plain "$@"; fi`,
  `rm -f $conf $cache $cache.new; printf "%s\\n" "$fp" ${RECORDS} "$tries" > $state || plain "$@"`,
  `echo "${RECORDING}"`,
  // Recorded with the heap untouched until used: Java writes the recording beside it as it exits (`SPARE_KB`).
  'bare=1; with "-XX:AOTMode=record -XX:AOTConfiguration=$conf" "$@"',
]
