// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plain Minecraft run on Paper (`runsOnPaper`) plays as Minecraft does. Paper changes some of the
 * game on purpose: it closes duplication tricks, stops a piston breaking bedrock, gives hoppers a
 * pause when what they feed is full, counts mobs for spawning its own way, and ticks mobs far from
 * every player less often. Players who built a farm or a machine on Mojang's own server expect it
 * to work the same here, so a plain server turns those back (`SETTINGS`). A Paper server made as one, Smoother survival and every
 * setup with plugins, keeps Paper's own defaults.
 *
 * Each file is written only where the server has none yet: on its first start on Paper, before
 * Paper writes it. Paper fills in every other setting with its own default and keeps what is
 * written here; a server that ran on Paper before keeps the files it has. The step runs as root, so
 * it replaces any link on the way (`volume-links.ts`) and hands what it writes to the volume's owner.
 *
 * Not for the PROXY header or the connection throttle, which every Paper server has
 * (`runtime-spec.ts`), and which find these files already there.
 */
import { DATA_DIR } from './jars.ts'

/**
 * The files, and what each holds, as YAML lines; none holds a single quote. Each setting is Paper's
 * own way back to Minecraft's behaviour, from its "Vanilla-like experience" page
 * (docs.papermc.io/paper/vanilla), less what that page changes only to stop crashes or spam
 * (item, book, packet and join limits), which a group playing never meets. A key an older Paper
 * doesn't have is left alone by it.
 */
const SETTINGS: ReadonlyArray<{ path: string; lines: readonly string[] }> = [
  {
    path: 'config/paper-global.yml',
    lines: [
      'time:',
      '  affects-all-worlds: true',
      'unsupported-settings:',
      '  allow-headless-pistons: true',
      '  allow-permanent-block-break-exploits: true',
      '  allow-piston-duplication: true',
      '  allow-unsafe-end-portal-teleportation: true',
      '  skip-tripwire-hook-placement-validation: true',
      '  update-equipment-on-player-actions: false',
    ],
  },
  {
    path: 'config/paper-world-defaults.yml',
    lines: [
      'chunks:',
      '  delay-chunk-unloads-by: 0s',
      'collisions:',
      '  allow-player-cramming-damage: true',
      '  max-entity-collisions: 2147483647',
      'entities:',
      '  behavior:',
      '    cooldown-failed-beehive-releases: false',
      '    phantoms-do-not-spawn-on-creative-players: false',
      '    phantoms-only-attack-insomniacs: false',
      '    stuck-entity-poi-retry-delay: disabled',
      '  spawning:',
      '    count-all-mobs-for-spawning: true',
      '    max-arrow-despawn-invulnerability: disabled',
      '    per-player-mob-spawns: false',
      'hopper:',
      '  cooldown-when-full: false',
      'misc:',
      '  allow-remote-ender-dragon-respawning: true',
      'unsupported-settings:',
      '  fix-invulnerable-end-crystal-exploit: false',
    ],
  },
  {
    // An activation range of 0 or less marks every entity of that kind always active (Paper's
    // `ActivationRange.initializeEntityActivationState`), so each one ticks fully wherever it is,
    // as on Mojang's own server. The one setting here with a real cost, and the one farms most
    // depend on.
    path: 'spigot.yml',
    lines: [
      'world-settings:',
      '  default:',
      '    max-tnt-per-tick: -1',
      '    entity-activation-range:',
      '      animals: 0',
      '      monsters: 0',
      '      raiders: 0',
      '      misc: 0',
      '      water: 0',
      '      villagers: 0',
      '      flying-monsters: 0',
    ],
  },
]

/** The step, before Paper's own (`PAPER_STEP`), on plain Minecraft run on Paper. */
export const VANILLA_PAPER_STEP = SETTINGS.map(({ path, lines }) =>
  [
    `unlinked ${path}; f=${DATA_DIR}/${path}; if [ ! -e "$f" ]; then mkdir -p "$(dirname "$f")"`,
    `&& printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')} > "$f"`,
    `&& chown -h "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" "$(dirname "$f")" "$f"; fi;`,
  ].join(' '),
).join(' ')
