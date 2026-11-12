// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work the itzg image redoes at every start, which Blockly spares it where the outcome is the
 * same. Every call of the image's Java helper (mc-image-helper) starts a JVM, and on a server's
 * one CPU each took about 1.5 s. A wake of a plain Paper server on staging (2026-10-11) spent 18 s
 * in the image's scripts before Java started, most of it in seven of those calls; five of them
 * change nothing:
 *
 * - `java-release` asks a JVM which Java it runs, which the JDK's own `release` file says.
 * - `sync` of `/plugins` and `/config`, folders a Blockly server never mounts: with no source, the
 *   helper copies nothing.
 * - two `mcopy`s of Paper's default configs, which keep files already there: once the four files
 *   are on the volume, they copy nothing.
 *
 * A stand-in for the helper answers the first two, and `SKIP_DOWNLOAD_DEFAULTS` skips the last; every
 * other call goes to the helper itself, with a JVM made for a short life: C1 alone compiles, and
 * the serial collector starts no threads. Measured on a staging machine with this step: the image's
 * scripts took 4.4 s, and the wake to Paper's `Done` 33 s against 47 s; a Skyblock server's 41 s
 * against 57 s.
 *
 * Not for this step: a class data archive for Minecraft's own JVM, which saved under 2 s of the
 * same wake and weighs 127 MB on the volume, in every backup and every rest; or the boot that
 * needs none of the scripts, because nothing changed since the last one (`direct-start.ts`).
 */

import { DATA_DIR } from './jars.ts'

/** Where the stand-ins live: the machine's own disk, made again at every start. */
export const SHIM_DIR = '/tmp/blockly-bin'

/**
 * The stand-in, line by line. A Java 8 `release` says `1.8.0`, which the helper reads as 8 and
 * this would not; it goes to the helper.
 */
const SHIM = [
  '#!/bin/sh',
  'case "$1" in',
  `java-release) v=$(sed -n "s/^JAVA_VERSION=\\"\\([0-9]*\\).*/\\1/p" "$JAVA_HOME/release" 2>/dev/null); if [ "\${v:-0}" -gt 8 ]; then echo "$v"; exit 0; fi;;`,
  'sync|sync-and-interpolate) for a; do src=$dst; dst=$a; done; [ -e "$src" ] || exit 0;;',
  'esac',
  'exec /usr/bin/mc-image-helper "$@"',
]

/** Paper's default configs, as the image fetches them for 1.19 and later. */
const PAPER_DEFAULTS = [
  'bukkit.yml',
  'spigot.yml',
  'config/paper-global.yml',
  'config/paper-world-defaults.yml',
]

/**
 * The step, last before the image's own entrypoint. Its lines hold no single quote but the
 * stand-in's, so the stand-in is written as one argument per line.
 */
export const WAKE_STEP = [
  `mkdir -p ${SHIM_DIR} && printf '%s\\n' ${SHIM.map((line) => `'${line}'`).join(' ')} > ${SHIM_DIR}/mc-image-helper`,
  `&& chmod 755 ${SHIM_DIR}/mc-image-helper && export PATH="${SHIM_DIR}:$PATH";`,
  `if [ "$TYPE" = PAPER ]${PAPER_DEFAULTS.map((file) => ` && [ -f ${DATA_DIR}/${file} ]`).join('')}; then export SKIP_DOWNLOAD_DEFAULTS=true; fi;`,
  'export MC_IMAGE_HELPER_OPTS="-XX:TieredStopAtLevel=1 -XX:+UseSerialGC";',
].join(' ')
