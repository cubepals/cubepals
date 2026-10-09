import {
  type BackupView,
  BLOCKLY_ICON,
  type Loader,
  type ModConflictView,
  type ModPlanView,
  type ModView,
  type OperationView,
  type PlayIcon,
  type RevisionChangeView,
  type RevisionView,
  type ServerView,
  type WorldView,
} from '@blockly/contracts'
import type { PillStatus, ProvisioningStep } from '../ui'

/**
 * How Blockly words a server's state. The API reports domain facts; the words people read are
 * decided here.
 */
export function presentStatus(server: ServerView): { pill: PillStatus; label?: string; detail: string } {
  switch (server.status) {
    case 'provisioning':
      return { pill: 'settingUp', detail: 'Building your world' }
    case 'starting':
      return { pill: 'starting', detail: 'Waking up · about 20 seconds' }
    case 'running': {
      const online = server.players?.online ?? 0
      return { pill: 'online', detail: `${online} / ${server.maxPlayers} players` }
    }
    case 'stopping':
      return { pill: 'stopped', label: 'Stopping', detail: 'Saving your world' }
    case 'updating':
      return { pill: 'starting', label: 'Updating', detail: 'Applying your changes' }
    case 'restoring':
      // A world that rested while nobody played comes back the same way a backup does.
      return server.activeOperation?.kind === 'unstore'
        ? { pill: 'starting', label: 'Restoring', detail: 'Restoring your world · a couple of minutes' }
        : { pill: 'starting', label: 'Restoring', detail: 'Bringing your backup back' }
    // Resting is housekeeping, not something that happened to anyone: it reads as sleep, and the
    // only thing worth saying is that waking takes a little longer.
    case 'storing':
      return { pill: 'sleeping', detail: 'Asleep until someone joins, or you wake it here' }
    case 'stored':
      return {
        pill: 'sleeping',
        detail: 'Resting while nobody plays. Joining wakes it, in a couple of minutes',
      }
    case 'relocating':
      return { pill: 'starting', label: 'Moving', detail: 'Moving to its new home' }
    case 'failed':
      return {
        pill: 'crashed',
        label: 'Failed',
        detail: failureLine(server.failure?.during, server.failure?.remedy),
      }
    case 'deleted':
    case 'purged':
      return { pill: 'stopped', label: 'Deleted', detail: 'This server has been deleted' }
    // A stopped world is asleep, not gone: whatever stopped it, the next player to join wakes it
    // (§12, and the smoke run measures the wait). The two that stay stopped are the ones a join
    // can't help — a crash to look at, and an account Blockly has paused.
    case 'stopped':
      switch (server.stopReason) {
        case 'crash':
          return server.crash?.outOfMemory
            ? { pill: 'crashed', detail: 'It ran out of memory. A bigger size gives it more room' }
            : { pill: 'crashed', detail: 'It stopped unexpectedly. Start it again, or check the console' }
        case 'policy':
          return { pill: 'suspended', detail: 'Paused by Cubepals. Contact support to restore it' }
        // A plan change it no longer fits: nothing about it was changed, and the start button
        // says what it waits for.
        case 'entitlement':
          return { pill: 'suspended', detail: 'Paused when your plan changed. Its world is safe' }
        case 'idle':
          return { pill: 'sleeping', detail: 'Nobody was on, so it went to sleep. Joining wakes it' }
        case 'maintenance':
          return { pill: 'sleeping', detail: 'Asleep after maintenance by Cubepals. Joining wakes it' }
        case 'session_cap':
          return {
            pill: 'sleeping',
            detail: 'It reached its time limit and went to sleep. Joining wakes it',
          }
        default:
          return { pill: 'sleeping', detail: 'Asleep until someone joins, or you wake it here' }
      }
  }
}

/**
 * What failed, and "Try again" only where trying again might do it: once Blockly has recognised
 * the cause and it isn't one a retry passes, the fix beside it is the way on, and "Try again"
 * would say the opposite of the sentence under it.
 */
function failureLine(during: string | undefined, remedy: string | null | undefined): string {
  const again = remedy === null || remedy === undefined || remedy === 'retry'
  switch (during) {
    case 'provisioning':
      return again ? 'We could not build your world. Try again' : 'We could not build your world'
    case 'starting':
      return again ? 'It did not start. Try again, or check the console' : 'It did not start'
    case 'stopping':
      return 'It did not stop cleanly. Try again'
    case 'updating':
      return again ? 'Your changes did not apply. Try again' : 'Your changes did not apply'
    default:
      return again ? 'Something went wrong. Try again' : 'Something went wrong'
  }
}

/** What a step's label may name: the release it gets, the pack it plays, and whether mods come too. */
type Named = Pick<ServerView, 'gameVersion' | 'modCount'> & { modpack: { name: string } | null }

/** Whether a first start downloads mods as well as Minecraft: a pack's, or the server's own. */
const modded = (server: Named) => server.modpack !== null || server.modCount > 0

interface Journey {
  title: string
  expectedSeconds: number | ((server: Named) => number)
  steps: Array<{
    /** A label can name what the server gets, and, for a change, what that change brings. */
    label: string | ((server: Named, changes: readonly RevisionChangeView[]) => string)
    covers: readonly string[]
  }>
}

/**
 * What a change downloads, said the way it is said everywhere else: the pack it moves to, the
 * Minecraft it moves to, the server type, or the mods it adds or updates. Null when it downloads
 * nothing, a change to settings alone.
 */
export function downloadOf(changes: readonly RevisionChangeView[]): string | null {
  let mods: string[] = []
  let version: string | null = null
  let loader: string | null = null
  // Files Cubepals wrote come with the change itself; nothing downloads for them.
  for (const change of changes.filter((c) => c.field !== 'files')) {
    if (change.field === 'modpack' && 'to' in change && typeof change.to === 'string')
      return `Downloading ${change.to}`
    if ('added' in change) mods = [...change.added, ...change.changed]
    else if (change.field === 'gameVersion') version = String(change.to)
    else if (change.field === 'loader') loader = loaderLabel(change.to as Loader)
  }
  const andMods = mods.length > 0 ? ' and its mods' : ''
  if (version !== null) return `Getting Minecraft ${version}${andMods}`
  if (loader !== null) return `Getting ${loader}${andMods}`
  if (mods.length === 1) return `Downloading ${mods[0]}`
  if (mods.length > 1) return `Downloading ${mods.length} mods`
  return null
}

/**
 * Named steps in Minecraft words, never "allocating" or "pulling image", each moved on by what
 * the server itself has reached (`starting` is Java running, `loading_world` the world being
 * made), so a step is never a label standing still over something else.
 */
const JOURNEYS: Partial<Record<OperationView['kind'], Journey>> = {
  provision: {
    title: 'Building your world',
    // Measured on Fly: plain Minecraft took 77 to 106 s, median 100, from a new app, volume and
    // machine (docs/metrics.md). A pack isn't measured there yet; on a local stack a 264-mod pack
    // spent 47 s on its mods alone before Java started.
    expectedSeconds: (server) => (modded(server) ? 180 : 100),
    steps: [
      { label: 'Picking a place', covers: ['queued', 'allocating', 'storage', 'compute'] },
      {
        // A pack's mods are most of its wait, and the pack brings Minecraft's loader with it: the
        // step is the pack, by name.
        label: (server) =>
          server.modpack !== null
            ? `Downloading ${server.modpack.name}`
            : `Getting Minecraft ${server.gameVersion}${server.modCount > 0 ? ' and its mods' : ''}`,
        covers: ['booting'],
      },
      { label: 'Starting it up', covers: ['starting'] },
      { label: 'Creating your world', covers: ['loading_world', 'verifying', 'access'] },
    ],
  },
  start: {
    title: 'Starting your server',
    // Measured on Fly: a stopped plain server took 37 to 49 s, median 43 (docs/metrics.md).
    expectedSeconds: 45,
    steps: [
      {
        // A start onto a changed pack keeps a copy of the world first: that is waking it too.
        label: 'Waking the server',
        covers: ['queued', 'saving', 'allocating', 'storage', 'compute', 'booting', 'starting'],
      },
      { label: 'Loading the world', covers: ['loading_world'] },
      { label: 'Letting players in', covers: ['verifying', 'access'] },
    ],
  },
  restart: {
    title: 'Restarting your server',
    expectedSeconds: 30,
    steps: [
      {
        label: 'Saving the world',
        covers: ['queued', 'saving', 'stopping', 'allocating', 'storage', 'compute', 'booting', 'starting'],
      },
      { label: 'Loading the world', covers: ['loading_world'] },
      { label: 'Letting players in', covers: ['verifying', 'access'] },
    ],
  },
  apply: {
    title: 'Applying your changes',
    expectedSeconds: 40,
    steps: [
      { label: 'Saving the world', covers: ['queued', 'saving'] },
      // What the change downloads is named, and counted in the line under it; a change to
      // settings alone downloads nothing.
      {
        label: (_, changes) => downloadOf(changes) ?? 'Setting up your changes',
        covers: ['compute', 'allocating', 'storage', 'booting'],
      },
      { label: 'Starting it up', covers: ['starting'] },
      { label: 'Loading the world', covers: ['loading_world'] },
      { label: 'Letting players in', covers: ['verifying', 'access'] },
    ],
  },
  restore: {
    title: 'Restoring your backup',
    expectedSeconds: 60,
    steps: [
      { label: 'Keeping the world as it is now', covers: ['queued', 'saving'] },
      { label: 'Bringing the backup back', covers: ['storage', 'compute', 'allocating'] },
      { label: 'Setting it up', covers: ['booting'] },
      { label: 'Starting it up', covers: ['starting'] },
      { label: 'Loading the world', covers: ['loading_world', 'verifying', 'access'] },
    ],
  },
  // A world that rested while nobody played: fetched, set up and loaded. Measured on Fly: a new
  // world's took a median of 78 s, and a 1 GB world's, the most Free keeps, 138 s; most of the
  // difference is the download (docs/metrics.md).
  unstore: {
    title: 'Restoring your world',
    expectedSeconds: 120,
    steps: [
      { label: 'Getting your world', covers: ['queued', 'allocating', 'storage'] },
      { label: 'Setting it up', covers: ['compute', 'booting'] },
      { label: 'Starting it up', covers: ['starting'] },
      { label: 'Loading the world', covers: ['loading_world', 'verifying', 'access'] },
    ],
  },
  relocate: {
    title: 'Moving your server',
    expectedSeconds: 90,
    steps: [
      { label: 'Saving the world', covers: ['queued', 'saving'] },
      { label: 'Moving it', covers: ['storage', 'compute', 'allocating'] },
      { label: 'Setting it up there', covers: ['booting'] },
      { label: 'Starting it up', covers: ['starting'] },
      { label: 'Loading the world', covers: ['loading_world', 'verifying', 'access'] },
    ],
  },
}

/** Work that didn't start: the world is saved and the server goes back to how it was. */
const GOING_BACK: Partial<Record<OperationView['kind'], Journey>> = {
  apply: {
    title: 'Your changes didn’t start. Going back to how it was',
    expectedSeconds: 40,
    steps: [
      { label: 'Saving the world', covers: [] },
      { label: 'Trying your changes', covers: [] },
      { label: 'Going back', covers: ['rolling_back'] },
    ],
  },
  restore: {
    title: 'The backup didn’t start. Going back to how it was',
    expectedSeconds: 60,
    steps: [
      { label: 'Keeping the world as it is now', covers: [] },
      { label: 'Trying the backup', covers: [] },
      { label: 'Going back', covers: ['rolling_back'] },
    ],
  },
  // A start onto a pack change that didn't come up: the one before goes back, and it starts on it.
  start: {
    title: 'The new version didn’t start. Going back to the one before',
    expectedSeconds: 40,
    steps: [
      { label: 'Keeping a copy of the world', covers: [] },
      { label: 'Trying the new version', covers: [] },
      { label: 'Going back', covers: ['rolling_back'] },
    ],
  },
}

export interface Progress {
  title: string
  steps: ProvisioningStep[]
  percent: number
  expectedSeconds: number
  /** Which of the steps it is on, counting from 0. */
  index: number
}

/**
 * What a button says while the server is busy. It comes from the operation, not from the status:
 * a restart passes through stopping and starting, and saying "Putting it to sleep" in the middle
 * of it would be a lie about what the person asked for.
 */
const BUSY_WORD: Record<OperationView['kind'], string> = {
  provision: 'Building your world',
  start: 'Waking it up',
  stop: 'Putting it to sleep',
  restart: 'Restarting',
  apply: 'Applying your changes',
  relocate: 'Moving it',
  backup: 'Backing up the world',
  archive: 'Packing the archive',
  restore: 'Bringing the world back',
  access_sync: 'Updating who can join',
  prune_worlds: 'Tidying old worlds',
  decommission: 'Taking it down',
  purge: 'Taking it down',
  store: 'Letting it rest',
  unstore: 'Restoring your world',
}

export const busyWord = (operation: OperationView | null): string | undefined =>
  operation === null ? undefined : BUSY_WORD[operation.kind]

export function presentProgress(
  operation: OperationView,
  server: Named,
  /** What the change being applied brings, where the step names its download. */
  changes: readonly RevisionChangeView[] = [],
): Progress | null {
  const journey = operation.step === 'rolling_back' ? GOING_BACK[operation.kind] : JOURNEYS[operation.kind]
  if (!journey) return null
  const step = operation.step ?? 'queued'
  const current = Math.max(
    0,
    journey.steps.findIndex((s) => s.covers.includes(step)),
  )
  return {
    title: journey.title,
    expectedSeconds:
      typeof journey.expectedSeconds === 'number' ? journey.expectedSeconds : journey.expectedSeconds(server),
    percent: Math.min(95, ((current + 0.5) / journey.steps.length) * 100),
    index: current,
    steps: journey.steps.map((s, i) => ({
      label: typeof s.label === 'string' ? s.label : s.label(server, changes),
      state: i < current ? 'done' : i === current ? 'active' : 'todo',
    })),
  }
}

/**
 * What a new server is doing while it prints nothing worth showing, in words, so the line under
 * its step never stands still on a technical line: setting Minecraft up above all, which the image
 * does without a word for as long as it takes. True whether Minecraft is downloaded or already here.
 */
export function quietLine(
  step: OperationView['step'],
  server: Named,
  /** A first build downloads; a change to a server that runs already mostly doesn't. */
  kind: OperationView['kind'] = 'provision',
): string {
  const fresh = kind === 'provision'
  switch (step) {
    case 'saving':
      return 'Saving your world first'
    case 'stopping':
      return 'Stopping it safely'
    case 'rolling_back':
      return 'Putting it back how it was'
    case 'allocating':
      return 'Finding room for it'
    case 'storage':
      return 'Setting aside space for your world'
    case 'compute':
      return 'Getting its home ready'
    case 'booting':
      if (!fresh) return 'Setting it up'
      return server.modpack !== null
        ? `Downloading ${server.modpack.name}`
        : `Setting up Minecraft ${server.gameVersion}${server.modCount > 0 ? ' and its mods' : ''}`
    case 'starting':
      return `Starting Minecraft ${server.gameVersion}`
    case 'loading_world':
      return fresh ? 'Shaping the land' : 'Loading the world'
    case 'verifying':
      return 'Checking its mods are the ones chosen'
    case 'access':
      return 'Letting players in'
    default:
      return 'Getting started'
  }
}

/** An honest countdown: it says so when the wait runs long instead of freezing at zero. */
export function etaLine(startedAt: string | null, expectedSeconds: number, now: number): string {
  const elapsed = startedAt ? (now - Date.parse(startedAt)) / 1000 : 0
  const left = Math.round(expectedSeconds - elapsed)
  if (left > 90) return 'A couple of minutes left'
  if (left > 45) return 'About a minute left'
  if (left > 5) return `About ${Math.ceil(left / 5) * 5} seconds left`
  if (left > -30) return 'Almost there'
  return 'Taking a little longer than usual'
}

const COVERS = [
  '/imagery/cover-snow.jpg',
  '/imagery/cover-canyon.jpg',
  '/imagery/cover-cherry.jpg',
  '/imagery/cover-island.jpg',
] as const

/** A server's own picture as the pages draw it: the one its owner picked, or Blockly's. */
export const iconSrc = (icon: string | null): string => `/server-icons/${icon ?? BLOCKLY_ICON}.svg`

/** A way to play's picture on the create page: an item, drawn by scripts/play-icons.py. */
export const playIconSrc = (icon: PlayIcon): string => `/play-icons/${icon}.svg`

/** A server's card picture. The tail of its id is random, so a server keeps the same one. */
export function coverFor(serverId: string): string {
  return COVERS[Number.parseInt(serverId.slice(-8), 16) % COVERS.length] ?? COVERS[0]
}

const LOADER_LABELS: Record<Loader, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  fabric: 'Fabric',
  quilt: 'Quilt',
  neoforge: 'NeoForge',
  forge: 'Forge',
}

export const loaderLabel = (loader: Loader): string => LOADER_LABELS[loader]

/**
 * Where the address goes, for someone who has never added a server. Java Edition, because a
 * console or a phone runs Bedrock and can never join, and the exact release, because a client on
 * another one is turned away at the door.
 */
/** The pack everyone joining installs first, where the server plays one; null when plain Minecraft joins. */
export const packToInstall = (server: Pick<ServerView, 'modpack'>) =>
  server.modpack?.environment === 'both' ? server.modpack : null

/** `pack` is one everyone joining installs first: it is part of the game they join with. */
export function joinLine(gameVersion: string, pack: { name: string } | null = null): string {
  const game = `Minecraft: Java Edition ${gameVersion}${pack === null ? '' : ` with ${pack.name} installed`}`
  return `In ${game}, open Multiplayer → Add Server and paste it. Consoles and phones can’t join.`
}

/** A moment today as a clock reads it: "18:40". */
export const clockTime = (at: string): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** A moment later today or tomorrow, as someone would say it: "tomorrow at 18:40". */
export function whenItGoes(at: string, now: number): string {
  const when = new Date(at)
  const clock = clockTime(at)
  const days = Math.round((when.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return `today at ${clock}`
  if (days === 1) return `tomorrow at ${clock}`
  return `${new Date(at).toLocaleDateString([], { weekday: 'long' })} at ${clock}`
}

/** A server size as it is sold: "3 GB". */
export const sizeLabel = (tier: string): string => `${Number.parseInt(tier, 10)} GB`

/**
 * The server type with the build its revision pins: "Fabric 0.19.5", "Paper build 125". Plain
 * Minecraft with a build runs on Paper (`runsOnPaper` in the control plane): "Vanilla on Paper".
 */
export function loaderWithBuild(loader: Loader, build: string | null): string {
  if (build === null) return LOADER_LABELS[loader]
  if (loader === 'vanilla') return 'Vanilla on Paper'
  return loader === 'paper' ? `Paper build ${build}` : `${LOADER_LABELS[loader]} ${build}`
}

/** Whether a plain server runs on Paper: plain Minecraft pins a build only for that. */
export const runsOnPaper = (server: { loader: Loader; loaderVersion: string | null }): boolean =>
  server.loader === 'vanilla' && server.loaderVersion !== null

const REASONS: Record<RevisionView['reason'], string> = {
  created: 'Created',
  settings_changed: 'Settings changed',
  version_changed: 'Version changed',
  mods_changed: 'Mods changed',
  rollback: 'Went back',
  restore: 'Restored from a backup',
}

export const revisionTitle = (revision: RevisionView): string => REASONS[revision.reason]

const SETTING_WORDS: Record<string, { label: string; unit?: string }> = {
  gameVersion: { label: 'Minecraft' },
  loader: { label: 'Server type' },
  loaderVersion: { label: 'Build' },
  onPaper: { label: 'Runs on Paper' },
  difficulty: { label: 'Difficulty' },
  defaultGameMode: { label: 'Game mode' },
  pvp: { label: 'PvP' },
  viewDistance: { label: 'View distance', unit: 'chunks' },
  simulationDistance: { label: 'Simulation distance', unit: 'chunks' },
  maxPlayers: { label: 'Max players' },
  motd: { label: 'Server message' },
  spawnProtection: { label: 'Spawn protection', unit: 'blocks' },
  onlineMode: { label: 'Online authentication' },
}

/** What the settings page calls a setting: "Game mode". */
export const settingLabel = (field: string): string => (SETTING_WORDS[field] ?? { label: field }).label

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function settingValue(field: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (field === 'loader') return LOADER_LABELS[value as Loader] ?? String(value)
  if (field === 'motd') return `“${value}”`
  if (field === 'difficulty' || field === 'defaultGameMode') return capitalized(String(value))
  return String(value)
}

/** A move onto, off, or between modpacks, which names packs rather than values. */
const isPackChange = (
  change: RevisionChangeView,
): change is Extract<RevisionChangeView, { field: 'modpack' }> => change.field === 'modpack'

/** One line per difference, in the words the settings page uses: "Difficulty Normal → Hard". */
export function presentChange(change: RevisionChangeView): string {
  if ('added' in change) {
    const parts = [
      change.added.length > 0 && `added ${change.added.join(', ')}`,
      change.removed.length > 0 && `removed ${change.removed.join(', ')}`,
      change.changed.length > 0 && `updated ${change.changed.join(', ')}`,
    ].filter(Boolean)
    return `${change.field === 'files' ? 'Set by Cubepals' : 'Mods'}: ${parts.join('; ')}`
  }
  if (isPackChange(change)) {
    if (change.to === null) return `Stopped playing ${change.from}`
    return change.from === null ? `Now playing ${change.to}` : `Modpack: ${change.from} → ${change.to}`
  }
  const words = SETTING_WORDS[change.field] ?? { label: change.field }
  const unit = words.unit ? ` ${words.unit}` : ''
  return `${words.label} ${settingValue(change.field, change.from)} → ${settingValue(change.field, change.to)}${unit}`
}

/** "just now", "5 minutes ago", "3 days ago": history reads by distance, not timestamps. */
export function timeAgo(at: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000)
  if (seconds < 60) return 'just now'
  for (const [size, unit] of AGO_UNITS) {
    const count = Math.floor(seconds / size)
    // `Intl` is the platform's own: it gets the plural right, and it will speak whatever
    // language the page is in the day Blockly has one.
    if (count >= 1) return AGO.format(-count, unit)
  }
  return 'just now'
}

const AGO = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
const AGO_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60 * 60 * 24 * 365, 'year'],
  [60 * 60 * 24 * 30, 'month'],
  [60 * 60 * 24, 'day'],
  [60 * 60, 'hour'],
  [60, 'minute'],
]

/** Why mods can't run together, one sentence each, naming the server they were meant for. */
export function presentConflict(
  conflict: ModConflictView,
  server: { gameVersion: string; loader: Loader },
): string {
  const target = `${loaderLabel(server.loader)} ${server.gameVersion}`
  switch (conflict.kind) {
    case 'unavailable':
      return `${conflict.mod} isn't available on Modrinth any more.`
    case 'no_fitting_version':
      return `${conflict.mod} has no version for ${target}.`
    case 'client_only':
      return `${conflict.mod} only runs in players' games, not on a server.`
    case 'missing_dependency':
      return `${conflict.mod} needs ${conflict.dependency}, which has no version for ${target}.`
    case 'incompatible':
      return `${conflict.mod} can't run alongside ${conflict.with}.`
    case 'upload_does_not_fit':
      return `${conflict.mod}, your upload, was made for another Minecraft version or server type.`
  }
}

/** A plan's changes, one line each: "+ Sodium 0.7.0", "− Lithium", "Fabric API 0.160 → 0.161". */
export function presentPlan(plan: Extract<ModPlanView, { kind: 'ok' }>): string[] {
  const needed = (mod: ModView) =>
    mod.origin === 'dependency' && mod.requiredBy.length > 0
      ? ` (needed by ${mod.requiredBy.join(', ')})`
      : ''
  return [
    ...plan.added.map((mod) => `+ ${mod.name} ${mod.versionLabel}${needed(mod)}`),
    ...plan.updated.map(({ from, to }) => `${to.name} ${from.versionLabel} → ${to.versionLabel}`),
    ...plan.removed.map((mod) => `− ${mod.name}`),
  ]
}

const TRIGGERS: Record<BackupView['trigger'], string> = {
  scheduled: 'Daily backup',
  manual: 'Backed up by you',
  pre_apply: 'Before a change',
  pre_restore: 'Before a restore',
  pre_relocate: 'Before a move',
  uploaded: 'Uploaded by you',
  stored: 'Kept while it rested',
}

const ARCHIVES: Record<BackupView['trigger'], string> = {
  scheduled: 'Weekly download',
  manual: 'Download',
  pre_apply: 'Download',
  pre_restore: 'Download',
  pre_relocate: 'Download',
  uploaded: 'Uploaded by you',
  stored: 'Kept while it rested',
}

export const backupTitle = (backup: BackupView): string =>
  backup.tier === 'archive' ? ARCHIVES[backup.trigger] : TRIGGERS[backup.trigger]

/** "19 Oct": the day an archive's retention ends. */
export const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** "Today, 14:02", "Yesterday, 09:30", "12 Sept, 18:45": when a backup was taken, at a glance. */
export function whenTaken(at: string, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const days = Math.floor((startOfDay(now) - startOfDay(date.getTime())) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

const startOfDay = (ms: number) => {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export function bytes(size: number | null): string | null {
  if (size === null || size === 0) return null
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`
  if (size >= 1024 ** 2) return `${Math.round(size / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

const LEVEL_TYPE_LABELS: Record<WorldView['levelType'], string> = {
  'minecraft:normal': 'Normal',
  'minecraft:flat': 'Superflat',
  'minecraft:large_biomes': 'Large biomes',
  'minecraft:amplified': 'Amplified',
}

export const levelTypeLabel = (type: WorldView['levelType']): string => LEVEL_TYPE_LABELS[type]

const UNTRUSTED: Record<string, (mod: string) => string> = {
  upload: (mod) => `${mod} is your own upload; servers with uploads don’t list.`,
  not_allowlisted: (mod) => `${mod} isn’t on Cubepals’ list of mods it vouches for.`,
  project_revoked: (mod) => `${mod} was taken down where it was published.`,
  version_revoked: (mod) => `This version of ${mod} was taken down where it was published.`,
  unknown: (mod) => `Cubepals hasn’t checked ${mod} with Modrinth yet.`,
  modpack: (pack) => `The directory shows mods Cubepals vouches for, and ${pack} brings its own.`,
}

/** Why a listing isn't shown, in the owner's terms. */
export function presentIneligible(reason: { code: string; detail?: string }): string {
  switch (reason.code) {
    case 'not_running_yet':
      return 'It lists once the server has started.'
    case 'untrusted_mods': {
      const detail = reason.detail ?? ''
      const cut = detail.lastIndexOf(': ')
      const mod = cut === -1 ? detail : detail.slice(0, cut)
      const why = cut === -1 ? '' : detail.slice(cut + 2)
      return (UNTRUSTED[why] ?? UNTRUSTED.not_allowlisted ?? ((m: string) => m))(mod)
    }
    case 'account_not_active':
      return 'Your account is suspended.'
    case 'restricted':
      return 'Public listing is turned off for your account.'
    case 'not_entitled':
      return 'Your plan doesn’t include public listing.'
    case 'server_deleted':
      return 'The server is deleted.'
    default:
      return 'It can’t be shown right now.'
  }
}
