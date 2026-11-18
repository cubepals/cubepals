// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought back from its archive inside the server's own machine, before the image starts:
 * a rest wake on Fly, which otherwise makes, starts and destroys a helper machine first. The
 * runtime sets the variable on that one machine; every other start finds it unset, or the volume
 * already restored, and does nothing.
 *
 * The archive is read as it downloads: its first bytes say gzip or zstd (`archive-unpack.ts`), and
 * every byte is hashed against the sha256 its copy was written with. Only an empty volume is filled,
 * or one this step began on and was cut short in, which it empties first; a volume holding
 * anything else is never touched. The mark that says it is done is written last, once the hash
 * matches, so a restart after it repeats nothing. A failure empties the volume and stops the start
 * with `RESTORE_FAILED_EXIT`, which boot reads as a restore that failed, not a boot.
 *
 * Not for a server whose old world is still on its machine: a restore there keeps the old volume
 * until the new one is whole, which a helper machine does (`infra/fly`).
 */

import type { RuntimeObservation } from '../app/ports/runtime.ts'
import { ARCHIVE_INFLATER } from './archive-unpack.ts'
import { DATA_DIR } from './jars.ts'

/** `<sha256> <link>`: every copy a world rests in has its sha256. Held equal to Fly's copy. */
export const RESTORE_VARIABLE = 'BLOCKLY_RESTORE'

/**
 * The marks at the top of the volume: one while a restore runs, one once it is whole. Neither is
 * archived (`NOT_ARCHIVED`).
 */
export const RESTORING_MARK = '.blockly-restoring'
export const RESTORED_MARK = '.blockly-restored'

/** The exit that says the world couldn't be brought back, as distinct from a start that failed. */
export const RESTORE_FAILED_EXIT = 75

/** Where the step keeps its pipe, hash and failure marks: the machine's own disk. */
const WORK = '/tmp/blockly-restore'

/**
 * The step. sh has no pipefail on the image's Ubuntu builds (dash), so a download, an inflater or
 * tar that fails leaves a mark, and each drains what is left of its input once it ends, so one
 * that stops early never cuts off the one before it. It runs as root, after the server has had the
 * volume: a link at either mark is replaced first (`unlinked`, `volume-links.ts`), so neither the
 * look nor the write follows one outside it.
 */
export const RESTORE_STEP = [
  `${ARCHIVE_INFLATER}\n`,
  `if [ -n "$${RESTORE_VARIABLE}" ]; then unlinked ${RESTORED_MARK}; unlinked ${RESTORING_MARK}; fi;`,
  `if [ -n "$${RESTORE_VARIABLE}" ] && [ ! -e ${DATA_DIR}/${RESTORED_MARK} ]; then`,
  `if [ -e ${DATA_DIR}/${RESTORING_MARK} ] || [ -z "$(find ${DATA_DIR} -mindepth 1 -maxdepth 1 ! -name lost+found | head -n 1)" ]; then`,
  `sha=\${${RESTORE_VARIABLE}%% *}; url=\${${RESTORE_VARIABLE}#* }; w=${WORK};`,
  `rm -rf "$w"; mkdir -p "$w"; : > ${DATA_DIR}/${RESTORING_MARK};`,
  `find ${DATA_DIR} -mindepth 1 -maxdepth 1 ! -name ${RESTORING_MARK} ! -name lost+found -exec rm -rf {} +;`,
  `if i=$(inflater "$(curl -fsSL -r 0-3 "$url" | head -c 4 | od -An -tx1 | tr -d ' \\n')") && mkfifo "$w/pipe"; then`,
  `sha256sum < "$w/pipe" | cut -d ' ' -f 1 > "$w/sum" &`,
  `{ curl -fsSL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 "$url" || : > "$w/broken"; } | tee "$w/pipe" |`,
  `{ $i || : > "$w/broken"; cat > /dev/null; } |`,
  `(tar -xf - -C ${DATA_DIR} --no-same-owner --no-same-permissions || : > "$w/broken"; cat > /dev/null); wait;`,
  `else : > "$w/broken"; fi;`,
  `if [ ! -e "$w/broken" ] && [ -n "$sha" ] && [ "$(cat "$w/sum")" = "$sha" ] &&`,
  `find ${DATA_DIR} -xdev ! -type f ! -type d -exec rm -f {} + && chmod -R ug-s ${DATA_DIR} && chown 0:0 ${DATA_DIR} && sync &&`,
  `: > ${DATA_DIR}/${RESTORED_MARK} && rm -f ${DATA_DIR}/${RESTORING_MARK} && sync; then rm -rf "$w";`,
  `else find ${DATA_DIR} -mindepth 1 -maxdepth 1 ! -name ${RESTORING_MARK} ! -name lost+found -exec rm -rf {} +;`,
  `echo "Cubepals could not bring back this server's world from its copy" >&2; exit ${RESTORE_FAILED_EXIT}; fi;`,
  `else echo "Cubepals left this server's files as they were: the volume wasn't empty to bring its world back to" >&2; fi; fi;`,
].join(' ')

/**
 * Whether the step stopped a start, as the runtime saw it: its last run, or one the provider
 * started again after it.
 */
export function stoppedByRestore(seen: Pick<RuntimeObservation, 'exit' | 'failedCode'> | null): boolean {
  return seen?.exit?.code === RESTORE_FAILED_EXIT || seen?.failedCode === RESTORE_FAILED_EXIT
}

/** The variable the step reads, for a machine that brings its world back from `url`. */
export function restoreEnv(url: string, sha256: string): Record<string, string> {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error(`${sha256} isn't a sha256`)
  return { [RESTORE_VARIABLE]: `${sha256.toLowerCase()} ${url}` }
}
