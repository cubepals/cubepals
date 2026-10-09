import type { Loader } from '../revision/revision.ts'
import type { MemoryTier } from '../server/size.ts'

/** What a plan allows. Plan facts only: whether a deployment supports a feature is separate. */
export interface Entitlements {
  plan: string
  /**
   * What the plan costs a month, in US cents, as people read it on the pricing page. The billing
   * provider's product charges it (Polar), and the two must say the same: the provider is where it
   * is set, this is where Blockly says it.
   */
  monthlyPriceCents: number
  maxServers: number
  maxRunning: number
  /** The sizes a server can be created or resized to. */
  allowedMemoryTiers: readonly MemoryTier[]
  /**
   * Sizes the plan sold before and sells no more. A server already on one keeps starting on it,
   * and moves to an offered size at its next change: a plan change never breaks a server.
   */
  legacyMemoryTiers: readonly MemoryTier[]
  /**
   * The play a plan includes each month, in meter units (`meter.ts`): one unit is an hour on the
   * smallest size, and bigger sizes spend them faster, in proportion to what they cost. Null
   * means unlimited, which no plan Blockly sells is any more.
   */
  includedUnits: number | null
  /** Whether an owner may allow play past the included block, and be charged for it. */
  mayBuyMore: boolean
  /**
   * Whether the owner sets their own AFK kick, never included. Someone standing still spends the
   * owner's hours, so on a plan with room to spend it is their call; Free keeps Blockly's.
   */
  mayChooseAfkKick: boolean
  /** Null means the server never idles out. */
  idleShutdownAfterMinutes: number | null
  /**
   * Minutes a player may be idle in game before Minecraft kicks them. Every plan kicks: an idle
   * player keeps a server awake and spends play time, so never kicking is the most expensive way
   * to run one, and only its owner can choose it (`AccountStanding.afkKickMinutes`).
   */
  playerIdleKickMinutes: number
  /** Minutes a server may run in one go before it is stopped, after two warnings; null: no cap. */
  maxSessionMinutes: number | null
  /** The server types the plan runs. */
  allowedLoaders: readonly Loader[]
  /**
   * Whether a server may run anything past plain Minecraft: mods, plugins or a modpack. Plain
   * Paper is plain Minecraft to its players; Paper with a plugin is not.
   */
  mayUseMods: boolean
  /**
   * Whether a server may run datapacks: on plain Minecraft too, which stays plain with them, and
   * players install nothing.
   */
  mayUseDatapacks: boolean
  /**
   * Upper bounds on settings, checked when a revision is made: a value above one is refused,
   * never lowered. Null: only the settings' own bounds.
   */
  settingCaps: { maxPlayers: number; viewDistance: number; simulationDistance: number } | null
  /** How far from the world's center play may go, in blocks (a radius); null: Minecraft's own. */
  worldRadius: number | null
  /**
   * `snapshotsKept`: daily snapshots, restorable in place. Every plan can download its world:
   * `downloadsPerDay` caps how many downloads are made a day (null: no cap), each kept
   * `archiveRetentionDays`. `archiveEnabled`: a weekly download made on its own, the history.
   */
  backupPolicy: {
    snapshotsKept: number
    archiveEnabled: boolean
    archiveRetentionDays: number
    downloadsPerDay: number | null
  }
  mayListPublicly: boolean
  mayUploadCustomMods: boolean
  trashRetentionDays: number
  /**
   * The disk every server starts on, in GB, and the most one grows to. Sized for the world, not
   * the machine: a world grows about 10 KB a chunk explored, and a new one is a few MB,
   * so a large server starts on the same disk and grows like any other. A disk grows at the next
   * start once its world leaves less than a fifth of it, or 1.5 GB, free, to leave the world a third
   * of it again: a disk never runs full, and never costs much more than its world needs.
   * `paidForGb` is the world data across an account's servers the plan is sized for; past it
   * admins are told. Players never are.
   */
  storage: { startGb: number; mostGb: number; paidForGb: number }
  /**
   * Days without play before a world rests in the archive store and its server lets go of
   * compute and storage: a world nobody plays holds no disk. A join still wakes it, from the
   * stored copy.
   */
  storeAfterIdleDays: number
  /**
   * Days without play after which a world is deleted, after warnings at 30 and 7 days; null:
   * kept for as long as the plan is. Only where an admin turned it on.
   */
  deleteAfterIdleDays: number | null
  /** Server creations allowed per rolling hour. */
  createsPerHour: number
}

export interface LimitOverrides {
  maxServers?: number
  maxRunning?: number
  /** An account given more play than its plan includes, by an admin rather than by paying. */
  includedUnits?: number
  /**
   * A cap on how long one run lasts, where an admin holds this one account to it (an AFK farm
   * that defeats the kick). No plan caps a run: the month's hours already bound what it costs.
   */
  maxSessionMinutes?: number
}

const EVERY_LOADER: readonly Loader[] = ['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge']

// The plan table is product policy. Change values here; nothing else encodes them.
//
// Free is plain Minecraft bounded by its hours. Monthly hours already bound a free server's
// running time, so there is no cap on how long one run lasts: the AFK kick and the idle stop end
// a forgotten one.
const PLANS: Record<string, Entitlements> = {
  free: {
    plan: 'free',
    monthlyPriceCents: 0,
    maxServers: 1,
    maxRunning: 1,
    allowedMemoryTiers: ['3g'],
    legacyMemoryTiers: ['2g', '4g'],
    includedUnits: 20,
    mayBuyMore: false,
    mayChooseAfkKick: false,
    idleShutdownAfterMinutes: 10,
    playerIdleKickMinutes: 15,
    maxSessionMinutes: null,
    // Plain Minecraft: what Free sells is a world friends join with nothing to install. Mods,
    // plugins and modpacks are where a group wants more, and fail in more ways than one person
    // can support for free, so they come with a paid plan.
    allowedLoaders: ['vanilla', 'paper'],
    mayUseMods: false,
    // Open: whether plain Minecraft with a datapack stays Free is the owner's to decide. Until
    // then a datapack counts as a mod.
    mayUseDatapacks: false,
    // A 2,500-block radius keeps a fully explored world near 1 GB, at about 10.4 KB a chunk.
    settingCaps: { maxPlayers: 5, viewDistance: 8, simulationDistance: 6 },
    worldRadius: 2500,
    // Your world is yours: one download a day, kept a week. The weekly history is Plus's.
    backupPolicy: { snapshotsKept: 3, archiveEnabled: false, archiveRetentionDays: 7, downloadsPerDay: 1 },
    mayListPublicly: true,
    mayUploadCustomMods: false,
    trashRetentionDays: 7,
    // A 2,500-block world explored to its border is about 1 GB, with the server's own files.
    storage: { startGb: 3, mostGb: 3, paidForGb: 3 },
    // A group that plays every week never meets a slower wake.
    storeAfterIdleDays: 14,
    // A year, and a download offered twice before: nothing free is kept forever.
    deleteAfterIdleDays: 365,
    createsPerHour: 3,
  },
  plus: {
    plan: 'plus',
    monthlyPriceCents: 1500,
    maxServers: 3,
    maxRunning: 2,
    // 6 GB ran on the same four-core 8 GB machine as 8 GB and cost the same, so it isn't sold.
    allowedMemoryTiers: ['3g', '4g', '8g'],
    legacyMemoryTiers: ['2g', '6g'],
    // 60 included hours; a large server uses two an hour (meter.ts). Past `storage.paidForGb` of
    // worlds an account is an admin alert.
    includedUnits: 60,
    // Extra hours (25¢ each, up to a limit the owner sets) wait until billing meters them end to
    // end: allowing play nobody is billed for is no better than a surprise bill. Until then a server sleeps at the block, and the owner's cap stays at zero.
    mayBuyMore: false,
    mayChooseAfkKick: true,
    // Joining wakes a server, so an empty one waiting an hour only spends the owner's hours.
    idleShutdownAfterMinutes: 15,
    playerIdleKickMinutes: 15,
    maxSessionMinutes: null,
    allowedLoaders: EVERY_LOADER,
    mayUseMods: true,
    mayUseDatapacks: true,
    settingCaps: null,
    // Far past where people play, and it keeps a world within the disk Plus grows it to.
    worldRadius: 10_000,
    backupPolicy: {
      snapshotsKept: 14,
      archiveEnabled: true,
      archiveRetentionDays: 30,
      downloadsPerDay: null,
    },
    mayListPublicly: true,
    mayUploadCustomMods: true,
    trashRetentionDays: 30,
    storage: { startGb: 5, mostGb: 20, paidForGb: 10 },
    storeAfterIdleDays: 30,
    deleteAfterIdleDays: null,
    createsPerHour: 10,
  },
}

/**
 * How long any plan may need a snapshot, in days (§8: a provider's snapshot retention is set to
 * the longest entitlement). A plan keeps `snapshotsKept` of them, at most one scheduled a day, and
 * a deleted server's snapshots last through its trash, so a plan can need one for
 * `snapshotsKept + trashRetentionDays` days.
 */
export function longestSnapshotNeedDays(): number {
  return Math.max(...Object.values(PLANS).map((p) => p.backupPolicy.snapshotsKept + p.trashRetentionDays))
}

/** The plans someone pays for; every other account is on free. */
export const PAID_PLANS: readonly string[] = Object.keys(PLANS).filter((plan) => plan !== 'free')

/** Every plan Blockly has, free first. */
export const PLAN_KEYS: readonly string[] = ['free', ...PAID_PLANS]

/** Whether a server of this size may start on the plan: one it offers, or one it sold before. */
export const runsOn = (entitlements: Entitlements, tier: MemoryTier): boolean =>
  entitlements.allowedMemoryTiers.includes(tier) || entitlements.legacyMemoryTiers.includes(tier)

export function entitlementsFor(plan: string, overrides: LimitOverrides = {}): Entitlements {
  const base = PLANS[plan] ?? PLANS.free
  if (base === undefined) throw new Error('The free plan must exist')
  return {
    ...base,
    maxServers: overrides.maxServers ?? base.maxServers,
    maxRunning: overrides.maxRunning ?? base.maxRunning,
    includedUnits: overrides.includedUnits ?? base.includedUnits,
    maxSessionMinutes: overrides.maxSessionMinutes ?? base.maxSessionMinutes,
  }
}

/** What a server runs, as a plan sees it: its size, its type, and whether anything is added. */
export interface Runs {
  tier: MemoryTier
  loader: Loader
  /** Mods, plugins or a modpack. */
  modded: boolean
  /** Datapacks, which a plan judges apart from mods. */
  datapacks?: boolean
}

/** Why a plan can't run something. */
export type PlanGap = 'size' | 'server_type' | 'mods' | 'datapacks'

/**
 * Whether a plan runs something, and what stands in the way when it doesn't: the one rule the
 * create flow, revisions, restores and starts all ask. `sizes: 'offered'` is for making or
 * resizing a server; `'startable'` also lets a size the plan sold before keep starting.
 */
export function planGap(plan: Entitlements, runs: Runs, sizes: 'offered' | 'startable'): PlanGap | null {
  if (runs.modded && !plan.mayUseMods) return 'mods'
  if (runs.datapacks === true && !plan.mayUseDatapacks) return 'datapacks'
  if (!plan.allowedLoaders.includes(runs.loader)) return 'server_type'
  const fits = sizes === 'offered' ? plan.allowedMemoryTiers.includes(runs.tier) : runsOn(plan, runs.tier)
  return fits ? null : 'size'
}

/** The paid plan that runs something, for where Blockly says what would: null when none does. */
export function planThatRuns(runs: Runs): string | null {
  return PAID_PLANS.find((plan) => planGap(entitlementsFor(plan), runs, 'offered') === null) ?? null
}

/** "Plus", for a plan key: how a plan is named wherever Blockly says what one includes. */
export const planName = (key: string): string => `${key.charAt(0).toUpperCase()}${key.slice(1)}`

/**
 * What comes with which plan, said once: "Mods, plugins and modpacks come with Plus." A plan table
 * where no plan sells it, which only an admin's own could be, says "need a paid plan".
 */
export function comesWith(what: string, paidPlan: string | null): string {
  return `${what} ${paidPlan === null ? 'need a paid plan' : `come with ${planName(paidPlan)}`}.`
}

/** What a plan gap for something added to Minecraft names, as `comesWith` words it. */
export function addedLabel(gap: 'mods' | 'datapacks', modpack: boolean): string {
  if (gap === 'datapacks') return 'Datapacks'
  return modpack ? 'Modpacks' : 'Mods and plugins'
}

/**
 * How much of a disk a world brought back from a download may take: it unpacks a little bigger
 * (region files are compressed already), beside the server's own files.
 */
export const WORLD_SHARE_OF_DISK = 0.6

/**
 * The disk a server needs to bring back a world download of `worldBytes`, where the one it has is
 * too small and its plan can grow that far; null when its disk will do, or no disk it may have would.
 */
export function diskForWorld(plan: Entitlements, currentGb: number, worldBytes: number): number | null {
  const needed = Math.ceil(worldBytes / 2 ** 30 / WORLD_SHARE_OF_DISK)
  return needed <= currentGb || needed > plan.storage.mostGb ? null : needed
}

/**
 * The disk a server gets at its next start once its world leaves less than a fifth of the one it
 * has free, or 1.5 GB, whichever comes first: one its world fills to about 70%, at least 2 GB more,
 * up to its plan's most. Null while it has room, or when its plan has none to give.
 */
export function grownDisk(plan: Entitlements, currentGb: number, usedBytes: number): number | null {
  const GB = 2 ** 30
  if (usedBytes < Math.min(currentGb * 0.8, currentGb - 1.5) * GB || currentGb >= plan.storage.mostGb)
    return null
  return Math.min(plan.storage.mostGb, Math.max(currentGb + 2, Math.ceil(usedBytes / GB / 0.7)))
}
