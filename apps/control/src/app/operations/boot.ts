import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Diagnosis, diagnose } from '../../minecraft/diagnosis.ts'
import {
  type InstallCheck,
  installCheck,
  installProblems,
  type PackCheck,
  packCheck,
  packCleanup,
  packProblems,
  parseInstalled,
} from '../../minecraft/install-check.ts'
import {
  bootedWith,
  bootMilestone,
  bootMismatch,
  namesWhatStarted,
  reportsCrash,
} from '../../minecraft/logs.ts'
import { modName } from '../../minecraft/pack-build.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { bootCommands } from '../../minecraft/settings.ts'
import { type AccessReconciler, AccessReseedFailed } from '../access/reconciler.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import { DiagnosedFailure, inFull, PermanentFailure, PlainFailure } from '../errors.ts'
import type { PackContents } from '../packs/contents.ts'
import type { ReadinessProbe, ServerConsole } from '../ports/minecraft.ts'
import type { LogLine, LogSource } from '../ports/platform.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { NoLongerApplies, type OperationContext } from './runner.ts'

export interface BootTimeouts {
  /** From "started" to the process being up. */
  runningMs: number
  /** From up to answering a status ping: world generation can take minutes on first boot. */
  readyMs: number
}

export class NotReady extends PlainFailure {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NotReady'
  }
}

/** A stop or hang the server's output pinned on something, with what it found for a pack to learn from. */
class Diagnosed extends DiagnosedFailure {
  readonly found: Diagnosis
  /** Read from a start that stopped answering, rather than from one that stopped. */
  readonly hung: boolean

  constructor(found: Diagnosis, hung: boolean) {
    super(found.summary, found.remedy)
    this.found = found
    this.hung = hung
  }
}

/**
 * A start that stopped answering with nothing in its output to say why. A start gets one more,
 * fresh, and a second hang fails for good: the operation's next attempt would find the same stuck
 * process running and wait on it all over again (a pack's first start on 2026-09-27 waited out
 * attempt after attempt on one machine that was never restarted).
 */
class Stuck extends PermanentFailure {
  /** How far its output showed it got. */
  readonly reached: Reached

  constructor(reached: Reached, options?: ErrorOptions, tries: 1 | 2 = 2) {
    super(stuckWhile(reached, tries), options)
    this.name = 'Stuck'
    this.reached = reached
  }
}

/** A start that stopped answering, whether or not its output said why. */
const stoppedAnswering = (error: unknown) =>
  error instanceof Stuck || (error instanceof Diagnosed && error.hung)

/** How many of its mods one start of a pack server may learn about before it gives up. */
const LEARNED_PER_START = 3

/**
 * What every operation that ends in "running" does after the provider says the workload is up.
 * A server is joinable only after all of it: running, answering pings, and holding the access
 * record Blockly promised.
 */
export class BootSequence {
  readonly #runtime: Runtimes
  readonly #probe: ReadinessProbe
  readonly #access: AccessReconciler
  readonly #artifacts: ArtifactService
  readonly #logs: LogSource
  readonly #timeouts: BootTimeouts
  readonly #packs: Pick<PackContents, 'load' | 'leaveOutAfterCrash' | 'keepAfterCrash'> | null
  readonly #console: ServerConsole
  readonly #passwords: (serverId: string) => string[]

  constructor(deps: {
    runtime: Runtimes
    probe: ReadinessProbe
    access: AccessReconciler
    artifacts: ArtifactService
    /**
     * Followed while a server starts, so its steps move when the server does, and read when a
     * boot fails, to say what happened in words instead of a stack trace.
     */
    logs: LogSource
    timeouts: BootTimeouts
    /** What each pack holds, for checking what a pack server installed; null checks no packs. */
    packs?: Pick<PackContents, 'load' | 'leaveOutAfterCrash' | 'keepAfterCrash'> | null
    /** For the settings the game keeps in its world, which a start sets by command. */
    console: ServerConsole
    rconPasswords: (serverId: string) => string[]
  }) {
    this.#runtime = deps.runtime
    this.#probe = deps.probe
    this.#access = deps.access
    this.#artifacts = deps.artifacts
    this.#logs = deps.logs
    this.#timeouts = deps.timeouts
    this.#packs = deps.packs ?? null
    this.#console = deps.console
    this.#passwords = deps.rconPasswords
  }

  /**
   * `revision` is the configuration the server was started with; its jars are checked against
   * what is installed (§15.2). A jar cut short or changed where it is published can keep a
   * modded server from loading at all, or load something else than was chosen. Either way the
   * server gets one more boot with every jar downloaded again, then the operation fails.
   *
   * `reprovision` puts the server's desired runtime in place again and starts it: a pack server
   * whose start taught its pack something is started again on what it learned.
   */
  async run(
    ctx: OperationContext,
    server: MinecraftServer,
    started: RuntimeHandle,
    revision: Pick<ServerRevision, 'loader' | 'mods' | 'gameVersion' | 'loaderVersion'> &
      Partial<Pick<ServerRevision, 'modpack' | 'settings'>>,
    reprovision?: () => Promise<RuntimeHandle>,
    /**
     * Whether a start that stops answering is started once more, fresh. Not where the operation
     * already has a way back that starts it fresh (an apply or a start onto a change, whose
     * rollback boots what ran before; a restore, whose going back does), nor in that way back:
     * each boot would get its own second wait, and together they outlast the half hour the queue
     * gives an operation, which then runs a second attempt on the same machine at once.
     */
    options: { startAgainOnHang?: boolean } = {},
  ): Promise<void> {
    let handle = started
    const check = installCheck(revision)
    const pack = await this.#packCheckFor(revision.modpack ?? null)
    let downloadedAgain = false
    const again = async () => {
      downloadedAgain = true
      await this.#artifacts.refresh(server.id)
      await this.#runtime.restart(handle)
      await this.#up(ctx, handle)
    }

    const heard: string[] = []
    try {
      handle = await this.#upLearning(
        ctx,
        handle,
        heard,
        revision.modpack ?? null,
        reprovision,
        options.startAgainOnHang ?? true,
      )
    } catch (error) {
      // One that hung was started again already or said why it can't be, and one whose server
      // moved on is over.
      if (check === null || stoppedAnswering(error) || error instanceof NoLongerApplies) throw error
      await again()
    }
    // A modded server must have started what it was given: the pack's Minecraft and loader, or
    // the build pinned for its mods. A pack pins no build of Blockly's, so only its loader counts.
    if (revision.loader !== 'vanilla' && revision.loader !== 'paper' && heard.length > 0) {
      const wrong = bootMismatch(
        {
          gameVersion: revision.gameVersion,
          loader: revision.loader,
          loaderVersion: (revision.modpack ?? null) === null ? revision.loaderVersion : null,
        },
        bootedWith(heard),
      )
      if (wrong !== null) throw new PermanentFailure(wrong)
    }
    if (check !== null) {
      await ctx.step('verifying')
      let wrong = await this.#installedWrong(handle, check)
      if (wrong.length > 0 && !downloadedAgain) {
        await again()
        wrong = await this.#installedWrong(handle, check)
      }
      if (wrong.length > 0)
        throw new PermanentFailure(
          `${wrong.join(', ')} didn't install as chosen, even downloaded again. The published file may have changed.`,
        )
    }
    if (pack !== null) {
      await ctx.step('verifying')
      let wrong = await this.#packWrong(handle, pack)
      if (wrong.length > 0) {
        // Whatever is there in their place goes; the image fetches what is missing as it starts.
        await this.#runtime.exec(handle, packCleanup(wrong), 60)
        await this.#runtime.restart(handle)
        await this.#up(ctx, handle)
        wrong = await this.#packWrong(handle, pack)
      }
      if (wrong.length > 0)
        throw new PermanentFailure(
          `${wrong.map(modName).join(', ')} didn't install from the pack, even downloaded again. Where it is published may have changed.`,
        )
    }

    await ctx.step('access')
    try {
      // Operators and bans written for a server that checks players differently than they were
      // kept load only as it starts (§15.1): once, the server starts again to read them.
      const { restart } = await this.#access.reconcile(server, handle, 'full', { mayRestart: true })
      if (restart) {
        await this.#runtime.restart(handle)
        await this.#up(ctx, handle)
        await ctx.step('access')
        await this.#access.reconcile(server, handle, 'full')
      }
    } catch (error) {
      // Who can join couldn't be put back (§15.1): the server doesn't run with access it can't vouch for.
      if (error instanceof AccessReseedFailed) await this.#runtime.stop(handle).catch(() => undefined)
      throw error
    }

    // A setting the game keeps in its world rather than its properties is set as it starts, so a
    // change made while it was off, a new world, or one brought back from a backup plays as the
    // settings say. Best effort: the next start sets it again.
    const commands = revision.settings ? bootCommands(revision.settings, revision.gameVersion) : []
    if (commands.length > 0) {
      const target = {
        endpoint: this.#runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
        passwords: this.#passwords(server.id),
      }
      await this.#console.runAll(target, commands).catch(() => undefined)
    }
  }

  /**
   * Up, and for a pack server that stops over one of its mods in a way reading the pack couldn't
   * foresee, the pack learns it and the server starts again: a mod the catalog lets a server run
   * that stops one as it starts, being for players' games, is left out; one Blockly left out that
   * another needs is put back (docs/modpack-system.md § Verify). A few times at most.
   *
   * A server that stops answering as it starts is started once more, fresh, where `startAgain`
   * allows it, since waiting longer on a process that stopped answering only hangs the same way.
   * Any start again on what the pack learned counts as that one: two long waits at most, well
   * inside the half hour the queue gives an operation.
   */
  async #upLearning(
    ctx: OperationContext,
    first: RuntimeHandle,
    heard: string[],
    pack: ServerRevision['modpack'] | null,
    reprovision: (() => Promise<RuntimeHandle>) | undefined,
    startAgain: boolean,
  ): Promise<RuntimeHandle> {
    let handle = first
    let startedAgain = false
    for (let learned = 0; ; ) {
      try {
        await this.#up(ctx, handle, heard)
        return handle
      } catch (error) {
        if (stoppedAnswering(error)) {
          if (startedAgain) throw error
          // Its one wait is its only one: said as that, not as a second try.
          if (!startAgain)
            throw error instanceof Stuck ? new Stuck(error.reached, { cause: error.cause }, 1) : error
          if (error instanceof Stuck) {
            // A second start that comes up would leave no trace of the first: the log keeps it. Its
            // message is for a start that hung twice, so the log says what this one did.
            console.warn(
              `operation ${ctx.op.kind} ${ctx.op.id}: stopped answering at ${error.reached}, starting it once more (${inFull(error.cause)})`,
            )
            startedAgain = true
            heard.length = 0
            // A process that stopped answering may not stop when asked, and a restart kills one that
            // won't; one that stayed up would be waited on again by the next attempt, as this began.
            await this.#runtime.restart(handle)
            continue
          }
        }
        if (
          !(error instanceof Diagnosed) ||
          pack === null ||
          reprovision === undefined ||
          this.#packs === null
        )
          throw error
        if (learned >= LEARNED_PER_START) throw error
        const { playersOnly, missing } = error.found
        const changed =
          playersOnly !== undefined
            ? (await this.#packs.leaveOutAfterCrash(pack.artifact.sha512, playersOnly)).length > 0
            : missing !== undefined &&
              (await this.#packs.keepAfterCrash(
                pack.artifact.sha512,
                missing,
                pack.artifact.ref.kind === 'remote' ? pack.artifact.ref.url : null,
              )) !== null
        if (!changed) throw error
        learned++
        // A start again on what the pack learned is a fresh start: a hang after it is the second.
        startedAgain = true
        heard.length = 0
        handle = await reprovision()
      }
    }
  }

  async #up(ctx: OperationContext, handle: RuntimeHandle, heard: string[] = []): Promise<void> {
    const started = new Date()
    await ctx.step('booting')
    // What the server prints moves the steps on: Minecraft downloading, then Java starting, then
    // the world, rather than one step standing for all of it.
    const reading = new AbortController()
    let reached: Reached = 'booting'
    let crashReports = 0
    const following = followBoot(
      this.#logs.tail(handle, reading.signal),
      reading.signal,
      (step) => {
        reached = step
        return ctx.step(step)
      },
      (line) => {
        // The lines that say what started, which come long before the world opens.
        if (heard.length < BANNER_LINES_KEPT && namesWhatStarted(line)) heard.push(line)
        if (reportsCrash(line)) crashReports++
      },
    )
    try {
      try {
        await this.#runtime.waitRunning(handle, AbortSignal.timeout(this.#timeouts.runningMs))
      } catch (error) {
        // One that stopped before it was even up still said why, if it got far enough to say.
        throw (await this.#diagnosed(handle)) ?? error
      }
      await this.#waitReady(
        ctx,
        handle,
        () => reached,
        started,
        () => crashReports,
      )
    } finally {
      reading.abort()
      await following
    }
  }

  /** A pack's jars to check, from what reading the pack found; null for a pack never read. */
  async #packCheckFor(pack: ServerRevision['modpack'] | null): Promise<PackCheck | null> {
    if (pack === null || this.#packs === null) return null
    const contents = await this.#packs.load(pack.artifact.sha512).catch(() => null)
    if (contents === null) return null
    const leftOut = new Set(pack.leaveOut ?? [])
    return packCheck(contents.jars.filter((jar) => !leftOut.has(jar.path)))
  }

  /** The pack's jars the image installed wrong: missing, or holding other bytes. */
  async #packWrong(handle: RuntimeHandle, check: PackCheck): Promise<string[]> {
    const result = await this.#runtime.exec(handle, check.command, 120)
    if (result.exitCode !== 0) throw new Error(`Checking the pack's jars failed: ${result.stderr.trim()}`)
    return packProblems(check, result.stdout)
  }

  /** The mods whose installed jar is missing or holds other bytes than the revision pins. */
  async #installedWrong(handle: RuntimeHandle, check: InstallCheck): Promise<string[]> {
    const result = await this.#runtime.exec(handle, check.command, 60)
    if (result.exitCode !== 0) throw new Error(`Checking the installed jars failed: ${result.stderr.trim()}`)
    return installProblems(check, parseInstalled(result.stdout))
  }

  /**
   * `reached` is how far the start's own output showed it got, for saying where it stopped;
   * `since`, when this start began; `crashReports`, how many crash reports its output has said
   * it wrote.
   */
  async #waitReady(
    ctx: OperationContext,
    handle: RuntimeHandle,
    reached: () => Reached,
    since: Date,
    crashReports: () => number,
  ): Promise<void> {
    const endpoint = this.#runtime.endpoint(handle, PORT_NAMES.game, 'control')
    const deadline = Date.now() + this.#timeouts.readyMs
    let lastError: unknown = null
    let failureRead = since.getTime()
    let reportsRead = 0
    for (;;) {
      try {
        await this.#probe.ping(endpoint, AbortSignal.timeout(5_000))
        return
      } catch (error) {
        lastError = error
      }
      const observation = await this.#runtime.observe(handle)
      if (observation.state === 'crashed' || observation.state === 'stopped')
        throw await this.#whyItStopped(handle, stoppedWhile(reached()))
      // The provider starts a process that failed again, as it was, and it fails the same way:
      // Cabricality on staging (2026-09-28) stopped over a missing mod three more times, for two
      // minutes, before Fly gave up and its pack could learn. What its output names is the answer
      // now; anything else, the provider's start again may still get past.
      if (observation.failedAt !== undefined && observation.failedAt.getTime() >= failureRead) {
        failureRead = observation.failedAt.getTime() + 1
        const found = await this.#diagnosed(handle)
        if (found instanceof Diagnosed) throw found
      }
      // A process can write its crash report and run on without ever answering: Zombie Invade
      // 100 Days on staging (2026-09-28) stopped over a mod made for players' games, then held
      // its start for the whole ten minutes before its pack could learn. A report whose cause the
      // output names is the answer now, as a stop would be.
      if (crashReports() > reportsRead) {
        reportsRead = crashReports()
        const found = await this.#diagnosed(handle)
        if (found instanceof Diagnosed) throw found
      }
      // A server sent to the trash while it loads waits no longer, so the decommission queued
      // behind this takes its machine away now (2026-09-27: one ran on for ten minutes). A read
      // that fails is no reason to stop waiting.
      if (!(await ctx.stillApplies().catch(() => true))) throw new NoLongerApplies()
      if (Date.now() >= deadline) break
      await sleep(2_000)
    }
    // It may still have printed why. A cause that a start again gets past, like a port the last
    // run held, is a hang all the same. What the last ping ran into is the platform's to read.
    const found = await this.#diagnosed(handle, true)
    if (found instanceof Diagnosed) throw found
    throw new Stuck(reached(), { cause: found ?? lastError })
  }

  /**
   * What the server itself said before it stopped. A recognised failure becomes the sentence its
   * owner reads and the one action that fixes it; anything else keeps the plain message, and a
   * log Blockly can't read is never a reason to fail differently.
   */
  async #whyItStopped(handle: RuntimeHandle, fallback: string): Promise<Error> {
    return (await this.#diagnosed(handle)) ?? new NotReady(fallback)
  }

  /**
   * What the server's output says stopped it, or null where it says nothing recognised. `hung`:
   * it stopped answering rather than stopped.
   */
  async #diagnosed(handle: RuntimeHandle, hung = false): Promise<Error | null> {
    const lines = await this.#logs.recent(handle, LOG_LINES_READ).catch(() => [])
    const found = diagnose(lines.map((line) => line.text))
    if (found === null) return null
    // Starting it again is worth a retry; everything else needs someone to change something.
    return found.remedy === 'retry' ? new NotReady(found.summary) : new Diagnosed(found, hung)
  }
}

const MILESTONES = ['starting', 'loading_world'] as const

/** How far a start got, by what its output showed. */
type Reached = 'booting' | (typeof MILESTONES)[number]

/**
 * What a start that stopped for a reason nobody recognised was doing, by how far its output
 * showed it got. Never "loading its world" when it never got there: Better MC's first start
 * (2026-09-24) stopped at a mod's window before Java had loaded anything, and was said to have
 * stopped while loading its world.
 */
export function stoppedWhile(reached: Reached): string {
  switch (reached) {
    case 'booting':
      return 'It stopped while being set up, before Minecraft started.'
    case 'starting':
      return 'It stopped while Minecraft was starting, before its world opened.'
    case 'loading_world':
      return 'The server stopped while loading its world.'
  }
}

/**
 * What a start that kept hanging was doing, by how far its output showed it got. It was started a
 * second time before this is said; nothing it printed said why.
 */
export function stuckWhile(reached: Reached, tries: 1 | 2 = 2): string {
  const again = tries === 2 ? ', even on a second try' : ''
  switch (reached) {
    case 'booting':
      return `It never finished being set up${again}.`
    case 'starting':
      return `Minecraft never finished starting${again}.`
    case 'loading_world':
      return `Its world never finished loading${again}.`
  }
}

/**
 * Moves a start's steps on as its output gets there, only ever forward. Output that ends, or
 * can't be read, leaves the steps where they are: whether the server started is the ping's to
 * say, not the log's. It reads on past the last step until the start is over, so `heard` hears a
 * crash report written as the world loads too.
 */
export async function followBoot(
  lines: AsyncIterable<LogLine>,
  signal: AbortSignal,
  step: (step: (typeof MILESTONES)[number]) => Promise<void>,
  heard?: (line: string) => void,
): Promise<void> {
  let reached = -1
  try {
    for await (const line of lines) {
      if (signal.aborted) return
      heard?.(line.text)
      const milestone = bootMilestone(line.text)
      const at = milestone === null ? -1 : MILESTONES.indexOf(milestone)
      if (at <= reached) continue
      reached = at
      await step(MILESTONES[at] ?? 'starting')
    }
  } catch {
    // A log that can't be followed changes nothing about the start itself.
  }
}

/** How many lines saying what started are kept from a boot: far more than any loader prints. */
const BANNER_LINES_KEPT = 50

/** Enough of the tail to hold a crash report's cause, which sits well above the last line. */
const LOG_LINES_READ = 300

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
