/**
 * How the admin servers page words what the API reports: a server's state, the runtime it is on,
 * and money. The API sends the domain's own words (`stored`, `fly`); what an admin reads is
 * decided here, and the order states are counted in.
 */
import type { PillStatus } from '../../../../ui'

/** A state as the page shows it: the pill's colour and its word. */
export interface StateWords {
  pill: PillStatus
  label: string
}

/**
 * Every state a listed server can be in, in the order a place's count lists them: what runs
 * first, what is on its way, then what rests, and the trash last. `deleted` is the trash, which
 * the API counts a trashed server as whatever it was doing.
 */
const STATES: ReadonlyArray<readonly [string, StateWords]> = [
  ['running', { pill: 'online', label: 'Running' }],
  ['provisioning', { pill: 'settingUp', label: 'Setting up' }],
  ['starting', { pill: 'starting', label: 'Starting' }],
  ['updating', { pill: 'starting', label: 'Updating' }],
  ['restoring', { pill: 'starting', label: 'Restoring' }],
  ['relocating', { pill: 'starting', label: 'Moving' }],
  ['stopping', { pill: 'stopped', label: 'Stopping' }],
  ['stopped', { pill: 'stopped', label: 'Stopped' }],
  ['storing', { pill: 'sleeping', label: 'Going to rest' }],
  ['stored', { pill: 'sleeping', label: 'Resting' }],
  ['failed', { pill: 'crashed', label: 'Failed' }],
  ['deleted', { pill: 'stopped', label: 'In the trash' }],
]
const BY_STATUS = new Map(STATES)

/** One server's state; a server in the trash reads as that, whatever it was doing. */
export function stateOf(server: { status: string; deleted: boolean }): StateWords {
  const status = server.deleted ? 'deleted' : server.status
  return BY_STATUS.get(status) ?? { pill: 'info', label: status }
}

/** A place's counts by state, in the order above, each worded: "3 running". */
export function countedStates(states: Record<string, number>): Array<StateWords & { key: string }> {
  const known = STATES.map(([status]) => status)
  const order = [...known, ...Object.keys(states).filter((status) => !known.includes(status))]
  return order
    .filter((status) => (states[status] ?? 0) > 0)
    .map((status) => {
      const words = BY_STATUS.get(status) ?? { pill: 'info' as const, label: status }
      return { key: status, pill: words.pill, label: `${states[status]} ${words.label.toLowerCase()}` }
    })
}

/** Where servers run: "Fly · fra". A server bound to no runtime yet says so. */
export function placeName(place: { provider: string | null; region: string }): string {
  if (place.provider === null) return `Not placed yet · ${place.region}`
  return `${place.provider.charAt(0).toUpperCase()}${place.provider.slice(1)} · ${place.region}`
}

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`
