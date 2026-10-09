/** A world's generation identity: fixed when it is created, independent of server settings. */
export interface World {
  id: string
  serverId: string
  /** The world's directory on the data volume. */
  levelName: string
  /** What the owner calls it. */
  name: string
  seed: string | null
  levelType: string
  hardcore: boolean
  generatedOnVersion: string
}

/** Level names are unique per server; a new world never reuses an old directory. */
export function nextLevelName(existing: readonly string[]): string {
  if (!existing.includes('world')) return 'world'
  let n = 2
  while (existing.includes(`world-${n}`)) n++
  return `world-${n}`
}
