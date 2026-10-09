/**
 * Builds the handler for every operation a server can run (§9) from the parts in `handlers/`,
 * handing each part only the ports, services and steps it uses. It holds no logic of its own:
 * running an operation, retrying it and recording its outcome is `runner.ts`, and the boot
 * sequence the handlers share is `boot.ts`. Shared steps (binding, rechecks, game console, world
 * copies, going back) each own one piece of state; families (the rest) each own their handlers'
 * phase and what a failure leaves. Families take the steps' functions from here, importing only
 * their types, the pure `appliedConfig` and the link and copy lifetimes; the one import between
 * families is `WOKEN_BY`, from `bringing-up.ts` into `stored-worlds.ts`.
 *
 * Parts (`handlers/`):
 * - `access-sync.ts`: brings a running server's access files in line with Blockly's record.
 * - `backups.ts`: the backups an owner keeps, a snapshot or an archive, leaving the server's status alone.
 * - `binding.ts`: a server's runtime binding: the compute its handle names, and what it last booted.
 * - `bringing-up.ts`: brings a server's compute up and boots it, as provision, start and restart do.
 * - `game-console.ts`: what operations ask of the running game through its console.
 * - `going-back.ts`: puts a server back on the configuration it last ran.
 * - `moving.ts`: moves a server to another region, off a lost host, or onto another runtime.
 * - `prune-worlds.ts`: removes the directories of a server's deleted worlds while it runs.
 * - `rechecks.ts`: what a worker checks again before it boots a server.
 * - `restoring.ts`: puts a backup's world in place of the server's, with a way back.
 * - `stored-worlds.ts`: rests a world nobody plays in the archive store, and wakes it from there.
 * - `updating.ts`: puts a running server onto a new configuration, with a way back.
 * - `winding-down.ts`: takes a server down: stopped, decommissioned into the trash, or purged.
 * - `world-copies.ts`: copies of a server's world, each recorded as a backup.
 */
import type { Db } from '@blockly/db'
import type { AccessReconciler } from '../access/reconciler.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import type { BackupService } from '../backups/service.ts'
import type { PlayerService } from '../players/service.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { ServerConsole } from '../ports/minecraft.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { RuntimePlacement } from '../runtimes/service.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import type { BootSequence } from './boot.ts'
import { syncingAccess } from './handlers/access-sync.ts'
import { backingUp } from './handlers/backups.ts'
import { serverBinding } from './handlers/binding.ts'
import { bringingUp } from './handlers/bringing-up.ts'
import { gameConsole } from './handlers/game-console.ts'
import { goingBack } from './handlers/going-back.ts'
import { moving } from './handlers/moving.ts'
import { pruningWorlds } from './handlers/prune-worlds.ts'
import { rechecks } from './handlers/rechecks.ts'
import { restoring } from './handlers/restoring.ts'
import { storedWorlds } from './handlers/stored-worlds.ts'
import { updating } from './handlers/updating.ts'
import { windingDown } from './handlers/winding-down.ts'
import { worldCopies } from './handlers/world-copies.ts'
import type { OperationHandler } from './runner.ts'

export interface HandlerDeps {
  db: Db
  /** Every runtime the deployment runs; each server's handle goes to the one that issued it. */
  runtime: Runtimes
  /** Where a server goes when its runtime has no room at its first start, and moves between runtimes. */
  placement: RuntimePlacement
  transitions: ServerTransitions
  events: EventBus
  policy: AccessPolicy
  specs: RuntimeSpecs
  boot: BootSequence
  access: AccessReconciler
  console: ServerConsole
  /** Each player's facts, kept as a server stops for its page while it sleeps. */
  players: Pick<PlayerService, 'snapshot'>
  artifacts: ArtifactService
  backups: BackupService
  /** The archive store, when the deployment has one (§15.4). */
  archives: ArchiveStore | null
  jobs: JobQueue
  /** Owners hear when a server had to be rebuilt from a backup. */
  mailer: Mailer
  /** Where people reach the web app, for links in those emails. */
  webOrigin: string
}

/** Every operation a server can run. Each re-validates, acts through ports, then records the outcome. */
export function createHandlers(deps: HandlerDeps): OperationHandler[] {
  const { db, runtime, transitions, specs, boot, artifacts } = deps

  const { bindingOf, progressSink, startCompute, booted, stopWhatFailed } = serverBinding({
    db,
    runtime,
    jobs: deps.jobs,
  })

  const { stillAllowed, mayBoot, preflight } = rechecks({ db, policy: deps.policy, artifacts })

  const { consoleTarget, windDown } = gameConsole({
    runtime,
    specs,
    console: deps.console,
    access: deps.access,
  })

  const { capture, pack, archiveCopy } = worldCopies({
    db,
    runtime,
    console: deps.console,
    consoleTarget,
    events: deps.events,
    archives: deps.archives,
    backups: deps.backups,
  })

  const { rollBack, putBack } = goingBack({
    db,
    runtime,
    specs,
    access: deps.access,
    boot,
    transitions,
    bindingOf,
    progressSink,
    startCompute,
    booted,
  })

  const { provision, start, restart } = bringingUp({
    db,
    runtime,
    placement: deps.placement,
    policy: deps.policy,
    specs,
    boot,
    transitions,
    bindingOf,
    progressSink,
    startCompute,
    booted,
    stopWhatFailed,
    stillAllowed,
    preflight,
    windDown,
    capture,
    rollBack,
  })

  const apply = updating({
    db,
    runtime,
    specs,
    console: deps.console,
    transitions,
    boot,
    artifacts,
    backups: deps.backups,
    bindingOf,
    startCompute,
    booted,
    stopWhatFailed,
    mayBoot,
    consoleTarget,
    capture,
    rollBack,
    putBack,
  })

  const { backup, archive } = backingUp({
    db,
    policy: deps.policy,
    events: deps.events,
    archives: deps.archives,
    backups: deps.backups,
    bindingOf,
    capture,
    pack,
  })

  const restore = restoring({
    db,
    runtime,
    specs,
    access: deps.access,
    boot,
    transitions,
    archives: deps.archives,
    backups: deps.backups,
    bindingOf,
    progressSink,
    startCompute,
    booted,
    stopWhatFailed,
    mayBoot,
    preflight,
    windDown,
    capture,
    putBack,
  })

  const relocate = moving({
    db,
    runtime,
    specs,
    access: deps.access,
    boot,
    transitions,
    placement: deps.placement,
    archives: deps.archives,
    backups: deps.backups,
    mailer: deps.mailer,
    webOrigin: deps.webOrigin,
    bindingOf,
    progressSink,
    startCompute,
    booted,
    stopWhatFailed,
    mayBoot,
    preflight,
    windDown,
    capture,
    archiveCopy,
  })

  const { store, unstore } = storedWorlds({
    db,
    runtime,
    specs,
    boot,
    transitions,
    events: deps.events,
    archives: deps.archives,
    bindingOf,
    progressSink,
    startCompute,
    booted,
    stillAllowed,
    preflight,
    archiveCopy,
  })

  const { stop, decommission, purge } = windingDown({ ...deps, bindingOf, windDown })

  const pruneWorlds = pruningWorlds({ db, runtime, bindingOf })

  const accessSync = syncingAccess({ db, access: deps.access, bindingOf })

  return [
    provision,
    start,
    restart,
    apply,
    stop,
    backup,
    archive,
    restore,
    relocate,
    pruneWorlds,
    accessSync,
    decommission,
    purge,
    store,
    unstore,
  ]
}
