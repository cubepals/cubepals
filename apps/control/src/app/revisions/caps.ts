import {
  addedLabel,
  comesWith,
  type Entitlements,
  planGap,
  planName,
  planThatRuns,
  type Runs,
} from '../../domain/account/entitlements.ts'
import type { RevisionDraft, ServerSettings } from '../../domain/revision/revision.ts'
import type { MemoryTier } from '../../domain/server/size.ts'
import { installsAsDatapack } from '../../minecraft/mods.ts'
import { LOADER_LABELS } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'

type Checked = Pick<RevisionDraft, 'loader' | 'settings' | 'mods' | 'modpack'>

/** Whether a configuration adds a loader's worth to Minecraft: mods, plugins or a modpack. */
export const isModded = (draft: Pick<RevisionDraft, 'loader' | 'mods' | 'modpack'>): boolean =>
  draft.mods.some((mod) => !installsAsDatapack(mod, draft.loader)) || draft.modpack !== null

/** Whether a configuration puts datapacks into its world. */
export const hasDatapacks = (draft: Pick<RevisionDraft, 'loader' | 'mods'>): boolean =>
  draft.mods.some((mod) => installsAsDatapack(mod, draft.loader))

/** What a server of this size runs with this configuration, as plans judge it. */
export const runsOf = (
  tier: MemoryTier,
  draft: Pick<RevisionDraft, 'loader' | 'mods' | 'modpack'>,
): Runs => ({
  tier,
  loader: draft.loader,
  modded: isModded(draft),
  datapacks: hasDatapacks(draft),
})

/**
 * A plan's limits on a configuration, checked whenever a revision is made: created, edited,
 * rolled back to, or restored with a backup's settings. A value above a cap, or a server type the
 * plan doesn't run, is refused with what to change; nothing is lowered on the owner's behalf. A
 * server made before a limit existed keeps running as it is until its next change.
 */
export function requireWithinPlan(plan: Entitlements, draft: Checked): void {
  const problems = planProblems(plan, draft)
  if (problems.length > 0) throw new AppError('not_entitled', problems.join(' '))
}

function planProblems(plan: Entitlements, draft: Checked): string[] {
  const name = planName(plan.plan)
  const problems: string[] = []
  // Every plan offers the smallest size, so only what the server runs can stand in the way.
  const runs = runsOf('3g', draft)
  const gap = planGap(plan, runs, 'offered')
  const paid = planThatRuns(runs)
  if (gap === 'mods' || gap === 'datapacks')
    problems.push(comesWith(addedLabel(gap, draft.modpack !== null), paid))
  else if (gap === 'server_type') {
    const offered = plan.allowedLoaders.map((loader) => LOADER_LABELS[loader])
    const listed =
      offered.length > 1 ? `${offered.slice(0, -1).join(', ')} and ${offered.at(-1)}` : offered[0]
    problems.push(
      `${name} servers run ${listed}. ${LOADER_LABELS[draft.loader]} ${paid === null ? 'needs a paid plan' : `comes with ${planName(paid)}`}.`,
    )
  }
  const caps = plan.settingCaps
  if (caps !== null) {
    const { maxPlayers, viewDistance, simulationDistance } = draft.settings
    if (maxPlayers > caps.maxPlayers) problems.push(`${name} servers hold up to ${caps.maxPlayers} players.`)
    if (viewDistance > caps.viewDistance)
      problems.push(
        `${name} servers see up to ${caps.viewDistance} chunks: set view distance to ${caps.viewDistance} or less.`,
      )
    if (simulationDistance > caps.simulationDistance)
      problems.push(
        `${name} servers simulate up to ${caps.simulationDistance} chunks: set simulation distance to ${caps.simulationDistance} or less.`,
      )
  }
  return problems
}

/**
 * A new server's settings within its plan's caps. These are Blockly's defaults, not values the
 * owner chose, so they are fitted to the plan rather than refused.
 */
export function fittedDefaults(plan: Entitlements, settings: ServerSettings): ServerSettings {
  const caps = plan.settingCaps
  if (caps === null) return settings
  return {
    ...settings,
    maxPlayers: Math.min(settings.maxPlayers, caps.maxPlayers),
    viewDistance: Math.min(settings.viewDistance, caps.viewDistance),
    simulationDistance: Math.min(settings.simulationDistance, caps.simulationDistance),
  }
}
