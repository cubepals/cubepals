/** Console commands the platform itself issues, and parsers for their answers. */

export const SAVE_ALL_FLUSH = 'save-all flush'
export const SAVE_OFF = 'save-off'
export const SAVE_ON = 'save-on'
export const LIST_UUIDS = 'list uuids'

/**
 * A line every player sees in chat, from Cubepals; one line of printable text. `tellraw`, not `say`:
 * `say` names who said it, and over RCON that reads "[Rcon]". Its text is JSON, which every
 * version Blockly runs reads, the ones that read text as SNBT included.
 */
export function announce(message: string): string {
  const text = message.replace(/\p{Cc}/gu, ' ').trim()
  const line = {
    text: '',
    extra: [
      { text: '[Cubepals] ', color: 'aqua' },
      { text, color: 'yellow' },
    ],
  }
  return `tellraw @a ${JSON.stringify(line)}`
}

export interface OnlinePlayers {
  online: number
  max: number
  players: { uuid: string; name: string }[]
}

const LIST_PATTERN = /There are (\d+) of a max of (\d+) players online:?(.*)$/s
const PLAYER_PATTERN = /([A-Za-z0-9_]{1,16}) \(([0-9a-fA-F-]{32,36})\)/g

/** Parses `list uuids`: "There are 1 of a max of 20 players online: Steve (0000…)". */
export function parseOnlinePlayers(output: string): OnlinePlayers | null {
  const match = LIST_PATTERN.exec(output.trim())
  if (!match) return null
  const [, online = '0', max = '0', rest = ''] = match
  const players = [...rest.matchAll(PLAYER_PATTERN)].map(([, name = '', uuid = '']) => ({
    name,
    uuid: normalizeUuid(uuid),
  }))
  return { online: Number(online), max: Number(max), players }
}

/** Minecraft files use dashed lowercase UUIDs; Mojang's API returns them undashed. */
export function normalizeUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return uuid.toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Console input people type is one line of printable text; anything else is refused. */
export function isPlainCommand(command: string): boolean {
  return command.length > 0 && command.length <= 256 && !/\p{Cc}/u.test(command)
}

/** Commands people may not run from Blockly's console, with the reason shown to them. */
export function refusedCommand(command: string): string | null {
  const verb = command.trim().replace(/^\//, '').split(/\s+/)[0]?.toLowerCase()
  if (verb === 'ban-ip' || verb === 'pardon-ip')
    return 'IP bans cannot work on Cubepals: every player reaches your server through the same address. Ban the player instead.'
  if (verb === 'stop') return 'Use the Stop button, so Cubepals knows the server is off on purpose.'
  return null
}
