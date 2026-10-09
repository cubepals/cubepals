/**
 * Datapacks → the world. A server's datapacks are part of its revision, beside its mods, and go
 * into the `datapacks` folder of the world it runs, by a step of Blockly's own before the image
 * starts: the image's `DATAPACKS` never checks what it fetched, and its clean-up removes every
 * zip in the folder, the owner's own among them (itzg/docker-minecraft-server 2026.9.1,
 * `scripts/start-setupDatapack`).
 *
 * Worlds: the datapacks belong to the server, not to one world. Each start puts them into the
 * world it opens, so a world created or switched to later gets them at its first start, before
 * Minecraft makes it: a datapack that shapes terrain shapes it from the first chunk. A world
 * switched away from keeps its copies until it runs again, when it is brought to the server's
 * list like any other. Each world remembers which files Blockly put there (`.blockly-datapacks`
 * beside its `level.dat`), and only those are ever removed: one that came with a world brought
 * back from a download stays. Minecraft enables a datapack it finds new and drops one that is
 * gone, saying so as it starts ("Found new data pack file/…, loading it automatically").
 *
 * Not for: which catalog versions are datapacks (`domain/mods/artifact.ts`, `mods.ts`), or the
 * jars a loader runs (`jars.ts`).
 */

import type { ModArtifact, PinnedMod } from '../domain/mods/artifact.ts'
import type { Loader } from '../domain/revision/revision.ts'
import { DATA_DIR } from './jars.ts'
import { installsAsDatapack } from './mods.ts'

/** The variable listing a revision's datapacks: one per line, `<sha512> <name> <link>`. */
const DATAPACKS_VARIABLE = 'BLOCKLY_DATAPACKS'

/**
 * The name a datapack has in the world's folder: unique to its bytes, as a jar's is, and plain
 * enough to sit between spaces in the list. Minecraft only reads a zip whose name ends `.zip`, and
 * shows it to players as `file/<name>` in `/datapack list`.
 */
export function datapackName(artifact: ModArtifact): string {
  const plain = artifact.fileName.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${artifact.sha512.slice(0, 12)}-${plain}${/\.zip$/i.test(plain) ? '' : '.zip'}`
}

/** The datapacks a revision puts into its world, in the order it lists them. */
export const datapacksOf = (revision: { loader: Loader; mods: readonly PinnedMod[] }): PinnedMod[] =>
  revision.mods.filter((mod) => installsAsDatapack(mod, revision.loader))

/**
 * The variable the step reads. Absent when there are none: a world that had some loses them at its
 * next start, since the step still finds its own record of them.
 */
export function datapacksEnv(
  revision: { loader: Loader; mods: readonly PinnedMod[] },
  artifactUrl: (artifact: ModArtifact) => string,
): Record<string, string> {
  const lines = datapacksOf(revision).map(
    (mod) => `${mod.artifact.sha512} ${datapackName(mod.artifact)} ${artifactUrl(mod.artifact)}`,
  )
  return lines.length === 0 ? {} : { [DATAPACKS_VARIABLE]: lines.join('\n') }
}

/**
 * The step, for every server: with no datapacks listed and none put there before, it does
 * nothing. Files Blockly put there and no longer lists go first. Then each listed one whose bytes
 * aren't the pinned ones is fetched again, and kept only once its SHA-512 is: a download cut short
 * or a file changed where it is published stops the start, which the apply rolls back, rather than
 * running a world on something nobody chose. A file already right is never fetched again.
 */
export const DATAPACKS_STEP = [
  `packs="${DATA_DIR}/$LEVEL/datapacks"; mark="${DATA_DIR}/$LEVEL/.blockly-datapacks";`,
  `if [ -n "$${DATAPACKS_VARIABLE}" ] || [ -f "$mark" ]; then mkdir -p "$packs";`,
  `if [ -f "$mark" ]; then while read -r old; do case "$${DATAPACKS_VARIABLE}" in *" $old "*) ;;`,
  '*) rm -f -- "$packs/$old";; esac; done < "$mark"; fi;',
  `printf '%s\\n' "$${DATAPACKS_VARIABLE}" | while read -r sha name url; do [ -n "$name" ] || continue;`,
  `if [ "$(sha512sum "$packs/$name" 2>/dev/null | cut -d' ' -f1)" != "$sha" ]; then`,
  'curl -fsSL --retry 3 --max-time 300 -o "$packs/$name.part" "$url" &&',
  `[ "$(sha512sum "$packs/$name.part" | cut -d' ' -f1)" = "$sha" ] ||`,
  '{ rm -f "$packs/$name.part"; echo "[blockly] The datapack $name did not download as chosen." >&2; exit 1; };',
  'mv -f "$packs/$name.part" "$packs/$name"; fi; echo "$name"; done > "$mark.new" || exit 1;',
  'mv -f "$mark.new" "$mark"; fi;',
].join(' ')
