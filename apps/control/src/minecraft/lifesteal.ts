import type { PinnedMod } from '../domain/mods/artifact.ts'
import { DATA_DIR } from './jars.ts'

/** LifeStealZ's project on Modrinth, as a pinned plugin records it. */
const LIFESTEALZ = 'l8Uv7FzS'

/** The hearts LifeStealZ gives a player it has no record of (its `startHearts`, 10 by default). */
export const START_HEARTS = 10

/** Whether a server's plugins include LifeStealZ, which makes its fresh start a new season. */
export const runsLifeSteal = (mods: readonly PinnedMod[]): boolean =>
  mods.some(
    (m) => m.source.catalog === 'modrinth' && 'projectId' in m.source && m.source.projectId === LIFESTEALZ,
  )

/**
 * One exec that forgets every player's hearts and eliminations: LifeStealZ keeps them, and nothing
 * else, in one SQLite file in its folder, and makes it again, empty, as it starts. It holds the file
 * open while it runs, so what it writes as it stops goes with the old file, not into a new one.
 */
export function resetHeartsCommand(): readonly string[] {
  const database = 'plugins/LifeStealZ/userData.db'
  const files = [database, `${database}-journal`, `${database}-wal`, `${database}-shm`]
  return ['sh', '-c', `cd ${DATA_DIR} && rm -f -- ${files.join(' ')}`]
}
