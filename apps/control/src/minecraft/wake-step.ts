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
 * - two `mcopy`s of Paper's default configs, which keep files already there. Paper writes its own
 *   defaults for any it doesn't find, and these come from a third party's repository on GitHub, so
 *   they are never fetched.
 * - `curseforge-files` with no files, which every start of a server with mods or plugins runs: with
 *   none listed and no record of any it placed before (its manifest), it does nothing.
 *
 * A stand-in for the helper answers `java-release`, `sync` and an empty `curseforge-files`, and
 * `SKIP_DOWNLOAD_DEFAULTS` skips the copies; every
 * other call goes to the helper itself, with a JVM made for a short life: C1 alone compiles, and
 * the serial collector starts no threads. Measured on a staging machine with this step: the image's
 * scripts took 4.4 s, and the wake to Paper's `Done` 33 s against 47 s; a Skyblock server's 41 s
 * against 57 s.
 *
 * Not for this step: a class data archive for Minecraft's own JVM, which saved under 2 s of the
 * same wake and weighs 127 MB on the volume, in every backup and every rest; or the boot that
 * needs none of the scripts, because nothing changed since the last one (`direct-start.ts`).
 */

import { SPARK_STEP } from './spark.ts'

/** Where the stand-ins live: the machine's own disk, made again at every start. */
export const SHIM_DIR = '/tmp/blockly-bin'

/** The record `curseforge-files` keeps of the files it placed, in the directory it runs in. */
const CURSEFORGE_MANIFEST = '.curseforge-files-manifest.json'

/**
 * The stand-in, line by line. A Java 8 `release` says `1.8.0`, which the helper reads as 8 and
 * this would not; it goes to the helper. `curseforge-files` writes its manifest in the directory it
 * runs in, `/data` (mc-image-helper 1.68.0, `Manifests.buildManifestPath`: `.%s-manifest.json`); a
 * server that once had files listed has one, and the helper takes away what it placed.
 */
const SHIM = [
  '#!/bin/sh',
  'case "$1" in',
  `java-release) v=$(sed -n "s/^JAVA_VERSION=\\"\\([0-9]*\\).*/\\1/p" "$JAVA_HOME/release" 2>/dev/null); if [ "\${v:-0}" -gt 8 ]; then echo "$v"; exit 0; fi;;`,
  'sync|sync-and-interpolate) for a; do src=$dst; dst=$a; done; [ -e "$src" ] || exit 0;;',
  `curseforge-files) for a; do last=$a; done; [ -z "$last" ] && [ ! -e ${CURSEFORGE_MANIFEST} ] && exit 0;;`,
  'esac',
  'exec /usr/bin/mc-image-helper "$@"',
]

/**
 * The Fabric installer every Fabric server's launcher is made with, pinned as the image's release
 * is (`runtime-spec.ts`), and moved deliberately. Unpinned, the image asks Fabric's meta for the
 * newest at every start the scripts run, which fails the start while Fabric's meta is down, and a
 * new release downloads a new launcher, whose Java recording is then made again
 * (`start-cache.ts`). The installer only makes the launcher, whatever the game's version. A pack's
 * install leaves it unpinned (mc-image-helper 1.68.0 `ModrinthPackInstaller`), and reads none of this.
 */
const FABRIC_INSTALLER = '1.1.2'

/**
 * The step, last before the image's own entrypoint. Its lines hold no single quote but the
 * stand-in's, so the stand-in is written as one argument per line.
 */
export const WAKE_STEP = [
  `mkdir -p ${SHIM_DIR} && printf '%s\\n' ${SHIM.map((line) => `'${line}'`).join(' ')} > ${SHIM_DIR}/mc-image-helper`,
  `&& chmod 755 ${SHIM_DIR}/mc-image-helper && export PATH="${SHIM_DIR}:$PATH";`,
  `if [ "$TYPE" = PAPER ]; then export SKIP_DOWNLOAD_DEFAULTS=true; fi;`,
  `if [ "$TYPE" = FABRIC ]; then export FABRIC_LAUNCHER_VERSION=${FABRIC_INSTALLER}; fi;`,
  'export MC_IMAGE_HELPER_OPTS="-XX:TieredStopAtLevel=1 -XX:+UseSerialGC";',
  // Not the image's work, but an export every start makes before Java, so it rides here.
  SPARK_STEP,
].join(' ')
