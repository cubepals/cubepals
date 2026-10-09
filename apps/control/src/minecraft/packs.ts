import type { MemoryTier } from '../domain/server/size.ts'
import { serverEnvironment } from './mods.ts'

/**
 * What Blockly can tell about a modpack before it has ever run one (§15.6).
 *
 * The honest summary of `docs/minecraft-capacity-research.md`: three packs were measured on real
 * machines, and none of them needed more than a 4 GB box. Cobblemon (32 mods, 158 MB of jars)
 * idled at 567 MB of live heap and finished a pregen at 639 MB; Pixelmon (13 mods, 461 MB) at
 * 696 MB and 971 MB; COBBLEVERSE (115 mods, 344 MB) at 987 MB and 1.14 GB. Mod count predicted
 * nothing — thirteen Pixelmon mods out-cost a hundred and fifteen COBBLEVERSE ones — and two of
 * the five packs tried could not boot as dedicated servers at all.
 *
 * So there is no number to compute here, only a starting point to choose. The research's own
 * conclusion is that a pack is unverified until it has booted once, which is what the
 * out-of-memory path is for: a server that runs out of room is offered the next size in one
 * press rather than being sized for the worst case before anyone plays on it.
 */

/**
 * The size a modpack starts on, from the only thing a catalogue says for free: its own tags.
 *
 * `lightweight` is an author saying this is vanilla with a few mods on top, which the smallest
 * size runs — Cobblemon says it, and its measured live heap is a fraction of that box. A
 * `kitchen-sink` is the other end, and takes the large size: 6 GB ran on the same four-core
 * machine as 8 GB, so it is no longer sold.
 * Everything else takes the middle, which is where every pack measured actually sat.
 *
 * It is a claim by whoever published the pack, not a measurement, and the first boot is what
 * settles it. Only a pack that says it is everything at once starts large.
 */
export function packTier(categories: readonly string[] = []): MemoryTier {
  if (categories.includes('kitchen-sink')) return '8g'
  if (categories.includes('lightweight')) return '3g'
  return '4g'
}

/** What a pack that says so is: a server's own, which plain Minecraft joins. */
const FOR_SERVERS: readonly string[] = ['server_only', 'dedicated_server_only', 'server_only_client_optional']

/**
 * Where a pack is played, from what its catalogue says across its versions: `client` when every
 * one is for a player's own game, `server` when the ones a server can run all say they are made
 * for servers, and `both` — everyone playing installs it too — otherwise. Warier than for one
 * mod: a whole pack that says either side can run it can still carry blocks a plain game can't
 * show, and a friend turned away at the door costs more than one who installed a pack for
 * nothing. A catalogue that says nothing is the common case, both.
 */
export function packEnvironment(environments: readonly string[] = []): 'both' | 'server' | 'client' {
  const runs = environments.filter((where) => serverEnvironment(where) !== null)
  if (environments.length > 0 && runs.length === 0) return 'client'
  return runs.length > 0 && runs.every((where) => FOR_SERVERS.includes(where)) ? 'server' : 'both'
}

/**
 * Whether a pack is one to suggest for a server before anybody types: one people play together,
 * or one made for servers. A pack made for players' own games that also publishes a server
 * version is found by its name, not suggested: Sodium Plus has 65 versions for players' games
 * and one for servers, and the downloads that would rank it are players'.
 */
export function suggestedForServers(environments: readonly string[] = []): boolean {
  const where = packEnvironment(environments)
  return where === 'both' || (where === 'server' && environments.every((e) => serverEnvironment(e) !== null))
}

/**
 * Where a pack keeps the list of mods it leaves each player to download by hand: Missing Mods
 * Checker's, which opens a window listing them. Better MC's Modrinth edition ships it with 34
 * mods that are on CurseForge alone (2026-09-24).
 */
export const HAND_DOWNLOADS = 'overrides/config/missing_mods_checker.json'

/**
 * The mods a pack leaves each player to download by hand, by name, from that list. A server can
 * neither download them nor show the window that asks, so a pack with any can't run as one:
 * Better MC's first start stopped at the window, and without the window, at the first missing
 * piece. Anything but a list of named entries says nothing.
 */
export function handDownloads(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((entry: unknown) =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { displayName?: unknown }).displayName === 'string'
      ? [(entry as { displayName: string }).displayName]
      : [],
  )
}

/**
 * Files of a pack that run as code besides its mods: jars and classes elsewhere, native libraries,
 * and scripts a shell or a mod runs (KubeJS, CraftTweaker). Nothing of a pack is ever run by
 * Blockly; a reviewer offering a pack by name is shown these, and none of them refuses a pack.
 */
export function runsAsCode(path: string): boolean {
  if (/^(server-)?overrides\/mods\/[^/]+\.jar$/i.test(path)) return false
  return /\.(jar|class|sh|bat|cmd|ps1|exe|dll|so|dylib|py|js|mjs|zs|groovy|lua)$/i.test(path)
}
