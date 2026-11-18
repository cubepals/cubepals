// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Paper started from its own class path, so that Java's startup cache (`start-cache.ts`) holds
 * Paper and Minecraft. Paper ships as Paperclip, a jar that patches Mojang's server into
 * `versions/` and unpacks Paper's libraries into `libraries/`, then starts Paper in a class loader
 * of its own. Java's cache keeps a class from such a loader only as a parsed copy, never linked:
 * measured on Paper 26.2 on the image a server runs, the cache made through Paperclip linked 4,567
 * classes, all the JDK's, and a start with it read 4,456 of Minecraft's 14,847 classes from it.
 * The same server started from the class path linked 28,389, and read 15,403 of 15,461. With the
 * Via plugins and Floodgate, on one CPU, `Done` came at 19.7 to 22.2 s in place of 25.2 to 27.0
 * s, six starts each, alternating.
 *
 * So where the server's jar is Paperclip, the start runs a jar of nothing but a manifest
 * (`launch.jar`) that names Paper's main class and, as its class path, the jars Paperclip lists:
 * Mojang's server patched, then the libraries, in Paperclip's own order. It is made once for each
 * Paperclip and what it unpacked: every jar is checked against the SHA-256 Paperclip lists for it,
 * as Paperclip does at each of its own starts, and where one is missing or differs, Paperclip is
 * run once to patch and nothing else (`-Dpaperclip.patchonly=true`), and they are checked again.
 * Any change to Paperclip or to a jar it unpacked, by its size or its time, makes it again.
 *
 * A start with it whose server never said it was up (`DONE`, in its own log, which the next start
 * reads before the server writes another) counts against it; after `TRIES` of those for the same
 * jars the server starts through Paperclip, as before, until either changes. One that did is used
 * from then on. Nothing
 * of Paper's is changed: its jars are used as Paperclip leaves them, and the manifest only names
 * them.
 *
 * The jar is written by Python, which the image Paper runs on carries (a server on Paper never runs
 * on the Alpine image, `imageFor`); where there is none, Paperclip starts it. Like the cache, it
 * is kept in the folder no archive holds, and made again on a volume that arrives without it.
 *
 * Not for the cache itself, which this only gives another jar to start (`start-cache.ts`).
 */

import { DATA_DIR } from './jars.ts'
import { SHIM_DIR } from './wake-step.ts'

/** Where the manifest jar is kept: beside the cache, in the folder no archive holds. */
const LAUNCH = `${DATA_DIR}/.blockly-remade/launch.jar`
/**
 * What tells Paperclip from the jar Mojang ships, which lists what it unpacks the same way but
 * starts the server whatever it is asked: Paperclip's own main class.
 */
const PAPERCLIP = 'io/papermc/paperclip/Main.class'
/** The program that checks what Paperclip unpacked and writes the manifest jar. */
export const LAUNCH_MAKER = `${SHIM_DIR}/paper-launch`

/**
 * What the server says in its own log once it takes connections, as `saysReady` reads it
 * (`logs.ts`): `Done (21.630s)! For help, type "help"`. Where Minecraft keeps that log, from the
 * server's own folder.
 */
const DONE = 'Done ([0-9.,]*s)!'
const LOG = 'logs/latest.log'
/** The starts from it that didn't stay up, for the same jars, after which Paperclip starts the server. */
const TRIES = 2

/**
 * The maker, line by line: `paper-launch <Paperclip> <manifest jar>`. It prints the class path's
 * jars, one a line, and exits 0; 2 where a jar Paperclip lists is missing or differs; 3 where the
 * jar is no Paperclip. Paths are made relative to the manifest jar, as Java reads them. A manifest's
 * lines are at most 72 bytes, the rest continued on the next after a space.
 */
export const LAUNCH_MAKER_LINES = [
  'import hashlib, os, sys, urllib.parse, zipfile',
  'paper, out = sys.argv[1], os.path.abspath(sys.argv[2])',
  'try:',
  '    with zipfile.ZipFile(paper) as z:',
  '        main = z.read("META-INF/main-class").decode().strip()',
  '        lists = [(z.read("META-INF/" + kind + ".list").decode(), kind) for kind in ("versions", "libraries")]',
  'except Exception:',
  '    sys.exit(3)',
  'jars = []',
  'for text, kind in lists:',
  '    for line in text.splitlines():',
  '        parts = line.split("\\t")',
  '        if len(parts) == 3:',
  '            jars.append((parts[0], os.path.join(os.getcwd(), kind, parts[2])))',
  'if not main or not jars:',
  '    sys.exit(3)',
  'for digest, path in jars:',
  '    sha = hashlib.sha256()',
  '    try:',
  '        with open(path, "rb") as f:',
  '            for block in iter(lambda: f.read(1 << 20), b""):',
  '                sha.update(block)',
  '    except OSError:',
  '        sys.exit(2)',
  '    if sha.hexdigest() != digest:',
  '        sys.exit(2)',
  'here = os.path.dirname(out)',
  'path = " ".join(urllib.parse.quote(os.path.relpath(p, here)) for _, p in jars)',
  'fields = ["Manifest-Version: 1.0", "Main-Class: " + main, "Enable-Native-Access: ALL-UNNAMED", "Class-Path: " + path]',
  'lines = []',
  'for field in fields:',
  '    data = field.encode()',
  '    lines.append(data[:72])',
  '    data = data[72:]',
  '    while data:',
  '        lines.append(b" " + data[:71])',
  '        data = data[71:]',
  'with zipfile.ZipFile(out + ".new", "w") as jar:',
  '    jar.writestr("META-INF/MANIFEST.MF", b"\\r\\n".join(lines) + b"\\r\\n\\r\\n")',
  'os.replace(out + ".new", out)',
  'print("\\n".join(p for _, p in jars))',
]

/**
 * Whether the jar is Paperclip, by its own class, read with Python's zipfile. Not `unzip -l`: on
 * the image's Alpine build, which every plain server runs, unzip is BusyBox's, which exits 0 for an
 * entry the jar doesn't hold, so Mojang's jar was taken for Paperclip and its patch run started a
 * whole server. A jar that won't read is not Paperclip. It holds no single quote, as the lines don't.
 */
const IS_PAPERCLIP = `import sys, zipfile; sys.exit(0 if \\"${PAPERCLIP}\\" in zipfile.ZipFile(sys.argv[1]).namelist() else 1)`

/**
 * The cache script's lines that put the manifest jar in place of Paperclip, after the jar the
 * start runs is known (`file`, the word after `-jar` at `jar`) and before what the cache was made
 * for is worked out. `lfp` is what the manifest jar was made for: Paperclip and every jar on its
 * class path, by size and time. Its state is that, then `new`, `trying` with the starts not yet
 * seen up, `good`, or `bad`.
 */
export const LAUNCH_LINES = [
  `launch=${LAUNCH}; lstate=$launch.state; paperclip=$file`,
  'lfp() { { stat -c "%s %Y" "$paperclip"; while IFS= read -r f; do stat -c "%n %s %Y" "$f"; done < $launch.list; } 2>/dev/null | sha256sum | cut -c1-64; }',
  `lmake() { python3 ${LAUNCH_MAKER} "$paperclip" $launch > $launch.list.new 2>/dev/null; }`,
  `if [ "$file" != $launch ] && command -v python3 >/dev/null 2>&1 && python3 -c "${IS_PAPERCLIP}" "$file" 2>/dev/null && mkdir -p "$(dirname "$launch")"; then`,
  'lphase=; if [ -s $launch ] && [ -s $launch.list ] && [ "$(sed -n 1p $lstate 2>/dev/null)" = "$(lfp)" ]; then lphase=$(sed -n 2p $lstate); fi',
  'if [ -z "$lphase" ]; then',
  'rm -f $launch $launch.list $lstate; lmake; made=$?',
  'if [ $made = 2 ]; then echo "[init] Unpacking Paper before its start"; java -Dpaperclip.patchonly=true -jar "$paperclip" >/dev/null 2>&1; lmake; made=$?; fi',
  'if [ $made = 0 ] && mv -f $launch.list.new $launch.list && printf "%s\\n" "$(lfp)" new > $lstate; then lphase=new; else rm -f $launch $launch.list $launch.list.new $lstate; fi',
  'fi',
  'ltries=0; if [ "$lphase" = trying ]; then ltries=$(sed -n 3p $lstate); case "$ltries" in ""|*[!0-9]*) ltries=1;; esac; fi',
  // The last start from it got as far as taking connections: it works.
  `if [ "$lphase" = trying ] && [ ${LOG} -nt $lstate ] && grep -q "${DONE}" ${LOG} 2>/dev/null; then printf "%s\\n" "$(sed -n 1p $lstate)" good > $lstate; lphase=good; fi`,
  `if [ "$lphase" = trying ] && [ "$ltries" -ge ${TRIES} ]; then printf "%s\\n" "$(sed -n 1p $lstate)" bad > $lstate; lphase=bad; fi`,
  'case "$lphase" in new|trying|good)',
  'if [ "$lphase" != good ]; then printf "%s\\n" "$(sed -n 1p $lstate)" trying $((ltries + 1)) > $lstate; fi',
  'n=0; for w; do n=$((n + 1)); if [ $n = 1 ]; then set --; fi; if [ $n = $((jar + 1)) ]; then w=$launch; fi; set -- "$@" "$w"; done; file=$launch;;',
  'esac',
  'fi',
]
