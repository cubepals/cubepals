// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds a server starts on instead of generating one: a template's world, made beforehand and
 * kept as an archive, such as the Arcade's (`ARCADE_WORLD`). A world is made this way by its type:
 * the template names the type, and the world's first start unpacks the archive where the world
 * goes, so everything after is the server's own world, backed up, moved and restored as any is.
 * Beyond what the archive holds, the world generates as the void does. Not the world's datapacks
 * or files, which are carried (`carried.ts`), or how a type is generated (`worlds.ts`).
 */
import type { ModArtifact } from '../domain/mods/artifact.ts'
import { ARCADE_WORLD } from './arcade/maps.ts'
import { DATA_DIR } from './jars.ts'

/** The Arcade's world type: the world `scripts/arcade-world.ts` builds from published maps. */
export const ARCADE_LEVEL = 'blockly:arcade'

const STARTER_WORLDS: Readonly<Record<string, ModArtifact>> = { [ARCADE_LEVEL]: ARCADE_WORLD }

/** The archive a world of this type starts on, or null for a type Minecraft generates. */
export const starterOf = (levelType: string): ModArtifact | null => STARTER_WORLDS[levelType] ?? null

/** Every archive a world starts on, by its bytes: what the store keeps whatever pins it. */
export const STARTER_SHA512S: readonly string[] = Object.values(STARTER_WORLDS).map(
  (artifact) => artifact.sha512,
)

/** Every world type that starts on an archive, by the archive's bytes. */
export const startersBySha512 = (sha512: string): string[] =>
  Object.entries(STARTER_WORLDS)
    .filter(([, artifact]) => artifact.sha512 === sha512)
    .map(([levelType]) => levelType)

/** The archive's sha512 and its link, on one line, as the step reads them. */
const STARTER_VARIABLE = 'BLOCKLY_STARTER'

/**
 * The step. Only on a world's first start, before Minecraft makes it: a world that has its
 * `level.dat` is never touched again. The archive is fetched, checked against its sha512, and
 * unpacked into the world's folder, owned as the volume is; anything else stops the start, so a
 * server never generates a plain world where its template's should be. A link where the world or
 * the archive goes is replaced first (`volume-links.ts`): the step runs as root.
 */
export const STARTER_STEP = [
  `if [ -n "$${STARTER_VARIABLE}" ] && [ ! -f "${DATA_DIR}/$LEVEL/level.dat" ]; then`,
  `sha=\${${STARTER_VARIABLE}%% *}; url=\${${STARTER_VARIABLE}#* }; f="${DATA_DIR}/.blockly-starter.tar.gz";`,
  'unlinked "$LEVEL"; unlinked .blockly-starter.tar.gz;',
  `{ curl -fsSL --retry 3 --max-time 600 -o "$f" "$url" && [ "$(sha512sum "$f" | cut -d ' ' -f 1)" = "$sha" ] &&`,
  `mkdir -p "${DATA_DIR}/$LEVEL" && tar -xzf "$f" -C "${DATA_DIR}/$LEVEL" &&`,
  `chown -R "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" "${DATA_DIR}/$LEVEL" && rm -f "$f"; }`,
  `|| { rm -f "$f"; echo "Cubepals could not fetch the world $LEVEL starts on" >&2; exit 1; }; fi;`,
].join(' ')

/** The variable the step reads, for a world of a type that starts on an archive. */
export function starterEnv(
  levelType: string,
  artifactUrl: (artifact: ModArtifact) => string,
): Record<string, string> {
  const starter = starterOf(levelType)
  return starter === null ? {} : { [STARTER_VARIABLE]: `${starter.sha512} ${artifactUrl(starter)}` }
}
