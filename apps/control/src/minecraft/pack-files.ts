// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of a pack's files are the pack's, and which the owner's: one answer, whichever way a
 * server starts. The image extracts every file of a pack's `overrides/` and `server-overrides/`
 * again at each start its scripts run (mc-image-helper 1.68.0, `ModrinthPackInstaller`, with
 * `REPLACE_EXISTING`), while a start that skips them (`direct-start.ts`) leaves the volume as it
 * is. So an owner's change to such a file survived one kind of start and was undone by the
 * other. Now, at every start, before the image:
 *
 * - a file the pack placed that nobody changed follows the pack, a new version of it included;
 * - a file the owner changed, or deleted, stays as the owner left it: the image is told to leave
 *   it (`MODRINTH_OVERRIDES_EXCLUSIONS`), and where the pack's own copy changes since, its new
 *   copy is put beside it as `<file>.from-pack`, and the console says so, once.
 *
 * A file is judged only once it is known the pack placed it: a start found it on the volume as
 * the pack has it (`PLACED`), or the image placed what was due at the last start (`DUE`), which
 * shows in any of those files being on the volume as due. Where none is, the image never got to
 * place them (that start failed first), and every one follows the pack rather than counting as
 * deleted. What the pack holds is read from the pack itself, once per
 * pack (`INDEX`). All three travel with the world. A pack the image hasn't fetched yet is fetched
 * here first, to where the image looks for it, which then installs that file rather than
 * fetching it again (`skipExisting`; `runtime-spec.ts`'s `PACK_STEP`). Where it can't be fetched or
 * read, nothing is decided and the image does as it always did.
 *
 * The image's list of files to leave is one variable, which can't pass the kernel's limit
 * (`LIST_BYTES`): past it, the owner's files aren't kept at that start, and the console says so.
 * A path holding `*`, `?` or a comma can't be said exactly in that list, and follows the pack.
 * Not for the files a pack's index lists (its mods), which the image's own manifest keeps; nor
 * for Cubepals' own files (`carried.ts`), which, placed at an override path, count as the owner's.
 */
import { DATA_DIR } from './jars.ts'

/** Where the image keeps the pack it installs (mc-image-helper 1.68.0 `ModrinthHttpPackFetcher`). */
const ARCHIVE = `${DATA_DIR}/modpack.mrpack`

/** What the pack holds: a SHA-1 and a path a line, as `sha1sum` writes them, under the pack's id. */
const INDEX = `${DATA_DIR}/.blockly-pack-index`

/** The pack's files found on the volume as it placed them, at the last start. */
const PLACED = `${DATA_DIR}/.blockly-pack-placed`

/** The pack's files the image was to place at the last start. */
const DUE = `${DATA_DIR}/.blockly-pack-due`

/** What a kept file's newer pack copy is called, beside it. */
export const FROM_PACK = '.from-pack'

/**
 * The most the list of files left to the owner may hold. One variable can hold 128 KiB
 * (`MAX_ARG_STRLEN`, as `carried-files.ts` reads it); the pack's own exclusions share it.
 */
const LIST_BYTES = 64 * 1024

/** Scratch space on the machine's own disk, made again at every start. */
const WORK = '/tmp/blockly-pack-files'

/**
 * The judgement, over `P` (the pack now), `D` (due last start), `S` (placed as of last start) and
 * `C` (the volume now), each a SHA-1 and a path a line. It writes `S2`, what is placed now; `x`,
 * the paths left to the owner; `b`, the ones whose newer pack copy goes beside them; and `D2`,
 * what the image is to place now.
 */
const JUDGE = [
  'function h(l) { return substr(l, 1, 40) } function p(l) { return substr(l, 43) }',
  'FILENAME ~ /\\/P$/ { P[p($0)] = h($0) } FILENAME ~ /\\/D$/ { D[p($0)] = h($0) }',
  'FILENAME ~ /\\/S$/ { S[p($0)] = h($0) } FILENAME ~ /\\/C$/ { C[p($0)] = h($0) }',
  // The image placed what was due at the last start where any of it is on the volume as due.
  'END { for (f in D) if (C[f] == D[f]) placed = 1;',
  'for (f in D) all[f] = 1; for (f in S) all[f] = 1; for (f in all) {',
  'if ((f in D) && C[f] == D[f]) print D[f] "  " f > (t "/S2");',
  'else if ((f in S) && C[f] == S[f]) print S[f] "  " f > (t "/S2");',
  'else if (((f in S) || (placed && (f in D))) && (f in P)) { was = (placed && (f in D)) ? D[f] : S[f];',
  'print f > (t "/x"); print P[f] "  " f > (t "/S2"); if (P[f] != was) print f > (t "/b") } }',
  'close(t "/x"); while ((getline l < (t "/x")) > 0) X[l] = 1;',
  'for (f in P) if (!(f in X)) print P[f] "  " f > (t "/D2") }',
].join(' ')

/** A file under `/data` written by root, handed to the volume's owner. */
const OWNED = (path: string) => `chown -h "$o" "${path}"`

/** The step. `a` the pack file, `t` scratch, `o` the volume's owner. */
export const PACK_FILES_STEP = [
  'if [ -n "$MODRINTH_MODPACK" ]; then',
  `a=${ARCHIVE}; t=${WORK}; o="$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')";`,
  'rm -rf "$t"; mkdir -p "$t/pack"; for f in x b S D S2 D2; do : > "$t/$f"; done;',
  // The pack, where the image hasn't fetched it yet.
  `if [ ! -s "$a" ]; then if curl -fsSL --retry 3 -o "$a.part" "$MODRINTH_MODPACK"; then mv -f "$a.part" "$a"; ${OWNED('$a')}; else rm -f "$a.part"; fi; fi;`,
  // What the pack holds: its index when it is the same pack, else read from the pack and kept.
  `if [ -s ${INDEX} ] && [ "$(head -n 1 ${INDEX})" = "# $BLOCKLY_PACK" ]; then tail -n +2 ${INDEX} > "$t/P";`,
  'elif [ -s "$a" ]; then unzip -qq -o "$a" "overrides/*" -d "$t" 2>/dev/null; unzip -qq -o "$a" "server-overrides/*" -d "$t" 2>/dev/null;',
  'for s in overrides server-overrides; do if [ -d "$t/$s" ]; then cp -a "$t/$s/." "$t/pack/"; fi; done;',
  `(cd "$t/pack" && find . -type f -exec sha1sum {} + | sed 's|  \\./|  |') > "$t/P";`,
  `{ printf "# %s\\n" "$BLOCKLY_PACK"; cat "$t/P"; } > ${INDEX}.new && mv -f ${INDEX}.new ${INDEX}; ${OWNED(INDEX)};`,
  'else rm -f "$t/P"; fi;',
  'if [ -f "$t/P" ]; then',
  `tail -n +2 ${PLACED} > "$t/S" 2>/dev/null; tail -n +2 ${DUE} > "$t/D" 2>/dev/null;`,
  // The volume now, for every file the pack placed or was to place.
  `cat "$t/S" "$t/D" | cut -c43- | sort -u | (cd ${DATA_DIR} && xargs -r -d '\\n' sha1sum 2>/dev/null) > "$t/C";`,
  `awk -v t="$t" '${JUDGE}' "$t/P" "$t/D" "$t/S" "$t/C";`,
  // The pack's new copy beside each file the owner keeps, where the pack changed it.
  `while IFS= read -r p; do if [ -f "$t/pack/$p" ]; then f="${DATA_DIR}/$p"; mkdir -p "$(dirname "$f")";`,
  `cp "$t/pack/$p" "$f${FROM_PACK}"; ${OWNED(`$f${FROM_PACK}`)}; echo "[init] Kept your own $p; the pack's new copy is beside it, as $p${FROM_PACK}"; fi; done < "$t/b";`,
  // The image leaves the owner's files, as one list a path a line; past its limit, none.
  `if [ "$(wc -c < "$t/x")" -gt ${LIST_BYTES} ]; then : > "$t/x"; echo "[init] Too many of the pack's files were changed to keep them all; the pack's own are placed"; fi;`,
  "nl='\n';",
  `while IFS= read -r p; do case "$p" in *[*?,]*) ;; *) MODRINTH_OVERRIDES_EXCLUSIONS="\${MODRINTH_OVERRIDES_EXCLUSIONS:+$MODRINTH_OVERRIDES_EXCLUSIONS$nl}$p";; esac;`,
  'done < "$t/x"; if [ -n "$MODRINTH_OVERRIDES_EXCLUSIONS" ]; then export MODRINTH_OVERRIDES_EXCLUSIONS; fi;',
  // What is placed now, and what the image is to place, for the next start to judge by.
  `{ printf "# %s\\n" "$BLOCKLY_PACK"; cat "$t/S2"; } > ${PLACED}.new && mv -f ${PLACED}.new ${PLACED}; ${OWNED(PLACED)};`,
  `{ printf "# %s\\n" "$BLOCKLY_PACK"; cat "$t/D2"; } > ${DUE}.new && mv -f ${DUE}.new ${DUE}; ${OWNED(DUE)};`,
  'fi; rm -rf "$t";',
  'fi;',
].join(' ')
