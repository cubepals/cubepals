import { type Entitlements, planGap, planName, planThatRuns, type Runs } from '../account/entitlements.ts'
import type { AccountStanding } from '../account/standing.ts'
import type { MemoryTier } from '../server/size.ts'

/**
 * The decision half of AccessPolicy: pure, over facts gathered under a lock by the application
 * layer. Every path that spends money or exposes something publicly asks this first.
 */

export type DenialCode =
  | 'deployment_unsupported'
  | 'platform_paused'
  | 'account_suspended'
  | 'restricted'
  | 'email_unverified'
  | 'not_entitled'
  | 'limit_reached'
  | 'rate_limited'

export type Capability =
  | { kind: 'create_server'; memoryTier: MemoryTier }
  /** What the server boots, so a server the plan no longer runs waits, intact, rather than starts. */
  | { kind: 'start_server'; runs: Runs }
  /** Booting a running server again: it keeps the running slot it already holds. */
  | { kind: 'restart_server'; runs: Runs }
  /**
   * A worker's re-check before it spends money on work accepted earlier. Quotas were counted
   * when the request was accepted; only switches, standing and restrictions can change since.
   */
  | { kind: 'continue_provisioning' }
  | { kind: 'continue_starting' }
  | { kind: 'resize_server'; memoryTier: MemoryTier }
  /** Back from the trash: counted like a server the account has, though nothing runs yet. */
  | { kind: 'undelete_server' }
  | { kind: 'manage_access' }
  | { kind: 'console_command' }
  | { kind: 'list_publicly' }
  /** A provider snapshot of the world, and putting one back (§15.4: needs `snapshotsKept`). */
  | { kind: 'snapshot_backup' }
  | { kind: 'restore_backup' }
  | { kind: 'create_archive' }
  | { kind: 'download_archive' }
  | { kind: 'restore_archive' }
  | { kind: 'upload_mod' }
  /**
   * A pack file read and built into one a server can run. Every plan may: a pack is looked at
   * before it is chosen, and choosing one meets the plan that runs modpacks when the server is made.
   */
  | { kind: 'upload_pack' }
  /** A star set on a public server, or taken off it; setting it twice is one change. */
  | { kind: 'star_server' }
  /** A short note left on a public server's guestbook. */
  | { kind: 'leave_note' }
  | { kind: 'billing' }

interface DeploymentSupport {
  archives: boolean
  billing: boolean
}

export interface PlatformControls {
  provisioningEnabled: boolean
  startsEnabled: boolean
  publicListingEnabled: boolean
  uploadsEnabled: boolean
  /** Whether worlds nobody plays rest in the archive store. */
  storingEnabled: boolean
  /** Whether worlds past their plan's keeping are deleted. */
  expiringEnabled: boolean
  maxServers: number
  maxRunningServers: number
  /** Free accounts before sign-up is full (`AccountService.admits`); the policy doesn't read it. */
  maxFreeAccounts: number
  /** What a day may cost, in cents, before the spend watchdog pauses (`operations/schedules/spend.ts`). */
  dailySpendLimitCents: number
}

export interface PolicyFacts {
  deployment: DeploymentSupport
  controls: PlatformControls
  /** The most servers the provider can hold at their busiest; null when it has no limit. */
  serverCeiling: number | null
  standing: AccountStanding
  emailVerified: boolean
  entitlements: Entitlements
  /** Live servers the account owns, and how many of them are running or on their way. */
  owned: { servers: number; running: number }
  global: { servers: number; running: number }
  createsInLastHour: number
  /** Play this month in meter units (`domain/account/meter.ts`), open runs counted up to now. */
  unitsThisMonth: number
  /** Units past the included block the owner has allowed themselves to be charged for. */
  extraUnitsAllowed: number
  /** What the account itself did of the capability's rate-limited kind in the last minute. */
  actionsInLastMinute: number
}

/**
 * Console commands, access changes, stars and notes an account makes a minute before it waits
 * (§15.1, §15.5): enough for a person at a keyboard, not for a script flooding a server. A note
 * is a sentence someone writes, so a few a minute is already a lot.
 */
export const PER_MINUTE = { console_command: 20, manage_access: 30, star_server: 30, leave_note: 3 } as const

export type RateLimited = keyof typeof PER_MINUTE

export type Decision = { ok: true } | { ok: false; code: DenialCode; message: string }

const deny = (code: DenialCode, message: string): Decision => ({ ok: false, code, message })
const OK: Decision = { ok: true }

const NEEDS_ARCHIVES: ReadonlySet<Capability['kind']> = new Set([
  'create_archive',
  'download_archive',
  'restore_archive',
  'upload_mod',
  'upload_pack',
])

export function evaluate(facts: PolicyFacts, capability: Capability): Decision {
  const { deployment, controls, standing, entitlements } = facts

  // 1. What this deployment can do at all.
  if (NEEDS_ARCHIVES.has(capability.kind) && !deployment.archives)
    return deny('deployment_unsupported', 'Durable archives are not available on this Cubepals deployment.')
  if (capability.kind === 'billing' && !deployment.billing)
    return deny('deployment_unsupported', 'Billing is not available on this Cubepals deployment.')

  // 2. Platform kill switches.
  const provisions = capability.kind === 'create_server' || capability.kind === 'continue_provisioning'
  const starts =
    capability.kind === 'start_server' ||
    capability.kind === 'restart_server' ||
    capability.kind === 'continue_starting' ||
    capability.kind === 'restore_archive'
  if (provisions && !controls.provisioningEnabled)
    return deny('platform_paused', 'Creating servers is paused for a moment. Try again soon.')
  if (starts && !controls.startsEnabled)
    return deny('platform_paused', 'Starting servers is paused for a moment. Try again soon.')
  if (capability.kind === 'list_publicly' && !controls.publicListingEnabled)
    return deny('platform_paused', 'The public directory is paused for a moment.')
  if ((capability.kind === 'upload_mod' || capability.kind === 'upload_pack') && !controls.uploadsEnabled)
    return deny('platform_paused', 'Uploads are paused for a moment.')

  // 3. Account standing. A suspended owner can still say who may join (§15.1: "standing not
  // terminated"), so a griefer can be banned while the account is looked at.
  if (standing.status === 'terminated') return deny('account_suspended', 'This account is closed.')
  if (standing.status !== 'active' && capability.kind !== 'manage_access')
    return deny('account_suspended', 'Your account is suspended. Contact support to restore it.')

  // 4. Restrictions on this account.
  const r = standing.restrictions
  if ((provisions || starts) && r.provisioning)
    return deny('restricted', 'Starting and creating servers is turned off for this account.')
  if (capability.kind === 'list_publicly' && r.publicListing)
    return deny('restricted', 'Public listing is turned off for this account.')
  if (capability.kind === 'console_command' && r.consoleCommands)
    return deny('restricted', 'The console is read-only for this account.')

  // Writing where strangers read it takes an address someone confirmed, as making a server does.
  if ((capability.kind === 'create_server' || capability.kind === 'leave_note') && !facts.emailVerified)
    return deny('email_unverified', 'Confirm your email address first — we sent you a link.')

  // 5. Entitlements.
  switch (capability.kind) {
    case 'create_server':
    case 'resize_server':
      if (!entitlements.allowedMemoryTiers.includes(capability.memoryTier))
        return deny('not_entitled', 'Your plan does not include servers this size.')
      break
    // A size the plan sold before still starts: changing the plan table never breaks a server.
    // What a plan doesn't run at all — mods on Free after a paid plan ends — waits for the plan
    // that does, with its world kept as it was: nothing is converted or taken off it.
    case 'start_server':
    case 'restart_server': {
      const gap = planGap(entitlements, capability.runs, 'startable')
      if (gap === 'size') return deny('not_entitled', 'Your plan does not include servers this size.')
      if (gap !== null) {
        const paid = planThatRuns(capability.runs)
        const what = gap === 'mods' ? 'Mods, plugins and modpacks come' : 'This server’s type comes'
        const where = paid === null ? 'with a paid plan' : `with ${planName(paid)}`
        return deny('not_entitled', `${what} ${where}. Its world is safe, and it starts again ${where}.`)
      }
      break
    }
    case 'list_publicly':
      if (!entitlements.mayListPublicly)
        return deny('not_entitled', 'Your plan does not include public listing.')
      break
    case 'snapshot_backup':
    case 'restore_backup':
      if (entitlements.backupPolicy.snapshotsKept === 0)
        return deny('not_entitled', 'Your plan does not include backups.')
      break
    // Every plan downloads its own world; how many a day is the service's to count (§ backups).
    case 'upload_mod':
      if (!entitlements.mayUploadCustomMods)
        return deny('not_entitled', 'Your plan does not include uploading mods.')
      break
  }

  // After a downgrade an account can have more servers than its plan: they stay, and none of
  // them starts until the rest fit.
  if (capability.kind === 'start_server' && facts.owned.servers > entitlements.maxServers)
    return deny(
      'limit_reached',
      `Your plan includes ${entitlements.maxServers} server${plural(entitlements.maxServers)}, and you have ${facts.owned.servers}. Delete ${facts.owned.servers - entitlements.maxServers} to start one.`,
    )
  if (capability.kind === 'undelete_server' && facts.owned.servers >= entitlements.maxServers)
    return deny(
      'limit_reached',
      `Your plan includes ${entitlements.maxServers} server${plural(entitlements.maxServers)}. Delete one to restore this.`,
    )
  if (capability.kind === 'create_server') {
    if (facts.owned.servers >= entitlements.maxServers)
      return deny(
        'limit_reached',
        `Your plan includes ${entitlements.maxServers} server${plural(entitlements.maxServers)}.`,
      )
    if (facts.createsInLastHour >= entitlements.createsPerHour)
      return deny('rate_limited', 'You have created several servers in the last hour. Try again later.')
  }
  if (capability.kind === 'console_command' && facts.actionsInLastMinute >= PER_MINUTE.console_command)
    return deny('rate_limited', 'That is a lot of commands at once. Wait a minute, then send more.')
  if (capability.kind === 'manage_access' && facts.actionsInLastMinute >= PER_MINUTE.manage_access)
    return deny('rate_limited', 'That is a lot of access changes at once. Wait a minute, then make more.')
  if (capability.kind === 'star_server' && facts.actionsInLastMinute >= PER_MINUTE.star_server)
    return deny('rate_limited', 'That is a lot of stars at once. Wait a minute, then try again.')
  if (capability.kind === 'leave_note' && facts.actionsInLastMinute >= PER_MINUTE.leave_note)
    return deny('rate_limited', 'That is a lot of notes at once. Wait a minute, then write more.')
  // A new server boots as part of being created, so it counts against running servers too. A
  // restart is already counted among them.
  if (
    (capability.kind === 'start_server' || capability.kind === 'create_server') &&
    facts.owned.running >= entitlements.maxRunning
  )
    return deny(
      'limit_reached',
      `Your plan runs ${entitlements.maxRunning} server${plural(entitlements.maxRunning)} at a time. Stop another one first.`,
    )
  if (
    (capability.kind === 'start_server' ||
      capability.kind === 'create_server' ||
      capability.kind === 'restart_server') &&
    entitlements.includedUnits !== null &&
    facts.unitsThisMonth >= entitlements.includedUnits + facts.extraUnitsAllowed
  )
    return deny(
      'limit_reached',
      entitlements.mayBuyMore && facts.extraUnitsAllowed === 0
        ? 'You have used this month’s play time. Allow more in your account, or wait for the 1st.'
        : facts.extraUnitsAllowed > 0
          ? 'You have used the play time you allowed this month. Raise it in your account, or wait for the 1st.'
          : 'You have used this month’s play time. It resets on the 1st.',
    )

  // 6. Global caps: the platform's own guard against runaway provisioning. A cap, so
  // `limit_reached` (§15.5: each step its own code); the kill switches are `platform_paused`.
  if (
    (capability.kind === 'create_server' || capability.kind === 'undelete_server') &&
    facts.global.servers >= Math.min(controls.maxServers, facts.serverCeiling ?? Number.POSITIVE_INFINITY)
  )
    return deny('limit_reached', 'Cubepals is full right now. Try again soon.')
  if (
    (capability.kind === 'create_server' || capability.kind === 'start_server') &&
    facts.global.running >= controls.maxRunningServers
  )
    return deny('limit_reached', 'Cubepals is busy right now. Try again in a few minutes.')

  return OK
}

const plural = (n: number) => (n === 1 ? '' : 's')
