import { z } from 'zod'
import { CheckoutConsent } from './agreements.ts'
import type { DenialCode } from './errors.ts'
import type { Loader } from './server.ts'

export const ACCOUNT_STATUSES = ['active', 'suspended', 'terminated'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/** The signed-in person: who they are, and whether they administer the platform. */
export interface MeView {
  userId: string
  name: string
  email: string
  admin: boolean
  standing: { status: AccountStatus; reason: string | null; plan: string }
}

/** An account as admins list it. */
export interface AccountView {
  userId: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: string
  status: AccountStatus
  reason: string | null
  plan: string
  admin: boolean
  /** Live servers, not counting the trash. */
  servers: number
}

export interface AccountDetailView extends AccountView {
  /** The plans an admin can put the account on. */
  plans: string[]
  restrictions: { provisioning: boolean; publicListing: boolean; consoleCommands: boolean }
  /** `includedUnits`: hours of play a month instead of the plan's, as an admin gives them. */
  limits: { maxServers: number | null; maxRunning: number | null; includedUnits: number | null }
  serverList: Array<{ id: string; name: string; slug: string; status: string; deleted: boolean }>
  history: Array<{ at: string; actor: string; action: string; data: Record<string, unknown> }>
}

const userId = z.string().trim().min(1).max(64)

export const AccountSearchInput = z.object({
  search: z.string().trim().max(100).default(''),
  offset: z.number().int().min(0).max(100_000).default(0),
})
export const AccountRef = z.object({ userId })
export const StandingReasonInput = z.object({ userId, reason: z.string().trim().min(1).max(500) })
export const RestrictionsInput = z.object({
  userId,
  provisioning: z.boolean(),
  publicListing: z.boolean(),
  consoleCommands: z.boolean(),
})
export const PlanInput = z.object({ userId, plan: z.string().trim().min(1).max(40) })
export const LimitsInput = z.object({
  userId,
  maxServers: z.number().int().min(0).max(1000).nullable(),
  maxRunning: z.number().int().min(0).max(1000).nullable(),
  /** Hours of play a month instead of the plan's; null returns to the plan's. */
  includedUnits: z.number().int().min(0).max(10_000).nullable(),
})

/**
 * How much play past the plan's included block the owner allows, in meter units: at most the
 * highest ceiling there is (`EXTRA_CEILING` in the control plane), which decides each account's own.
 */
export const AllowExtraPlayInput = z.object({ units: z.number().int().min(0).max(100) })

/**
 * The AFK kick the owner sets, in minutes; null goes back to the plan's own. 0 is never: the most
 * expensive choice, which only the owner makes.
 */
/** A campaign tag past the source (`utm_medium`, `utm_campaign`…), as a short plain word. */
const CampaignTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.+-]{0,79}$/)
  .nullable()
  .default(null)

/**
 * Where an account came from: the `ref` or `utm_source` the link that brought it carried, and the
 * rest of its campaign tags.
 */
export const RecordSourceInput = z.object({
  source: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/),
  medium: CampaignTag,
  campaign: CampaignTag,
  content: CampaignTag,
  term: CampaignTag,
})
export type SignupSource = z.infer<typeof RecordSourceInput>

/**
 * The code a sign-up refused for being full carries (docs/money-guards.md): in an email sign-up's
 * error, and as `?error=SIGNUPS_FULL` on a provider's way back. The web shows its waitlist for it.
 */
export const SIGNUPS_FULL = 'SIGNUPS_FULL'

/** An address left on the waitlist when sign-up is full, with the link that brought it. */
export const JoinWaitlistInput = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  source: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/)
    .nullable()
    .default(null),
})

export const SetAfkKickInput = z.object({
  minutes: z.union([z.literal(0), z.number().int().min(5).max(120)]).nullable(),
})

// ─── The signed-in person's plan ────────────────────────────────────────────────────────────

/** What a plan allows. */
export interface EntitlementsView {
  plan: string
  /** What the plan costs a month, in cents; 0 for Free. */
  monthlyPriceCents: number
  maxServers: number
  maxRunning: number
  allowedMemoryTiers: string[]
  /**
   * The same sizes as somebody reads them: "3 GB · up to 5 players". A size is sold in memory,
   * which is why the number stays, but nobody should have to know what a gigabyte buys.
   */
  sizeLabels: string[]
  /**
   * The play the plan includes each month, in meter units: one unit is an hour on the smallest
   * size, and bigger sizes spend them faster. Null: unlimited.
   */
  includedUnits: number | null
  /** Whether the owner may allow play past the included block, and be charged for it. */
  mayBuyMore: boolean
  /** Whether the owner sets their own AFK kick; otherwise the plan's own applies. */
  mayChooseAfkKick: boolean
  /** Null: never idles out. */
  idleShutdownAfterMinutes: number | null
  /** Minutes a player may idle in game before the server kicks them, unless the owner opts out. */
  playerIdleKickMinutes: number
  /** Minutes one run may last before the server is stopped; null: no cap. */
  maxSessionMinutes: number | null
  /** The server types the plan runs. */
  allowedLoaders: Loader[]
  /** Whether a server may run mods, plugins or a modpack. */
  mayUseMods: boolean
  /** Whether a server may run datapacks, plain Minecraft included. */
  mayUseDatapacks: boolean
  /** Upper bounds a revision is checked against; null: only the settings' own. */
  settingCaps: { maxPlayers: number; viewDistance: number; simulationDistance: number } | null
  /**
   * Backups: `archiveEnabled` is the weekly downloadable history; `downloadsPerDay` is how many
   * downloads the owner may make by hand a day, null for no limit.
   */
  backupPolicy: {
    snapshotsKept: number
    archiveEnabled: boolean
    archiveRetentionDays: number
    downloadsPerDay: number | null
  }
  /** Days without play before a world rests, and before a Free one is deleted (null: never). */
  storeAfterIdleDays: number
  deleteAfterIdleDays: number | null
  mayListPublicly: boolean
  mayUploadCustomMods: boolean
  trashRetentionDays: number
}

export const FEATURES = [
  'create_server',
  'create_archive',
  'restore_archive',
  'upload_mod',
  'list_publicly',
  'console_command',
  'billing',
] as const

export interface AccountOverviewView {
  standing: { status: AccountStatus; reason: string | null }
  plan: {
    key: string
    billed: {
      status: string
      periodEnd: string | null
      cancelAtPeriodEnd: boolean
      planKey: string
      /** Its renewal failed to charge: the plan lasts until then unless the card is fixed. */
      pastDueUntil: string | null
    } | null
  }
  entitlements: EntitlementsView
  /** What the owner has set for themselves, where their plan lets them. */
  settings: { afkKickMinutes: number | null }
  usage: {
    servers: number
    running: number
    /** Play this month, in meter units, and what that is in hours on the sizes actually run. */
    unitsThisMonth: number
    hoursThisMonth: number
    /** Units past the included block the owner has allowed, and what they cost per unit. */
    extraUnitsAllowed: number
    unitCents: number
    /**
     * Extra play: whether the account may allow any now, and if not why, in one sentence; the most
     * it may allow and the limits it picks from; what it has run up this month, in units, and of
     * that what was sent to be billed; and what it owes from a payment that didn't go through.
     */
    extra: {
      may: boolean
      why: string | null
      ceiling: number
      /** The ceiling once a renewal is paid, while it is higher than today's; null otherwise. */
      nextCeiling: number | null
      choices: number[]
      countedUnits: number
      reportedUnits: number
      owedCents: number
      /** Of that, what is paid as a balance (`billing.settle`); the rest by fixing the card. */
      settleCents: number
    }
  }
  /** Each as the API would answer it now. */
  features: Array<{
    feature: (typeof FEATURES)[number]
    available: boolean
    code?: DenialCode
    message?: string
  }>
  plans: Array<{ key: string; entitlements: EntitlementsView }>
}

/** What someone reached for when they chose to pay: the edge of their plan they met. */
export const UPGRADE_REASONS = [
  'modpack',
  'mods',
  'players',
  'size',
  'servers',
  'hours',
  'backups',
  'account',
  'pricing',
] as const
export type UpgradeReason = (typeof UPGRADE_REASONS)[number]

export const CheckoutInput = z.object({
  plan: z.string().trim().min(1).max(40),
  reason: z.enum(UPGRADE_REASONS).default('account'),
  /** The person's agreement, given on the checkout page before the payment page opens. */
  consent: CheckoutConsent,
  /** Where to land after paying: a path in the app, back where the person was. */
  next: z
    .string()
    .max(500)
    .regex(/^\/(?![/\\])/)
    .optional(),
})

/**
 * A plan as the pricing page reads it, for anyone, signed in or not: only what someone deciding
 * whether to pay needs, from the same plan table everything else enforces.
 */
export interface PublicPlan {
  key: string
  name: string
  monthlyPriceCents: number
  /** Hours of play a month; a large server uses two an hour. */
  includedHours: number
  /** Minutes after everyone leaves before a server sleeps, and stops using hours. */
  sleepsAfterMinutes: number | null
  maxServers: number
  /** The most players the plan's largest server holds. */
  maxPlayers: number
  /** Mods, plugins and modpacks. */
  mods: boolean
  /** Every plan downloads its world; `history` is a weekly download kept for a while too. */
  downloads: 'daily' | 'history'
  /** Days without play before a world rests, and before one is deleted (null: never). */
  restsAfterDays: number
  deletedAfterDays: number | null
}
