// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppliedConfigJson, Db } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { SETTING_ENV } from '../../minecraft/runtime-spec.ts'
import { liveCommands, refusedByGame, settingTakes } from '../../minecraft/settings.ts'
import type { ConsoleTarget, ServerConsole } from '../ports/minecraft.ts'
import type { RuntimeSpec } from '../ports/runtime.ts'
import { lockServer, saveApplied } from '../servers/persistence.ts'
import { type DesiredRuntime, type RuntimeSpecs, specDigest, withoutPlanLimits } from '../servers/specs.ts'
import type { ServerTransitions } from '../servers/transitions.ts'

/**
 * A change a running server takes as people play: settings the game changes by command, and ones
 * only the server list shows. When the configuration it ran and the one it should run differ in
 * nothing else, the commands run and the server keeps going; no snapshot, no restart. The
 * machine keeps the variables it started with until its next start, which sets everything from
 * the new ones, so the change holds after it too.
 *
 * False, with nothing recorded, when the change needs a start, or the game turned a command down:
 * the update then goes the usual way, which restarts the server into the change.
 */
export async function takeLive(
  deps: { db: Db; specs: RuntimeSpecs; console: ServerConsole; transitions: ServerTransitions },
  server: MinecraftServer,
  target: ConsoleTarget,
  previous: AppliedConfigJson,
  desired: DesiredRuntime,
): Promise<boolean> {
  const ran = await deps.specs.forConfig(deps.db, server, {
    revisionId: previous.revisionId,
    worldId: previous.worldId,
    memoryTier: previous.memoryTier as MinecraftServer['memoryTier'],
  })
  // What runs is what that configuration builds today: a key rotation or a new image isn't.
  if ((previous.driftDigest ?? previous.specDigest) !== ran.driftDigest) return false
  const gameVersion = desired.revision.gameVersion
  if (booting(ran.spec, gameVersion) !== booting(desired.spec, gameVersion)) return false
  const commands = liveCommands(ran.revision.settings, desired.revision.settings, gameVersion)
  const answers = commands.length === 0 ? [] : await deps.console.runAll(target, commands).catch(() => null)
  if (answers === null || answers.some((answer) => !answer.ok || refusedByGame(answer.output))) return false
  return deps.db.transaction(async (tx) => {
    const locked = await lockServer(tx, server.id)
    if (locked === null || locked.lifecycle.status !== 'updating') return true
    // The spec digest stays the machine's, so the next start boots the new variables.
    await saveApplied(tx, server.id, {
      ...previous,
      revisionId: desired.revision.id,
      driftDigest: desired.driftDigest,
    })
    await deps.transitions.outcome(tx, locked, { type: 'updated', running: true })
    return true
  })
}

/**
 * A spec's digest as drift sees it, and without the settings a running server takes: two with the
 * same one differ only in what can wait for a start or be changed by command.
 */
function booting(spec: RuntimeSpec, gameVersion: string): string {
  const taken = (Object.keys(SETTING_ENV) as (keyof typeof SETTING_ENV)[])
    .filter((setting) => settingTakes(setting, gameVersion) !== 'restart')
    .map((setting) => SETTING_ENV[setting])
  const seen = withoutPlanLimits(spec)
  return specDigest({
    ...seen,
    env: Object.fromEntries(Object.entries(seen.env).filter(([name]) => !taken.includes(name))),
  })
}
