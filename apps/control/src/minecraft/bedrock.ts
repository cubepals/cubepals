// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about letting Bedrock players into a Paper server. Geyser runs once, on the
 * edge, and hands each Bedrock player to the server as a Java player carrying Floodgate's data;
 * the server needs Floodgate (MIT) to take that player in without a Java account, the key it shares
 * with the edge, and chat signing off, since Bedrock players have no signing key. Geyser speaks one
 * Java release, so a server on another one also needs ViaVersion, and ViaBackwards where the server
 * is the newer. Which server gets what is `app/compat/`'s; the player's name and UUID are
 * `@blockly/contracts`' (`bedrock.ts`).
 *
 * The key file is readable by every plugin the server runs, the owner's own included, so the key is
 * not what keeps a Bedrock login honest: the edge refuses Floodgate data that did not come from
 * Cubepals' own Geyser. The start still keeps the key out of the process's environment.
 *
 * Not for Geyser's own configuration, or how the edge routes Bedrock joins (apps/edge).
 */
import type { PinnedMod } from '../domain/mods/artifact.ts'
import { DATA_DIR } from './jars.ts'
import { runsPlugin, VIABACKWARDS, VIAVERSION } from './mods.ts'
import { compareVersions } from './versions.ts'

/** Floodgate's project id in the GeyserMC downloads (`infra/geysermc/`), as a pinned plugin records it. */
export const FLOODGATE = 'floodgate'

/** The one Java release Geyser speaks. A server on any other needs Via to take Geyser's players. */
export const GEYSER_JAVA_VERSION = '26.3'

/**
 * Whether Bedrock players can join a server on `gameVersion` whose owner lets other versions in or
 * not. Geyser's game is `GEYSER_JAVA_VERSION`; on any other release the server needs ViaVersion to
 * take it, and an owner who let no other version in has not asked for that.
 */
export const bedrockAvailable = (gameVersion: string, otherVersionsOff: boolean): boolean =>
  !otherVersionsOff || compareVersions(gameVersion, GEYSER_JAVA_VERSION) === 0

/**
 * The plugins a Paper server on `gameVersion` runs to let Bedrock players in, by project id:
 * Floodgate, ViaVersion where the release is not Geyser's, and ViaBackwards where it is newer.
 */
export function bedrockPlugins(gameVersion: string): string[] {
  const against = compareVersions(gameVersion, GEYSER_JAVA_VERSION)
  return [FLOODGATE, ...(against === 0 ? [] : [VIAVERSION]), ...(against > 0 ? [VIABACKWARDS] : [])]
}

/** The secret that holds the key as base64, for the start's step to write. */
export const FLOODGATE_KEY_ENV = 'BLOCKLY_FLOODGATE_KEY'

/** Where Floodgate reads the key it shares with the edge. */
export const FLOODGATE_KEY_FILE = 'plugins/floodgate/key.pem'
/** Where the volume remembers that a start wrote the key, so turning Bedrock off can take it away. */
const MARK = '.blockly-bedrock'

/**
 * The step, on a server that can run Floodgate: with the key, it is written (as bytes, 16 of them),
 * and handed to the volume's owner, since Floodgate writes its settings beside it. Without it, a key
 * an earlier start wrote goes. Either way the variable is unset before the image starts the server. Runs as root, so it replaces any link on the way (`volume-links.ts`),
 * and never prints the key.
 */
export const BEDROCK_STEP = [
  `unlinked ${FLOODGATE_KEY_FILE}; unlinked ${MARK}; k=${DATA_DIR}/${FLOODGATE_KEY_FILE}; m=${DATA_DIR}/${MARK};`,
  `if [ -n "$${FLOODGATE_KEY_ENV}" ]; then mkdir -p "$(dirname "$k")"`,
  `&& printf %s "$${FLOODGATE_KEY_ENV}" | base64 -d > "$k" && chmod 600 "$k" && echo ours > "$m"`,
  `&& chown -h "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" "$(dirname "$(dirname "$k")")" "$(dirname "$k")" "$k" || exit 1;`,
  `elif [ -f "$m" ]; then rm -f "$k" "$m"; fi;`,
  // The key is on the volume now; the server and its plugins start without it in their environment.
  `unset ${FLOODGATE_KEY_ENV};`,
].join(' ')

/**
 * What a start adds to the spec for Bedrock players: with Floodgate among the plugins it places and
 * a key to give it, the key as a secret (never in the environment, which drift and logs see) and
 * chat unsigned, since Bedrock players have no signing key; otherwise chat stays signed, so a
 * plugin may block a message but never pass off another as the player's own.
 */
export function bedrockSpec(
  placed: readonly PinnedMod[] | undefined,
  key: string | null | undefined,
): { env: Record<string, string>; secrets: Record<string, string> } {
  if (key == null || placed === undefined || !runsPlugin(placed, FLOODGATE))
    return { env: { ENFORCE_SECURE_PROFILE: 'TRUE' }, secrets: {} }
  return { env: { ENFORCE_SECURE_PROFILE: 'FALSE' }, secrets: { [FLOODGATE_KEY_ENV]: key } }
}
