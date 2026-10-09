import { GAME_PORT } from './runtime-spec.ts'

/** Minecraft clients assume 25565, so the address people copy leaves it out. */
export function formatJoinAddress(address: { hostname: string; port: number }): string {
  return address.port === GAME_PORT ? address.hostname : `${address.hostname}:${address.port}`
}
