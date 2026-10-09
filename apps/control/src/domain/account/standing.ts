/**
 * An account's standing as admins and its owner set it: active, suspended or closed, its plan and
 * restrictions, an admin's limits, and the owner's own choices (extra play, the AFK kick), with
 * which warnings about the month's play were sent.
 */
type AccountStatus = 'active' | 'suspended' | 'terminated'

export interface Restrictions {
  provisioning?: boolean
  publicListing?: boolean
  consoleCommands?: boolean
}

export interface AccountStanding {
  userId: string
  status: AccountStatus
  reason: string | null
  plan: string
  restrictions: Restrictions
  limitOverrides: {
    maxServers?: number
    maxRunning?: number
    includedUnits?: number
    maxSessionMinutes?: number
  }
  /**
   * Play past the plan's included block that the owner has allowed, in meter units. Zero means
   * servers sleep when the block runs out, which is where every account starts: money is the
   * owner's decision, and Blockly never makes it for them.
   */
  extraUnitsAllowed: number
  /**
   * The AFK kick the owner set, in minutes; null leaves the plan's own, and 0 is never. On a plan
   * where play is metered, someone standing still in a loaded chunk spends the owner's money, so
   * it is theirs to set rather than Blockly's to decide — and never kicking, the costliest, is
   * only ever their choice, never a default.
   */
  afkKickMinutes: number | null
  /** The last play warning sent, as `YYYY-MM:percent`; null before any. */
  playWarned: string | null
  /** The last extra-play email sent, as `YYYY-MM:mark` (0, 80 or 100); null before any. */
  extraWarned: string | null
}

export function newStanding(userId: string): AccountStanding {
  return {
    userId,
    status: 'active',
    reason: null,
    plan: 'free',
    restrictions: {},
    limitOverrides: {},
    extraUnitsAllowed: 0,
    afkKickMinutes: null,
    playWarned: null,
    extraWarned: null,
  }
}
