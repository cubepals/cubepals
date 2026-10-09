'use client'

/**
 * The machine stratum's demonstration: one start, told twice.
 *
 * The left column is what the owner's page says while a server is built, in the product's own
 * words (apps/web/src/lib/present.ts). The right column is what the worker is doing at that
 * moment, by its own step names. Above them, the two answers that size the machine, worked out by
 * the control plane's real rules; and a way to break the start, each a failure Blockly recognises,
 * to show what it reads and what it does next.
 *
 * Nothing is started: this is a simulation, sped up. Every string set in mono is the codebase's,
 * and each constant names the file it comes from.
 *
 * Nothing here waits to be pressed. Left alone it plays itself (`useTour`): the modpack and the
 * bigger machine it makes, a failure Blockly mends without asking, one whose mending is the owner's
 * press, and a plain start that goes through. The chips and buttons stay a person's to press at any time.
 */
import { type ReactNode, useEffect, useReducer, useRef } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './machine.module.css'

type Play = 'plain' | 'pack'
type Party = '5' | '10' | '20' | 'more'
type Break = 'none' | 'memory' | 'playersMod' | 'missingMod' | 'hang' | 'jar'

/**
 * Who's playing: the chips' own words, the size each sells and the players it holds.
 * apps/control/src/app/servers/queries.ts, apps/control/src/domain/server/size.ts
 */
const PARTY: Record<Party, { label: string; gb: number; maxPlayers: number }> = {
  '5': { label: 'Up to 5', gb: 3, maxPlayers: 5 },
  '10': { label: 'Up to 10', gb: 4, maxPlayers: 10 },
  '20': { label: 'Up to 20', gb: 8, maxPlayers: 20 },
  more: { label: 'More', gb: 8, maxPlayers: 40 },
}
const PARTIES: readonly Party[] = ['5', '10', '20', 'more']
/** The biggest size sold, which the memory bar is drawn against. size.ts */
const BIGGEST_GB = 8

/**
 * What to play, by the create page's own names for the two rows.
 *
 * "Survival" is plain Minecraft on the default release, which needs no more than the smallest
 * size (apps/control/src/app/setups/templates.ts, apps/control/src/minecraft/versions.ts,
 * apps/control/src/app/setups/service.ts).
 *
 * "A modpack" is an example pack invented for this page: NeoForge on Minecraft 1.21.1, with
 * fewer than 150 mods, under 400 MB of jars, no tag that sizes it and no word from its author on
 * memory, so it starts on the middle size (apps/control/src/minecraft/pack-build.ts). A
 * pack's server type is MODRINTH (apps/control/src/minecraft/runtime-spec.ts).
 *
 * Java follows the release: 25 for 26.x, 21 for 1.20.5 to 1.21.x (versions.ts).
 */
const PLAY: Record<
  Play,
  {
    label: string
    version: string
    java: number
    type: string
    needsGb: number
    modded: boolean
    pack: string | null
    why: string
  }
> = {
  plain: {
    label: 'Survival',
    version: '26.3',
    java: 25,
    type: 'VANILLA',
    needsGb: 3,
    modded: false,
    pack: null,
    why: 'plain Minecraft runs on the smallest size',
  },
  pack: {
    label: 'A modpack',
    version: '1.21.1',
    java: 21,
    type: 'MODRINTH',
    needsGb: 4,
    modded: true,
    // A placeholder on purpose: a made-up name could turn out to be a pack somebody publishes.
    pack: 'Example Pack',
    why: 'a pack that doesn’t say what it needs starts on the middle size',
  },
}
const PLAYS: readonly Play[] = ['plain', 'pack']
/** How many mods the example pack brings, for the owner's line that counts them as they land. */
const PACK_MODS = 96

/** The share of memory that becomes the Java heap, plain and with mods. runtime-spec.ts */
const HEAP_SHARE = { plain: 0.75, modded: 0.65 }
/** From this much memory up, at least this much stays outside the heap. runtime-spec.ts */
const KEPT_OUTSIDE_FROM_MB = 3072
const KEPT_OUTSIDE_MB = 1024
/** The image every server runs, pinned to one release; its tag ends in the Java. runtime-spec.ts */
const IMAGE = 'itzg/minecraft-server:2026.9.1-java'

interface Machine {
  gb: number
  memoryMb: number
  heapMb: number
  /** Whether the gigabyte kept outside the heap decided it, rather than the share. */
  floored: boolean
  cores: number
  image: string
}

/** The machine two answers make, by the control plane's own rules. */
function machineFor(play: Play, party: Party): Machine {
  const played = PLAY[play]
  // The bigger of what the group needs and what it runs needs. setups/service.ts
  const gb = Math.max(PARTY[party].gb, played.needsGb)
  const memoryMb = gb * 1024
  // runtime-spec.ts
  const share = Math.floor(memoryMb * (played.modded ? HEAP_SHARE.modded : HEAP_SHARE.plain))
  const heapMb = memoryMb >= KEPT_OUTSIDE_FROM_MB ? Math.min(share, memoryMb - KEPT_OUTSIDE_MB) : share
  // Dedicated cores by memory. apps/control/src/infra/fly/machine-config.ts
  const cores = memoryMb <= 3072 ? 1 : memoryMb <= 4096 ? 2 : 4
  return { gb, memoryMb, heapMb, floored: heapMb < share, cores, image: `${IMAGE}${played.java}` }
}

/**
 * The next size up, by the group that sells it: what a server out of memory is offered in one
 * press. apps/control/src/app/servers/queries.ts
 */
const roomier = (gb: number): Party | undefined => PARTIES.find((party) => PARTY[party].gb > gb)

/**
 * The worker's own step names, in the order a first build passes them
 * (apps/control/src/app/operations/runner.ts). `queued` is what the page calls an operation
 * that has reported no step yet (apps/web/src/lib/present.ts).
 */
type Step =
  | 'queued'
  | 'allocating'
  | 'storage'
  | 'compute'
  | 'booting'
  | 'starting'
  | 'loading_world'
  | 'verifying'
  | 'access'
const STEPS: readonly Step[] = [
  'queued',
  'allocating',
  'storage',
  'compute',
  'booting',
  'starting',
  'loading_world',
  'verifying',
  'access',
]

/**
 * Plain Minecraft installs no jars, so there is nothing to hash and the step never happens.
 * apps/control/src/minecraft/install-check.ts, apps/control/src/app/operations/boot.ts
 */
const stepsFor = (play: Play): readonly Step[] =>
  PLAY[play].modded ? STEPS : STEPS.filter((step) => step !== 'verifying')

/** The owner's four steps, each named at the first worker step it covers. present.ts */
function titleOf(step: Step, play: Play): string | null {
  const { version, pack } = PLAY[play]
  switch (step) {
    case 'queued':
      return 'Picking a place'
    case 'booting':
      return pack === null ? `Getting Minecraft ${version}` : `Downloading ${pack}`
    case 'starting':
      return 'Starting it up'
    case 'loading_world':
      return 'Creating your world'
    default:
      return null
  }
}

/**
 * The line under the owner's step while the server prints nothing worth showing (present.ts).
 * A pack's mods are counted as they land (apps/web/src/app/(app)/servers/[id]/boot-line.tsx).
 */
function lineOf(step: Step, play: Play): string {
  const { version, pack } = PLAY[play]
  switch (step) {
    case 'queued':
      return 'Getting started'
    case 'allocating':
      return 'Finding room for it'
    case 'storage':
      return 'Setting aside space for your world'
    case 'compute':
      return 'Getting its home ready'
    case 'booting':
      return pack === null ? `Setting up Minecraft ${version}` : `${PACK_MODS} mods downloaded`
    case 'starting':
      return `Starting Minecraft ${version}`
    case 'loading_world':
      return 'Shaping the land'
    case 'verifying':
      return 'Checking its mods are the ones chosen'
    case 'access':
      return 'Letting players in'
  }
}

interface Fault {
  chip: string
  /** The step the failure surfaces at. */
  at: Step
  /** Only a server that runs mods can fail this way. */
  pack: boolean
  /**
   * Where the start begins again once Blockly has put it right without asking: a pack that learnt
   * something is provisioned anew (apps/control/src/app/operations/handlers.ts), a
   * restart begins at `booting` (boot.ts). Null where putting it right is the
   * owner's.
   */
  again: Step | null
  /** How long the step is waited on before the failure shows, where it is a wait that fails. */
  waitMs?: number
  /** Whose words the lines below are. */
  said: string
  /** The lines as printed; `tell` marks the ones that give it away. */
  log: readonly { text: string; tell?: boolean }[]
  /** What Blockly makes of it. For the first three, diagnosis.ts's own sentence. */
  reads: string
}

/**
 * Ways a start breaks. The first three are read from the server's output by
 * apps/control/src/minecraft/diagnosis.ts; their lines and sentences are the ones its test feeds it
 * and expects (diagnosis.test.ts). The last two are found by the boot
 * sequence itself: a start that stops answering (boot.ts, with the ping's own error
 * from apps/control/src/infra/mc-protocol/slp.ts; its line is boot.ts, with the
 * operation's id left out and the cut marked), and a pack's jar that holds other bytes than the
 * pack lists (install-check.ts, boot.ts).
 */
const FAULTS: Record<Exclude<Break, 'none'>, Fault> = {
  memory: {
    chip: 'Out of memory',
    at: 'loading_world',
    pack: false,
    again: null,
    said: 'What the server printed',
    log: [
      { text: '[12:00:00] [Server thread/INFO]: Preparing spawn area: 4%' },
      { text: 'java.lang.OutOfMemoryError: Java heap space', tell: true },
      { text: '\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:661)' },
    ],
    reads:
      'It ran out of memory while loading. Its world, mods or players need more room than this size has.',
  },
  playersMod: {
    chip: 'A mod made for players’ games',
    at: 'starting',
    pack: true,
    again: 'allocating',
    said: 'What the server printed',
    log: [
      {
        text: 'Exception in thread "main" net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      },
      { text: '\t- Sodium Extras (sodiumextras) has failed to load correctly', tell: true },
      { text: '\t  java.lang.NoClassDefFoundError: net/minecraft/client/gui/screens/Screen', tell: true },
    ],
    reads: 'Sodium Extras only runs in players’ games, and stopped the server as it started.',
  },
  missingMod: {
    chip: 'A mod missing another',
    at: 'starting',
    pack: true,
    again: null,
    said: 'What the server printed',
    log: [
      {
        text: 'Exception in thread "main" net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      },
      { text: '\t- Mod yungsmenutweaks requires yungsapi 1.21.1-NeoForge-5.1.2 or above', tell: true },
      { text: '\t  Currently, yungsapi is not installed', tell: true },
    ],
    reads: 'yungsmenutweaks needs yungsapi, which isn’t installed.',
  },
  hang: {
    chip: 'A start that hangs',
    at: 'loading_world',
    pack: false,
    again: 'booting',
    waitMs: 2600,
    said: 'What Cubepals logged',
    log: [
      {
        text: 'operation provision …: stopped answering at loading_world, starting it once more (The status ping timed out)',
        tell: true,
      },
    ],
    reads: 'A start that stopped answering, with nothing in its output to say why.',
  },
  jar: {
    chip: 'A jar that arrives changed',
    at: 'verifying',
    pack: true,
    again: 'booting',
    said: 'What the check runs',
    log: [{ text: 'for f in "$@"; do [ -f "$f" ] && sha512sum -- "$f"; done', tell: true }],
    reads:
      'One jar holds other bytes than the pack lists: a download cut short, or a file changed where it is published.',
  },
}
const BREAKS: readonly Break[] = ['none', 'memory', 'playersMod', 'missingMod', 'hang', 'jar']

/** How many mods one start of a pack server may learn about. apps/control/src/app/operations/boot.ts */
const LEARNED_PER_START = 3

/** One moment of the run: the step it is on, whether this is the start again, and for how long. */
interface Frame {
  step: Step | 'online'
  again: boolean
  /** The step has stopped here, and what was found is on show. */
  fault: boolean
  hold: number
}

/**
 * Sped up: a step is held this long, and a failure long enough to read before the start carries on.
 * The tour's windows (TOUR_SECONDS) are counted from these two.
 */
const STEP_MS = 850
const READ_MS = 3600

/**
 * The run as a list of moments. A start that breaks stops at the step the failure surfaces at;
 * where Blockly mends it, the start begins again as the boot sequence does (boot.ts) and
 * goes on to the end.
 */
function framesFor(play: Play, broken: Break): Frame[] {
  const order = stepsFor(play)
  const pass = (steps: readonly Step[], again: boolean): Frame[] =>
    steps.map((step) => ({ step, again, fault: false, hold: STEP_MS }))
  const online = (again: boolean): Frame => ({ step: 'online', again, fault: false, hold: 0 })
  const fault = broken === 'none' ? null : FAULTS[broken]
  const stop = fault === null ? -1 : order.indexOf(fault.at)
  if (fault === null || stop === -1) return [...pass(order, false), online(false)]
  const first = pass(order.slice(0, stop + 1), false)
  const waited = first[first.length - 1]
  if (waited && fault.waitMs !== undefined) waited.hold = fault.waitMs
  const stopped: Frame = { step: fault.at, again: false, fault: true, hold: READ_MS }
  if (fault.again === null) return [...first, stopped]
  return [...first, stopped, ...pass(order.slice(order.indexOf(fault.again)), true), online(true)]
}

interface State {
  play: Play
  party: Party
  broken: Break
  /** Which moment of the run is showing; null before a start. */
  at: number | null
  running: boolean
}

type Action =
  | { type: 'play'; play: Play }
  | { type: 'party'; party: Party }
  | { type: 'break'; broken: Break }
  /** `still`: the viewer asked for less motion, so the run arrives at its end at once. */
  | { type: 'start'; still: boolean }
  | { type: 'room'; party: Party; still: boolean }
  | { type: 'tick' }

const AT_REST = { at: null, running: false } as const

/** The answers the tour puts in place before a step of its story. */
type Asked = Pick<State, 'play' | 'party' | 'broken'>

/** The answers the demonstration opens on, and where the tour's story begins again. */
const OPENING: Asked = { play: 'plain', party: '5', broken: 'none' }

/**
 * The tour's windows: how many seconds the bar runs before each of its steps, which is how long the
 * step before it has to play out and be looked at.
 *
 * 0. Before the modpack is picked: a plain start runs 8 steps, 6.8 s (after the bigger size, 9
 *    steps, 7.65 s). The very first time it is TOUR_FIRST_SECONDS instead.
 * 1. Before a mod breaks it: nothing runs; the machine's new numbers are there to look at.
 * 2. Before it starts again: 6 steps to the stop, 5.1 s, and READ_MS of reading it, 8.7 s in all,
 *    so the bar runs out as Blockly begins the start again.
 * 3. Before it runs out of memory: that second go runs 8 steps, 6.8 s. A start that step 2 had to
 *    press itself has nothing to mend, and runs 9 steps at most, 7.65 s.
 * 4. Before the bigger size is given: 7 steps to the stop, 5.95 s, and the rest to read it.
 * 5. Before a plain server starts: the start on the bigger size runs 9 steps, 7.65 s.
 */
const TOUR_SECONDS = [9.5, 4, 9, 9.5, 10, 10]
/** The wait before the very first step, so the demonstration is already moving when someone arrives. */
const TOUR_FIRST_SECONDS = 3

function begin(state: State, still: boolean): State {
  const last = framesFor(state.play, state.broken).length - 1
  return still ? { ...state, at: last, running: false } : { ...state, at: 0, running: true }
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'play': {
      // Plain Minecraft has no mods to break: a failure that needs them is put away.
      const broken =
        action.play === 'plain' && state.broken !== 'none' && FAULTS[state.broken].pack
          ? 'none'
          : state.broken
      return { ...state, ...AT_REST, play: action.play, broken }
    }
    case 'party':
      return { ...state, ...AT_REST, party: action.party }
    case 'break': {
      // A failure only mods can cause brings the modpack with it.
      const play = action.broken !== 'none' && FAULTS[action.broken].pack ? 'pack' : state.play
      return { ...state, ...AT_REST, broken: action.broken, play }
    }
    case 'start':
      return begin(state, action.still)
    case 'room':
      // The bigger size is what the owner pressed for; with it, the start goes through.
      return begin({ ...state, party: action.party, broken: 'none' }, action.still)
    case 'tick': {
      if (!state.running || state.at === null) return state
      const last = framesFor(state.play, state.broken).length - 1
      const at = Math.min(state.at + 1, last)
      return { ...state, at, running: at < last }
    }
  }
}

/** The room's lamps while nothing runs: low, not out. */
const LAMPS_LOW = 0.25

type RowState = 'idle' | 'todo' | 'active' | 'done' | 'stopped' | 'lit'

const STATE_WORDS: Record<RowState, string> = {
  idle: '',
  todo: 'Not reached yet.',
  active: 'Running now.',
  done: 'Done.',
  stopped: 'Stopped here.',
  lit: 'On now.',
}

/** A real string inside a sentence. */
function V({ children }: { children: ReactNode }) {
  return <span className={`bl-mono ${styles.v}`}>{children}</span>
}

/** What is happening at a step, with one real detail of it. */
function Happening({
  step,
  play,
  machine,
  mended,
}: {
  step: Step
  play: Play
  machine: Machine
  /** The failure this start is the second go after, or null on a first go. */
  mended: Break | null
}) {
  const played = PLAY[play]
  switch (step) {
    case 'queued':
      // One queue, strictly in order for each server. docs/architecture.md
      return (
        <>
          The <V>provision</V> operation waits its turn: a server runs one at a time, in order.
        </>
      )
    case 'allocating':
      return (
        <>
          Room for <V>{machine.memoryMb} MB</V> is checked before anything is made.
        </>
      )
    case 'storage':
      // apps/control/src/minecraft/jars.ts
      return (
        <>
          A disk for the world, mounted at <V>/data</V>.
        </>
      )
    case 'compute':
      return (
        <>
          <V>{machine.image}</V> The pinned image, on the Java that Minecraft {played.version} needs, with{' '}
          <V>{machine.memoryMb} MB</V> and {machine.cores} dedicated {machine.cores === 1 ? 'core' : 'cores'}.
        </>
      )
    case 'booting':
      // runtime-spec.ts; the pack's left-out jars, runtime-spec.ts
      return (
        <>
          <V>TYPE={played.type}</V> <V>VERSION={played.version}</V> <V>MEMORY={machine.heapMb}M</V>{' '}
          <V>USE_AIKAR_FLAGS=TRUE</V> The image installs{' '}
          {played.pack === null ? 'Minecraft' : 'the pack and its NeoForge'} from these, with the heap and
          Aikar’s flags set.
          {mended === 'playersMod' && (
            <>
              {' '}
              This time <V>MODRINTH_EXCLUDE_FILES</V> names the jar to leave out.
            </>
          )}
          {mended === 'hang' && ' This is its one more start, fresh.'}
          {mended === 'jar' && ' This time the jar that was removed is fetched again.'}
        </>
      )
    case 'starting':
      // apps/control/src/minecraft/logs.ts
      return (
        <>
          <V>[init] Starting the Minecraft server...</V> The image hands over to Java, and this line moves the
          step.
        </>
      )
    case 'loading_world':
      // logs.ts; readiness, apps/control/src/infra/mc-protocol/slp.ts
      return (
        <>
          <V>Preparing level "world"</V> Not ready until it answers Minecraft’s own status ping, the question
          the multiplayer screen asks.
        </>
      )
    case 'verifying':
      // install-check.ts
      return (
        <>
          <V>sha512sum</V> of every jar the pack installed, against the hashes the pack lists.
        </>
      )
    case 'access':
      // apps/control/src/minecraft/access.ts, boot.ts
      return (
        <>
          Cubepals’ record of who may join is put onto the server’s own files: <V>whitelist.json</V>{' '}
          <V>ops.json</V> <V>banned-players.json</V>
        </>
      )
  }
}

/** One step of the timeline: the owner's telling, the node on the rail, the machine's telling. */
function Row({
  state,
  title,
  line,
  name,
  children,
  found,
}: {
  state: RowState
  /** The owner's step this one begins, if it begins one. */
  title: string | null
  line: string
  name: string
  children: ReactNode
  /** What was found here, where the start stopped at this step. */
  found?: ReactNode
}) {
  return (
    <li
      className={styles.row}
      data-state={state}
      data-first={title === null ? undefined : ''}
      aria-current={state === 'active' ? 'step' : undefined}
    >
      <div className={styles.reads}>
        {title !== null && <p className={styles.title}>{title}</p>}
        <p className={styles.line}>
          <span className={styles.words}>{line}</span>
        </p>
      </div>
      <span className={styles.node} aria-hidden>
        <span className={styles.mark}>
          {(state === 'idle' || state === 'todo') && <i className="bl-dither" data-level="3" />}
        </span>
      </span>
      <div className={styles.does}>
        <p className={styles.name}>
          <span className={`bl-mono ${styles.id}`}>{name}</span>
          {state === 'stopped' ? (
            <span className={`bl-small ${styles.halt}`}>stopped here</span>
          ) : (
            <span className={styles.sr}> {STATE_WORDS[state]}</span>
          )}
        </p>
        <p className={`bl-small ${styles.detail}`}>{children}</p>
      </div>
      {found}
    </li>
  )
}

export function MachineDemo() {
  const root = useRef<HTMLDivElement>(null)
  const starter = useRef<HTMLButtonElement>(null)
  const offer = useRef<HTMLButtonElement>(null)
  const inView = useInView(root)
  const still = useReducedMotion()
  const [state, dispatch] = useReducer(reduce, { ...OPENING, ...AT_REST })
  const { play, party, broken, at, running } = state

  const played = PLAY[play]
  const machine = machineFor(play, party)
  const order = stepsFor(play)
  const frames = framesFor(play, broken)
  const frame = at === null ? undefined : frames[at]
  const fault = broken === 'none' ? null : FAULTS[broken]
  const found = at !== null && frames.slice(0, at + 1).some((moment) => moment.fault)
  const online = frame?.step === 'online'
  const failed = frame?.fault === true && !running
  const hold = frame?.hold

  // Simulated time: each moment is held, then the next arrives. Only while it can be seen.
  useEffect(() => {
    if (!running || !inView || at === null || hold === undefined) return
    const timer = setTimeout(() => dispatch({ type: 'tick' }), hold)
    return () => clearTimeout(timer)
  }, [running, inView, at, hold])

  // The room in the chunk: low while nothing runs, full while the server does, low again where a
  // start has stopped. Handed back when the demonstration is out of sight.
  const lit = frame !== undefined && !frame.fault && (running || online)
  useEffect(() => {
    stage.glow('machine', inView ? (lit ? 1 : LAMPS_LOW) : null)
  }, [inView, lit])
  // The room's scene is this same start, on a server built from the game's parts: a rack as tall as
  // the size, a furnace for each core, the small world of what is played on top, and each step
  // doing in the room what it does here. So the room is told the machine, the step the start has
  // reached (`idle` before one, `online` after) and whether it has stopped there. Told even while
  // out of sight, so the room is never a step behind when the page comes back to it.
  const reached = frame?.step ?? 'idle'
  const stopped = frame?.fault === true
  useEffect(() => {
    stage.show('machine', {
      gb: machine.gb,
      cores: machine.cores,
      modded: played.modded,
      step: reached,
      fault: stopped,
    })
  }, [machine.gb, machine.cores, played.modded, reached, stopped])
  useEffect(
    () => () => {
      stage.glow('machine', null)
      stage.show('machine', null)
    },
    [],
  )

  const start = () => {
    if (!running) dispatch({ type: 'start', still })
  }

  const stateOf = (step: Step): RowState => {
    if (frame === undefined) return 'idle'
    if (frame.step === 'online') return 'done'
    const here = order.indexOf(step)
    const now = order.indexOf(frame.step)
    if (here < now) return 'done'
    if (here > now) return 'todo'
    return frame.fault ? 'stopped' : 'active'
  }

  // What the owner's page says of the whole start. present.ts; ui/status.tsx
  const waiting = fault?.waitMs !== undefined && frame?.step === fault.at && !frame.again
  const says =
    frame === undefined
      ? 'Not started'
      : online
        ? 'Online'
        : failed
          ? 'We could not build your world'
          : waiting
            ? 'Taking a little longer than usual'
            : 'Building your world'
  const group =
    frame === undefined || frame.step === 'online'
      ? null
      : [...order.slice(0, order.indexOf(frame.step) + 1)]
          .reverse()
          .map((step) => titleOf(step, play))
          .find((title) => title !== null)
  const more =
    frame === undefined
      ? ''
      : online
        ? `0 / ${PARTY[party].maxPlayers} players.`
        : frame.fault && fault !== null
          ? `Stopped at ${frame.step}. Cubepals reads that as: ${fault.reads}`
          : `${group ?? ''}.`

  const bigger = roomier(machine.gb)
  const heapPercent = Math.round((played.modded ? HEAP_SHARE.modded : HEAP_SHARE.plain) * 100)
  const biggestMb = BIGGEST_GB * 1024

  // Left alone, it plays itself. Every step is a press the demonstration already takes, and none
  // assumes the one before it ran: whoever used it last may have left it anywhere, so a step first
  // puts the answers where its part of the story needs them, by the chips' own presses and only
  // the ones still to make.
  const arrange = (want: Asked) => {
    if (party !== want.party) dispatch({ type: 'party', party: want.party })
    if (play !== want.play) dispatch({ type: 'play', play: want.play })
    if (broken !== want.broken) dispatch({ type: 'break', broken: want.broken })
  }
  const story = [
    // The modpack. Nothing runs: the machine under the questions grows to hold it.
    () => arrange({ play: 'pack', party: '5', broken: 'none' }),
    // A failure Blockly mends without asking: it stops, is read, and begins again by itself.
    () => {
      arrange({ play: 'pack', party: '5', broken: 'playersMod' })
      dispatch({ type: 'start', still })
    },
    // This step's bar runs out as that start begins again, which is the demonstration's own doing
    // and leaves nothing to press. Found standing anywhere else, this is the press that starts it,
    // with a failure Blockly mends put away first: that run is two starts long, longer than the
    // window that follows it.
    () => {
      if (fault !== null && fault.again !== null) dispatch({ type: 'break', broken: 'none' })
      dispatch({ type: 'start', still })
    },
    // A failure whose mending is the owner's.
    () => {
      arrange({ play: 'pack', party: '5', broken: 'memory' })
      dispatch({ type: 'start', still })
    },
    // The owner's one press, where it is on offer. Where it isn't, there is no button to press,
    // and the answers go back to where the story begins.
    () => {
      if (failed && broken === 'memory' && bigger !== undefined)
        dispatch({ type: 'room', party: bigger, still })
      else arrange(OPENING)
    },
    // And last, a plain server with nothing in its way: every step passes and it is online. (The
    // round begins with the modpack and not with this, because the modpack's change is at the top
    // of the demonstration, where someone arriving is looking.)
    () => {
      arrange(OPENING)
      dispatch({ type: 'start', still })
    },
  ]
  const tour = useTour({
    ref: root,
    // A start that is running is never cut short, the tour's own or a person's: the step is let
    // pass, and the next one finds the start finished and carries on from there.
    steps: story.map((press) => () => {
      if (running) return
      // Every step takes the failure's panel away. If the keyboard was left on its button, it is
      // handed to the one that stays, as the button's own press does, without moving the page.
      if (offer.current !== null && offer.current === document.activeElement)
        starter.current?.focus({ preventScroll: true })
      press()
    }),
    seconds: TOUR_SECONDS,
    first: TOUR_FIRST_SECONDS,
  })
  // What comes when the bar runs out, one for each step of the story.
  const coming = [
    'A modpack',
    'A mod breaks it',
    'It starts again',
    'Out of memory',
    at !== null && broken === 'memory' && bigger !== undefined
      ? `Give it ${PARTY[bigger].gb} GB`
      : 'Back to the start',
    'A server starts',
  ][tour.next]

  const panel =
    fault === null ? null : (
      <div className={`bl-frame bl-frame--bare ${styles.found}`}>
        <p className="bl-small">{fault.said}</p>
        <pre className={`bl-frame bl-frame--solid bl-mono ${styles.log}`}>
          {fault.log.map((line) => (
            <span key={line.text} className={styles.said} data-tell={line.tell || undefined}>
              {line.text}
            </span>
          ))}
        </pre>
        <p className="bl-small">Cubepals reads that as</p>
        <p className={styles.reading}>{fault.reads}</p>
        <p className="bl-small">
          {fault.again === null ? 'What the owner is offered' : 'What Cubepals does, without asking'}
        </p>
        <div className={styles.next}>
          {broken === 'memory' &&
            (bigger === undefined ? (
              <p>This is already the biggest size, so there is nothing bigger to offer.</p>
            ) : (
              <>
                {/* apps/web/src/app/(app)/servers/[id]/page.tsx */}
                <button
                  ref={offer}
                  type="button"
                  className="bl-btn bl-btn--sm"
                  onClick={() => {
                    dispatch({ type: 'room', party: bigger, still })
                    // This button leaves with the failure it answers, so the keyboard is handed to
                    // the one that stays.
                    starter.current?.focus()
                  }}
                >
                  Give it {PARTY[bigger].gb} GB
                </button>
                {/* Only a plan that sells a bigger size is offered one (queries.ts), and
                    only the biggest counts double (apps/control/src/domain/account/meter.ts). */}
                <p>
                  One press, on a plan that sells a bigger size. Cubepals never does this by itself
                  {PARTY[bigger].gb === BIGGEST_GB
                    ? ': the biggest size counts two of the plan’s hours for each hour it runs.'
                    : '.'}
                </p>
              </>
            ))}
          {broken === 'missingMod' && (
            <>
              {/* page.tsx */}
              <span className={styles.offer}>Change its mods</span>
              <p>Which mods to play is the owner’s to decide, so Cubepals stops here and says so.</p>
            </>
          )}
          {broken === 'playersMod' && (
            <p>
              The pack learns it. That jar is left out of every server playing this pack from now on, and this
              one starts again. One start may learn this way up to {LEARNED_PER_START} times.
            </p>
          )}
          {broken === 'hang' && <p>It gets one more start, fresh. A second hang fails for good.</p>}
          {broken === 'jar' && (
            <p>
              The jar is removed, the image fetches it again as the server restarts, and the hashes are
              checked once more.
            </p>
          )}
        </div>
      </div>
    )

  return (
    <div className={styles.demo} ref={root}>
      <TourBar tour={tour} label={coming} className={styles.tour} />
      <div className={styles.asks}>
        <fieldset className={styles.ask}>
          <legend className={styles.q}>What to play</legend>
          <div className={styles.chips}>
            {PLAYS.map((key) => (
              <button
                key={key}
                type="button"
                className="bl-chip"
                aria-pressed={play === key}
                onClick={() => dispatch({ type: 'play', play: key })}
              >
                {PLAY[key].label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className={styles.ask}>
          <legend className={styles.q}>Who’s playing</legend>
          <div className={styles.chips}>
            {PARTIES.map((key) => (
              <button
                key={key}
                type="button"
                className="bl-chip"
                aria-pressed={party === key}
                onClick={() => dispatch({ type: 'party', party: key })}
              >
                {PARTY[key].label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className={styles.sizing}>
        <p className={`bl-small ${styles.rule}`}>
          The group needs <V>{PARTY[party].gb} GB</V>. What’s played needs <V>{played.needsGb} GB</V>:{' '}
          {played.why}. The machine gets the bigger.
        </p>
        <div className={styles.bar} aria-hidden>
          <i className={styles.heap} style={{ width: `${(machine.heapMb / biggestMb) * 100}%` }} />
          <i
            className={`bl-dither ${styles.spare}`}
            data-level="3"
            style={{ width: `${((machine.memoryMb - machine.heapMb) / biggestMb) * 100}%` }}
          />
        </div>
        <p className={`bl-small ${styles.key}`} aria-hidden>
          <span>
            <i className={styles.heap} />
            Java heap
          </span>
          <span>
            <i className={`bl-dither ${styles.spare}`} data-level="3" />
            kept outside it, for Java itself and the system
          </span>
          <span>
            <i className={styles.room} />
            up to the biggest size, {BIGGEST_GB} GB
          </span>
        </p>
        <dl className={styles.sums}>
          <div>
            <dt className="bl-small">Memory</dt>
            <dd>
              <span className={`bl-mono bl-num ${styles.sum}`}>{machine.memoryMb} MB</span>
              <span className={`bl-small ${styles.sub}`}>
                the <V>{machine.gb} GB</V> size
              </span>
            </dd>
          </div>
          <div>
            <dt className="bl-small">Java heap</dt>
            <dd>
              <span className={`bl-mono bl-num ${styles.sum}`}>{machine.heapMb} MB</span>
              <span className={`bl-small ${styles.sub}`}>
                {machine.floored ? (
                  <>
                    all but <V>{KEPT_OUTSIDE_MB} MB</V>
                  </>
                ) : (
                  <>
                    <V>{heapPercent}%</V> of it{played.modded ? ', as it runs mods' : ''}
                  </>
                )}
              </span>
            </dd>
          </div>
          <div>
            <dt className="bl-small">Cores</dt>
            <dd>
              <span className={`bl-mono bl-num ${styles.sum}`}>{machine.cores}</span>
              <span className={`bl-small ${styles.sub}`}>dedicated</span>
            </dd>
          </div>
          <div>
            <dt className="bl-small">Java</dt>
            <dd>
              <span className={`bl-mono bl-num ${styles.sum}`}>{played.java}</span>
              <span className={`bl-small ${styles.sub}`}>for Minecraft {played.version}</span>
            </dd>
          </div>
        </dl>
      </div>

      <fieldset className={styles.ask}>
        <legend className={styles.q}>Break it</legend>
        <div className={styles.chips}>
          {BREAKS.map((key) => (
            <button
              key={key}
              type="button"
              className="bl-chip"
              aria-pressed={broken === key}
              onClick={() => dispatch({ type: 'break', broken: key })}
            >
              {key === 'none' ? 'Nothing breaks' : FAULTS[key].chip}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <div className={styles.run}>
          <button ref={starter} type="button" className="bl-btn" aria-disabled={running} onClick={start}>
            {running ? 'Starting' : at === null ? 'Start it' : 'Start it again'}
          </button>
          <p
            className={styles.status}
            aria-live={tour.auto ? 'off' : 'polite'}
            data-quiet={frame === undefined || undefined}
            data-on={online || undefined}
          >
            <span className={styles.says}>{says}</span>
            <span className={styles.sr}> {more}</span>
          </p>
        </div>
        <div className={styles.heads}>
          <p className={`bl-small ${styles.headReads}`}>What the owner reads</p>
          <p className={`bl-small ${styles.headDoes}`}>What is happening</p>
        </div>
        <ol className={styles.steps}>
          {order.map((step) => (
            <Row
              key={step}
              state={stateOf(step)}
              title={titleOf(step, play)}
              line={lineOf(step, play)}
              name={step}
              found={found && fault?.at === step ? panel : undefined}
            >
              <Happening step={step} play={play} machine={machine} mended={frame?.again ? broken : null} />
            </Row>
          ))}
          <Row
            state={frame === undefined ? 'idle' : online ? 'lit' : 'todo'}
            title="Online"
            line={`0 / ${PARTY[party].maxPlayers} players`}
            name="running"
          >
            {/* apps/control/src/domain/server/lifecycle.ts */}
            Its status moves from <V>provisioning</V> to <V>running</V>, and the address leads to it.
          </Row>
        </ol>
      </div>
    </div>
  )
}
