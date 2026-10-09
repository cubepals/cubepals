import type { PinnedMod } from '../domain/mods/artifact.ts'
import type { Loader } from '../domain/revision/revision.ts'
import { DATA_DIR, diskName, jarsOf } from './jars.ts'

/**
 * What a revision's jars should look like on disk, and one command that reports what is
 * there (§15.2). The image skips a file whose modification time is newer than the link's
 * Last-Modified and never checks its size, so a download cut short stays on disk for good; only
 * hashing what is installed finds it, or a file changed where it is published.
 */
export interface InstallCheck {
  expected: ReadonlyArray<{ name: string; sha512: string; mod: string }>
  command: readonly string[]
}

/** Null when the revision installs no jars: vanilla, or a loader with none chosen. */
export function installCheck(revision: { loader: Loader; mods: readonly PinnedMod[] }): InstallCheck | null {
  const jars = jarsOf(revision.loader)
  if (jars === null || revision.mods.length === 0) return null
  return {
    expected: revision.mods.map((m) => ({
      name: diskName(m.artifact),
      sha512: m.artifact.sha512,
      mod: m.name,
    })),
    // Every installed jar's SHA-512 in sha512sum's format; a missing or empty directory prints nothing.
    command: [
      'sh',
      '-c',
      `cd ${jars.dir} 2>/dev/null || exit 0; for f in *.jar; do [ -e "$f" ] && sha512sum -- "$f"; done; exit 0`,
    ],
  }
}

/**
 * sha512sum's lines: the hash, two spaces, the name. A name holding a backslash or newline is
 * escaped, and its line starts with a backslash.
 */
export function parseInstalled(stdout: string): Map<string, string> {
  const installed = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^(\\?)([0-9a-f]{128}) [ *](.+)$/.exec(line)
    if (match === null) continue
    const [, escaped, sha512 = '', name = ''] = match
    installed.set(
      escaped ? name.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\')) : name,
      sha512,
    )
  }
  return installed
}

/** The mods whose jar is missing or holds other bytes. Jars the revision doesn't list are the image's to remove. */
export function installProblems(check: InstallCheck, installed: ReadonlyMap<string, string>): string[] {
  return check.expected.filter((jar) => installed.get(jar.name) !== jar.sha512).map((jar) => jar.mod)
}

// ─── Packs ──────────────────────────────────────────────────────────────────────────────────

/** Where the image records what it installed from a Modrinth pack (mc-image-helper 1.68.0). */
const PACK_MANIFEST = `${DATA_DIR}/.modrinth-modpack-manifest.json`
const MANIFEST_END = '--- blockly: end of manifest ---'

/**
 * A pack's jars as they should be on disk, and one command that reports the image's own record of
 * what it installed and the hash of every one of them that is there. The image never checks the
 * hashes a pack lists (its downloads are only skipped when the file exists), so a download cut
 * short stays; only hashing finds it.
 */
export interface PackCheck {
  expected: ReadonlyArray<{ path: string; sha512: string }>
  command: readonly string[]
}

export function packCheck(jars: ReadonlyArray<{ path: string; sha512: string }>): PackCheck | null {
  const expected = jars.filter((jar) => isPlainPath(jar.path))
  if (expected.length === 0) return null
  return {
    expected,
    command: [
      'sh',
      '-c',
      `cat ${PACK_MANIFEST} 2>/dev/null; echo; echo '${MANIFEST_END}'; cd ${DATA_DIR} || exit 0; for f in "$@"; do [ -f "$f" ] && sha512sum -- "$f"; done; exit 0`,
      'check',
      ...expected.map((jar) => jar.path),
    ],
  }
}

/**
 * The pack's jars that the image says it installed and that are missing or hold other bytes.
 * One the image's record doesn't list was left out on purpose (a name on its own list of mods
 * made for players' games), which isn't a failure to install.
 */
export function packProblems(check: PackCheck, stdout: string): string[] {
  const [manifestText = '', hashes = ''] = stdout.split(MANIFEST_END)
  let installed: Set<string> | null = null
  try {
    const files = (JSON.parse(manifestText.trim()) as { files?: unknown }).files
    if (Array.isArray(files)) installed = new Set(files.filter((f): f is string => typeof f === 'string'))
  } catch {
    // No record: every expected jar counts.
  }
  const found = parseInstalled(hashes.trim())
  return check.expected
    .filter((jar) => installed === null || installed.has(jar.path))
    .filter((jar) => found.get(jar.path) !== jar.sha512)
    .map((jar) => jar.path)
}

/** A path the check can name on a command line: relative and plain. */
const isPlainPath = (path: string) =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.startsWith('-') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  !/[\u0000-\u001f]/.test(path)

/** The command that removes a pack's wrongly installed jars, for the image to fetch them again. */
export function packCleanup(paths: readonly string[]): readonly string[] {
  return ['rm', '-f', '--', ...paths.filter(isPlainPath).map((path) => `${DATA_DIR}/${path}`)]
}
