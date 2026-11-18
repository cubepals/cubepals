// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of a pack's files are the pack's, and which the owner's: one answer, whichever way a
 * server starts. The image extracts every file of a pack's `overrides/` and `server-overrides/`
 * again each time it installs the pack, at every start its scripts run (mc-image-helper 1.68.0,
 * `ModrinthPackInstaller`, with `REPLACE_EXISTING`), while a start that skips them
 * (`direct-start.ts`) leaves the volume as it is. So an owner's change to such a file survived
 * one kind of start and was undone by the other.
 *
 * Now the install itself keeps the owner's files. The helper's stand-in (`wake-step.ts`) hands
 * `install-modrinth-modpack` to this script, which runs only where the image installs a pack: a
 * server without one, a direct start and a resume never reach it, and pay nothing.
 *
 * - A file the pack placed that nobody changed since follows the pack, a new version included.
 * - A file the owner changed or deleted is set aside on the volume before the install and put back
 *   after it (deleted again, for one deleted); after an install cut short, at the start of the next. Where the pack's copy of it changed, the new copy is put
 *   beside it as `<file>.from-pack`, and the console says so, once.
 * - A file already there that the pack never placed, as far as the record knows, is the owner's
 *   as well: with no record, or one cut short, every file already on the volume is.
 *
 * What the pack placed is the record (`RECORD`), a SHA-1 and a path a line, as `sha1sum` writes
 * them, ending `# end`; it is written only after an install that succeeded, and travels with the
 * world. The pack is read for its paths only: where the image hasn't fetched it yet, it is fetched
 * here first, to where the image looks for it, which then installs that file rather than fetching
 * it again (`skipExisting`; `runtime-spec.ts`'s `PACK_STEP`). Where it can't be fetched or listed,
 * the install runs as it always did.
 *
 * It runs as root, so before anything writes or removes one of these paths, any link on the way to
 * it is replaced (`volume-links.ts`): the pack's paths, their copies beside them, the record and the
 * pack's archive.
 *
 * Not for the files a pack's index lists (its mods), which the image's own manifest keeps; nor
 * for Cubepals' own files (`carried.ts`), which, placed at an override path, count as the owner's.
 */
import { DATA_DIR } from './jars.ts'
import { UNLINKED } from './volume-links.ts'

/** The image's own Java helper, which the stand-in hands the install to. */
export const HELPER = '/usr/bin/mc-image-helper'

/** Where the image keeps the pack it installs (mc-image-helper 1.68.0 `ModrinthHttpPackFetcher`). */
const ARCHIVE = `${DATA_DIR}/modpack.mrpack`

/** The record of what the pack placed, on the volume. */
const RECORD = `${DATA_DIR}/.blockly-pack-files`

/** The record's last line: a record without it was cut short. */
const END = '# end'

/** What a kept file's newer pack copy is called, beside it. */
export const FROM_PACK = '.from-pack'

/**
 * Where the owner's files wait on the volume while the pack is installed, until they are back: an
 * install cut short leaves them there, and the next one puts them back before anything else.
 */
const KEPT = `${DATA_DIR}/.blockly-pack-kept`

/** The same, from the volume's root, as `unlinked` takes it. */
const KEPT_REL = KEPT.slice(DATA_DIR.length + 1)

/** Scratch space on the machine's own disk. */
const WORK = '/tmp/blockly-pack-files'

/**
 * Which of the pack's paths are the owner's, over `S` (the record, maybe empty), `C` (the volume
 * now) and `paths` (the pack's), each a SHA-1 and a path a line, or a path a line: `keep <path>`
 * for a file to put back, `gone <path>` for one to delete again.
 */
const OWNERS = [
  'FILENAME ~ /\\/S$/ { S[substr($0, 43)] = substr($0, 1, 40); next }',
  'FILENAME ~ /\\/C$/ { C[substr($0, 43)] = substr($0, 1, 40); next }',
  '{ p = $0; if (p in S) { if (!(p in C)) print "gone " p; else if (C[p] != S[p]) print "keep " p }',
  'else if (p in C) print "keep " p }',
].join(' ')

/**
 * Which of the owner's files get the pack's new copy beside them, over `S`, `C`, `N` (the pack's
 * copy the install left) and the owner's list: where the pack's copy changed since it was
 * recorded, and isn't what the owner has anyway.
 */
const BESIDE = [
  'FILENAME ~ /\\/S$/ { S[substr($0, 43)] = substr($0, 1, 40); next }',
  'FILENAME ~ /\\/C$/ { C[substr($0, 43)] = substr($0, 1, 40); next }',
  'FILENAME ~ /\\/N$/ { N[substr($0, 43)] = substr($0, 1, 40); next }',
  '{ k = substr($0, 1, 4); p = substr($0, 6); n = N[p];',
  'if (n != "" && n != S[p] && !(k == "keep" && n == C[p])) print p }',
].join(' ')

/** The script, as `install-modrinth-modpack` with the helper's own arguments. */
export const PACK_FILES_SCRIPT = `#!/bin/sh
# install-modrinth-modpack, keeping the owner's files among the pack's (pack-files.ts).
d=${DATA_DIR}; a=${ARCHIVE}; r=${RECORD}; k=${KEPT}; t=${WORK}
case "$MODRINTH_MODPACK" in http://*|https://*|file://*) ;; *) exec ${HELPER} "$@";; esac
${UNLINKED}
for f in ${ARCHIVE.slice(DATA_DIR.length + 1)} ${ARCHIVE.slice(DATA_DIR.length + 1)}.part ${RECORD.slice(DATA_DIR.length + 1)} ${RECORD.slice(DATA_DIR.length + 1)}.new ${KEPT_REL} ${KEPT_REL}.new; do unlinked "$f"; done
# A path the script takes from a list is one inside the volume: never absolute, never through "..".
inside() { case "$1" in ''|/*) return 1;; esac; case "/$1/" in */../*|*/./*|*//*) return 1;; esac; }
# The owner's files from an install that didn't finish, back first. Their copy is whole: it is moved
# into place only once it was. Each is a plain file inside the volume, put back as root.
rm -rf "$k.new" "$t"; mkdir -p "$t"
if [ -d "$k" ]; then
  unlinked ${KEPT_REL}/files; unlinked ${KEPT_REL}/gone
  (cd "$k/files" 2>/dev/null && find . -type f) | sed 's#^\\./##' | while IFS= read -r p; do
    inside "$p" || continue; unlinked "$p"; case "$p" in */*) mkdir -p "$d/\${p%/*}";; esac; cp -pT "$k/files/$p" "$d/$p" || : > "$t/unrestored"
  done
  if [ -f "$k/gone" ]; then while IFS= read -r p; do inside "$p" && unlinked "$p" && rm -f "$d/$p"; done < "$k/gone"; fi
  if [ -e "$t/unrestored" ]; then
    rm -rf "$t"; echo "[init] Couldn't put back all your own files from a pack install that didn't finish; they're kept in ${KEPT_REL}, and the pack wasn't installed" >&2; exit 1
  fi
  rm -rf "$k"; echo "[init] Put back your own files from a pack install that didn't finish"
fi
if [ ! -s "$a" ]; then
  curl -fsSL --retry 3 -o "$a.part" "$MODRINTH_MODPACK" && mv -f "$a.part" "$a" || { rm -f "$a.part"; exec ${HELPER} "$@"; }
fi
# The pack's paths, server overrides and the rest alike.
unzip -Z1 "$a" > "$t/entries" 2>/dev/null || exec ${HELPER} "$@"
sed -n -e 's#^server-overrides/##p' -e 's#^overrides/##p' "$t/entries" | grep -v '/$' | while IFS= read -r p; do inside "$p" && echo "$p"; done | sort -u > "$t/paths"
# No link on the way to any of them, where the install and this script write as root.
while IFS= read -r p; do unlinked "$p"; unlinked "$p${FROM_PACK}"; done < "$t/paths"
# The record, where it is whole; else none, and every file there is the owner's.
if [ "$(tail -n 1 "$r" 2>/dev/null)" = "${END}" ]; then sed '$d' "$r" > "$t/S"; else : > "$t/S"; fi
(cd "$d" && xargs -r -d '\\n' sha1sum < "$t/paths" 2>/dev/null) > "$t/C"
awk '${OWNERS}' "$t/S" "$t/C" "$t/paths" > "$t/owners"
sed -n 's/^keep //p' "$t/owners" > "$t/keep.list"; sed -n 's/^gone //p' "$t/owners" > "$t/gone.list"
# The owner's files set aside, whole, before the install may touch them; or no install at all.
mkdir -p "$k.new/files" && cp "$t/gone.list" "$k.new/gone" || : > "$t/failed"
{ (cd "$d" && tar -cf - --verbatim-files-from -T "$t/keep.list") || : > "$t/failed"; } | { (cd "$k.new/files" && tar -xpf -) || : > "$t/failed"; }
if [ -e "$t/failed" ] || ! mv "$k.new" "$k"; then
  rm -rf "$k.new" "$t"; echo "[init] Couldn't set your own files aside, so the pack wasn't installed; nothing was changed" >&2; exit 1
fi
${HELPER} "$@"; s=$?
# The pack's copy of each of the owner's files, as the install left it.
cut -c6- "$t/owners" | (cd "$d" && xargs -r -d '\\n' sha1sum 2>/dev/null) > "$t/N"
if [ $s -eq 0 ]; then
  awk '${BESIDE}' "$t/S" "$t/C" "$t/N" "$t/owners" | while IFS= read -r p; do
    cp "$d/$p" "$d/$p${FROM_PACK}"; echo "[init] Kept your own $p; the pack's new copy is beside it, as $p${FROM_PACK}"
  done
fi
# Each owner's file back as it was.
{ (cd "$k/files" && tar -cf - .) || : > "$t/unrestored"; } | { (cd "$d" && tar -xpf -) || : > "$t/unrestored"; }
if [ -e "$t/unrestored" ]; then
  rm -rf "$t"; echo "[init] Couldn't put back all your own files after installing the pack; they're kept in ${KEPT_REL}, and the next start tries again" >&2; exit 1
fi
(cd "$d" && xargs -r -d '\\n' rm -f < "$t/gone.list")
# What the pack placed, for the next install, once this one succeeded.
if [ $s -eq 0 ]; then
  cut -c6- "$t/owners" > "$t/kept"
  { cat "$t/N"; (cd "$d" && grep -vxF -f "$t/kept" "$t/paths" | xargs -r -d '\\n' sha1sum 2>/dev/null); echo "${END}"; } > "$r.new" && mv -f "$r.new" "$r"
fi
rm -rf "$k" "$t"
exit $s
`
