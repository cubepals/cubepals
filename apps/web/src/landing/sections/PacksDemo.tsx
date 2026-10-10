// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The packs stratum's demonstration: the sorting belt.
 *
 * One example pack is followed down four steps, in the order Blockly takes them
 * (docs/modpack-system.md § The pipeline): what kind of file it is, from the names inside it; what
 * it needs, read from the pack's own files; which of its jars a server runs; and the start, which
 * finds what reading couldn't, leaves that mod out and starts again. The hashes are checked there,
 * after the install, because that is when Blockly checks them
 * (apps/control/src/app/operations/boot.ts).
 *
 * One button advances it, and pressing it during a run finishes that run at once, so nothing has
 * to be waited for. Left alone it presses that button itself (`useTour`): the pack is read, sorted
 * and started, and then another kind of file is dropped. Nothing is read, installed or started:
 * this is a simulation, sped up. Every string set in mono is the codebase's, and each constant
 * names the file it comes from.
 */
import { type ReactNode, useEffect, useReducer, useRef, useState } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './packs.module.css'

/** The formats a dropped pack can be, by the control plane's own names. apps/control/src/minecraft/pack-layout.ts */
type Kind = 'mrpack' | 'curseforge' | 'packwiz' | 'instance' | 'server' | 'mods'

/** The order they are tried in; the first that fits is what the file is. pack-layout.ts */
const KINDS: readonly Kind[] = ['mrpack', 'curseforge', 'packwiz', 'instance', 'server', 'mods']

/** The kind after this one in that order, and after the last the first again. */
const kindAfter = (kind: Kind): Kind => KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length] ?? 'mrpack'

interface FileKind {
  chip: string
  /** What it is, in a sentence. */
  name: string
  /** A pack is dropped as one of these two. apps/control/src/app/packs/service.ts */
  ext: '.mrpack' | '.zip'
  /** Names found inside it; `tell` marks the ones that decide what it is. */
  inside: readonly { name: string; tell?: true }[]
  how: string
  /**
   * Where this kind of file can say how much memory its author gives it, or null where it has
   * nowhere to. Read as data: a server pack's `-Xmx` (apps/control/src/minecraft/server-pack.ts,
   * 207-214), an export's `recommendedRam` and an instance's `MaxMemAlloc`
   * (apps/control/src/minecraft/pack-manifests.ts).
   */
  asks: { file: string; key: string } | null
}

/**
 * Each kind, with the file names `detect` looks for (pack-layout.ts) and the folders a pack
 * of that kind carries (apps/control/src/minecraft/mrpack.ts). What is said of each is
 * docs/modpack-system.md § Sources.
 */
const FILES: Record<Kind, FileKind> = {
  mrpack: {
    chip: 'Modrinth pack',
    name: 'a Modrinth pack',
    ext: '.mrpack',
    inside: [
      { name: 'modrinth.index.json', tell: true },
      { name: 'overrides/' },
      { name: 'server-overrides/' },
    ],
    how: 'Its index names it. Every other kind is written out again as this one, so a server installs them all the same way.',
    asks: null,
  },
  curseforge: {
    chip: 'Launcher export',
    name: 'a launcher’s export',
    ext: '.zip',
    inside: [
      { name: 'manifest.json', tell: true },
      { name: 'overrides/', tell: true },
      { name: 'modlist.html' },
    ],
    how: 'A manifest beside its overrides folder. A server is built from it when it holds its mods; one that only lists them is turned away in a sentence.',
    asks: { file: 'manifest.json', key: 'recommendedRam' },
  },
  packwiz: {
    chip: 'Packwiz pack',
    name: 'a Packwiz pack',
    ext: '.zip',
    inside: [{ name: 'pack.toml', tell: true }, { name: 'index.toml', tell: true }, { name: 'mods/' }],
    how: 'Two files of settings name it. Each mod it points to has to be one Modrinth publishes.',
    asks: null,
  },
  instance: {
    chip: 'Launcher instance',
    name: 'a launcher’s instance',
    ext: '.zip',
    inside: [
      { name: 'mmc-pack.json', tell: true },
      { name: 'instance.cfg', tell: true },
      { name: '.minecraft/' },
    ],
    how: 'A launcher’s own folder for one installed pack, zipped as it sits on a computer.',
    asks: { file: 'instance.cfg', key: 'MaxMemAlloc' },
  },
  server: {
    chip: 'Server pack',
    name: 'a server pack',
    ext: '.zip',
    inside: [
      { name: 'variables.txt', tell: true },
      { name: 'user_jvm_args.txt', tell: true },
      { name: 'libraries/', tell: true },
      { name: 'mods/' },
    ],
    how: 'What an author ships to start a server with: a file of variables, Java’s arguments, the loader’s libraries. Its scripts are read and never run.',
    asks: { file: 'user_jvm_args.txt', key: '-Xmx4G' },
  },
  mods: {
    chip: 'Mods folder',
    name: 'a folder of mods',
    ext: '.zip',
    inside: [{ name: 'mods/', tell: true }],
    how: 'Nothing in it says what it is, so the jars are asked.',
    asks: null,
  },
}

/**
 * The example pack: Fabric on Minecraft 1.21.1, with the loader build a pack server here first
 * booted on. `build` is what the pack names; a
 * folder of mods names none, and gets the loader's current one (apps/control/src/app/packs/build.ts).
 */
const PACK = { game: '1.21.1', loader: 'Fabric', build: '0.16.7' }

/** The Java each Minecraft a pack can be for runs on. apps/control/src/minecraft/versions.ts */
const JAVAS: readonly { range: string; java: 8 | 17 | 21 | 25 }[] = [
  { range: '1.12.2 to 1.16.5', java: 8 },
  { range: '1.17 to 1.20.4', java: 17 },
  { range: '1.20.5 to 1.21.x', java: 21 },
  { range: '26.x', java: 25 },
]

/** The Java a Minecraft release needs, as the control plane works it out. versions.ts */
function javaFor(gameVersion: string): 8 | 17 | 21 | 25 {
  const [major = 0, minor = 0, patch = 0] = gameVersion.split('.').map((part) => Number.parseInt(part, 10))
  if (major >= 26) return 25
  if (major === 1 && (minor > 20 || (minor === 20 && patch >= 5))) return 21
  if (major === 1 && minor >= 17) return 17
  return 8
}

/** Where a jar runs: on a server, in a player's game alone, or (its own word) on either. */
type Side = 'server' | 'players' | 'either'

/**
 * Ten jars of the example pack, in the order they reach the gate.
 *
 * Nine are real, open-source mods, sorted the way each is published. Fabric API, Lithium,
 * FerriteCore, Tectonic and ServerCore run on a server: Blockly's own packs are made of them, with
 * each one's licence and side read (docs/modpack-templates.md). Iris Shaders, Mod Menu,
 * Continuity and ImmediatelyFast are published for the player's game alone.
 *
 * Example Mod is made up. It stands for a mod the catalog lets a server run that stops one as it
 * starts, which only a start can show (docs/modpack-system.md).
 */
const JARS: readonly { name: string; does: string; side: Side }[] = [
  { name: 'Fabric API', does: 'A library many Fabric mods are built on.', side: 'server' },
  { name: 'Iris Shaders', does: 'Draws shaders.', side: 'players' },
  { name: 'Lithium', does: 'Speeds up the game’s own logic.', side: 'server' },
  { name: 'Mod Menu', does: 'Adds a screen that lists the mods.', side: 'players' },
  { name: 'FerriteCore', does: 'Trims how much memory the game uses.', side: 'server' },
  { name: 'Continuity', does: 'Draws connected textures.', side: 'players' },
  { name: 'Tectonic', does: 'Shapes taller terrain as the world is made.', side: 'server' },
  { name: 'Example Mod', does: 'Made up for this page.', side: 'either' },
  { name: 'ImmediatelyFast', does: 'Speeds up drawing the screen.', side: 'players' },
  { name: 'ServerCore', does: 'Speeds up a server under load.', side: 'server' },
]

/** What the gate says of a jar, and where it sends it. apps/control/src/minecraft/pack-build.ts */
const VERDICT: Record<Side, { to: string; why: string }> = {
  server: { to: 'Kept', why: 'Runs on a server.' },
  players: { to: 'Left out', why: 'Only runs in a player’s game.' },
  either: { to: 'Kept', why: 'Says it runs on either side.' },
}

/** The mod the first start stops on, and the jars a start installs before and after it is learnt. */
const CULPRIT = JARS.find((jar) => jar.side === 'either')?.name ?? ''
const INSTALLED_FIRST = JARS.filter((jar) => jar.side !== 'players').length
const INSTALLED_AFTER = JARS.filter((jar) => jar.side === 'server').length

/** What Blockly makes of the stop, in its own sentence. apps/control/src/minecraft/diagnosis.ts */
const READING = `${CULPRIT} only runs in players’ games, and stopped the server as it started.`
/**
 * What gives it away in a Fabric server's output, with the class it names left out.
 * diagnosis.ts (the signature), apps/control/src/minecraft/diagnosis.test.ts (a whole line)
 */
const TELL = 'Cannot load class … in environment type SERVER'

/** How many mods one start of a pack server may learn about. apps/control/src/app/operations/boot.ts */
const LEARNED_PER_START = 3

/**
 * The size a dropped pack starts on: what its author asks for, then what its jars weigh. The
 * catalog's tags come between the two, and a pack built from a file has none.
 * apps/control/src/minecraft/pack-build.ts
 */
const AUTHOR_SMALL_MB = 2560
const AUTHOR_MIDDLE_MB = 4608
const HEAVY_MODS = 150
const HEAVY_JARS_MB = 400
/** What the example's author asks for, in the kinds of file that can say. */
const ASKS_MB = 4096

/** In GB. The example's few jars weigh far less than `HEAVY_JARS_MB`, so only their count is passed. */
function startsOn(asksMb: number | null, mods: number): 3 | 4 | 8 {
  if (asksMb !== null) return asksMb <= AUTHOR_SMALL_MB ? 3 : asksMb <= AUTHOR_MIDDLE_MB ? 4 : 8
  return mods < HEAVY_MODS ? 4 : 8
}
/** The three sizes sold, in words. apps/control/src/domain/server/size.ts */
const SIZE_WORDS = { 3: 'The smallest', 4: 'The middle', 8: 'The largest' } as const

/** Sped up: how long a jar stands at the gate, and how long each moment of the start is held. */
const JAR_MS = 900
const STEP_MS = 850
const READ_MS = 3600
const LEARN_MS = 1800
const STAMP_MS = 420

/** One moment of the start: the line it is on, and what has happened by then. */
interface Beat {
  /** 0 the first start, 1 the second, 2 the check, 3 players. */
  row: 0 | 1 | 2 | 3
  line: string
  hold: number
  stopped?: true
  /** The pack has learnt the mod and left its jar out. */
  learned?: true
  /** How many installed jars have been hashed and found to be the pack's. */
  stamped?: number
  online?: true
}

/**
 * The start, as the boot sequence runs it: up, stopped by a mod, the pack learns it, up again
 * (boot.ts), then every installed jar hashed (boot.ts), then who may join
 * (boot.ts). The lines are the ones the owner's page shows at each step:
 * apps/web/src/app/(app)/servers/[id]/boot-line.tsx, apps/web/src/lib/present.ts,
 * apps/web/src/ui/status.tsx.
 */
const BEATS: readonly Beat[] = [
  { row: 0, line: `${INSTALLED_FIRST} mods downloaded`, hold: STEP_MS },
  { row: 0, line: `Starting Minecraft ${PACK.game}`, hold: STEP_MS },
  { row: 0, line: 'It stopped.', hold: READ_MS, stopped: true },
  { row: 0, line: 'It stopped.', hold: LEARN_MS, stopped: true, learned: true },
  { row: 1, line: `${INSTALLED_AFTER} mods downloaded`, hold: STEP_MS, learned: true },
  { row: 1, line: `Starting Minecraft ${PACK.game}`, hold: STEP_MS, learned: true },
  { row: 1, line: 'Shaping the land', hold: STEP_MS, learned: true },
  ...Array.from(
    { length: INSTALLED_AFTER },
    (_, index): Beat => ({
      row: 2,
      line: 'Checking its mods are the ones chosen',
      hold: STAMP_MS,
      learned: true,
      stamped: index + 1,
    }),
  ),
  { row: 3, line: 'Letting players in', hold: STEP_MS, learned: true, stamped: INSTALLED_AFTER },
  { row: 3, line: 'Online', hold: 0, learned: true, stamped: INSTALLED_AFTER, online: true },
]
const ROWS = ['First start', 'Second start', 'The check', 'Players'] as const

interface State {
  kind: Kind
  /** How far the pack has got: 0 dropped, 1 read, 2 on the belt, 3 starting. */
  step: 0 | 1 | 2 | 3
  /** On the belt, how many jars are through the gate; in the start, which moment it is at. */
  at: number
  running: boolean
}

type Action =
  | { type: 'kind'; kind: Kind }
  /** `still`: the viewer asked for less motion, so a run arrives at its end at once. */
  | { type: 'advance'; still: boolean }
  | { type: 'tick' }

/** Where a run ends: every jar through the gate, or the start's last moment. */
const endOf = (step: State['step']): number => (step === 2 ? JARS.length : BEATS.length - 1)

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'kind':
      // Another file was dropped: it is read as what it is, and nothing of it is sorted yet.
      return { kind: action.kind, step: state.step === 0 ? 0 : 1, at: 0, running: false }
    case 'advance': {
      // Pressed during a run, the button finishes it.
      if (state.running) return { ...state, at: endOf(state.step), running: false }
      if (state.step === 0) return { ...state, step: 1 }
      if (state.step === 3) return { ...state, step: 0, at: 0 }
      const step = state.step === 1 ? 2 : 3
      return action.still
        ? { ...state, step, at: endOf(step), running: false }
        : { ...state, step, at: 0, running: true }
    }
    case 'tick': {
      if (!state.running) return state
      const at = Math.min(state.at + 1, endOf(state.step))
      return { ...state, at, running: at < endOf(state.step) }
    }
  }
}

/** How long each run lasts when a person starts it (`JAR_MS` a jar, each beat its `hold`), start to end. */
const SORT_MS = JARS.length * JAR_MS
const START_MS = BEATS.reduce((sum, beat) => sum + beat.hold, 0)

/**
 * What the tour does when its bar runs out: the one button's four presses, by how far the pack has
 * got. It is read off the pack and never off what the tour did last, since a person may have left
 * it anywhere.
 */
const TURNS = ['read', 'sort', 'start', 'over'] as const
type Turn = (typeof TURNS)[number]

/** What the tour's bar says is coming. `drop` is a round's first move, before the pack is read. */
const SOON: Record<Turn | 'drop', string> = {
  drop: 'Another kind of file',
  read: 'The pack is read',
  sort: 'The jars are sorted',
  start: 'The server starts',
  over: 'Back to the start',
}

/**
 * Played by the tour, a run is paced to last this long, the sort and the start alike: nobody
 * watching reads each jar, and a run has to be over, with a moment left to look at where it ended,
 * before the bar that began with it runs out. A run somebody started keeps its own pace.
 */
const TOURED_RUN_MS = 7500

/**
 * How long the bar runs after each turn, in seconds, whoever took it. After a press that starts a
 * run it is the longest a window may be (tour.tsx), which is the tour's run and two and a half
 * seconds more; what a run leaves stays on the page after it, so that is only a pause. `WAITS` is
 * how soon the tour looks again after a turn it didn't take, and `ARRIVES` how long before its
 * very first, so the pack is already moving when someone gets here.
 */
const RUN_WINDOW = 10
const LINGER: Record<Turn, number> = { read: 5, sort: RUN_WINDOW, start: RUN_WINDOW, over: 4 }
const WAITS = 3
const ARRIVES = 3

/** The room's lamps while nothing runs: low, not out. */
const LAMPS_LOW = 0.25

type StepState = 'todo' | 'next' | 'running' | 'done'

/** A real string inside a sentence. */
function V({ children }: { children: ReactNode }) {
  return <span className={`bl-mono ${styles.v}`}>{children}</span>
}

/**
 * Where each kind of file says what it runs on. apps/control/src/minecraft/mrpack.ts,
 * apps/control/src/minecraft/pack-manifests.ts,
 * apps/control/src/minecraft/server-pack.ts, apps/control/src/minecraft/pack-build.ts
 */
function SaidIn({ kind }: { kind: Kind }) {
  switch (kind) {
    case 'mrpack':
      return (
        <>
          Said in <V>modrinth.index.json</V>, under <V>dependencies</V>: <V>minecraft</V> and{' '}
          <V>fabric-loader</V>.
        </>
      )
    case 'curseforge':
      return (
        <>
          Said in <V>manifest.json</V>: <V>minecraft.version</V> and <V>minecraft.modLoaders</V>.
        </>
      )
    case 'packwiz':
      return (
        <>
          Said in <V>pack.toml</V>, under <V>versions</V>: <V>minecraft</V> and <V>fabric</V>.
        </>
      )
    case 'instance':
      return (
        <>
          Said in <V>mmc-pack.json</V>, by the components <V>net.minecraft</V> and{' '}
          <V>net.fabricmc.fabric-loader</V>.
        </>
      )
    case 'server':
      return (
        <>
          Said in <V>variables.txt</V>, by <V>MINECRAFT_VERSION=</V>, <V>MODLOADER=</V> and{' '}
          <V>MODLOADER_VERSION=</V>.
        </>
      )
    case 'mods':
      return (
        <>
          Said by the jars. Each one’s <V>fabric.mod.json</V> names its loader, and its{' '}
          <V>depends.minecraft</V> the Minecraft it allows; Cubepals takes the newest release every jar
          allows.
        </>
      )
  }
}

/** One step of the four: its number, its name, and whatever it holds by now. */
function Step({
  no,
  title,
  state,
  children,
}: {
  no: number
  title: string
  state: StepState
  children: ReactNode
}) {
  return (
    <li className={styles.step} data-state={state}>
      <div className={styles.head}>
        <span className={styles.no} aria-hidden>
          {no}
        </span>
        <h3 className={styles.title}>{title}</h3>
      </div>
      <div className={styles.body}>{children}</div>
    </li>
  )
}

export function PacksDemo() {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  /** The button had the keyboard when it moved to the next step, so the keyboard goes with it. */
  const follow = useRef(false)
  const inView = useInView(root)
  const still = useReducedMotion()
  const [state, dispatch] = useReducer(reduce, { kind: 'mrpack', step: 0, at: 0, running: false })
  const { kind, step, at, running } = state

  const press = () => {
    follow.current = document.activeElement === primary.current
    dispatch({ type: 'advance', still })
  }

  // Nothing here waits for a press. Left alone, the tour makes the button's own presses, one each
  // time its bar runs out, and after the last drops the next kind of file. `linger` is how long
  // the bar runs before the next turn: what the last press earned, the tour's or a person's. It
  // is only set where no bar is running (in the step itself, or while the tour is held for
  // someone), so the bar and the countdown behind it change together and never part-way. The wait
  // before the first turn is its first value and not the hook's `first`, which the hook keeps to
  // until its first step however much of the pack someone has pressed through before that.
  const [linger, setLinger] = useState<number>(ARRIVES)
  // Whether this round has had its file dropped yet. That is the round's first move and not its
  // last: it changes the top of the demonstration, where someone arriving is looking, and every
  // other turn changes something further down.
  const [dropped, setDropped] = useState(false)
  const tour = useTour({
    ref: root,
    steps: [
      () => {
        // A run is left to finish. One picked up part-way goes on at the tour's pace, so what is
        // left of it fits the window that begins now.
        if (running) {
          setLinger(RUN_WINDOW)
          return
        }
        const turn = TURNS[step]
        if (turn === 'read' && !dropped) {
          setDropped(true)
          dispatch({ type: 'kind', kind: kindAfter(kind) })
          setLinger(LINGER.over)
          return
        }
        // Starting over folds three steps away. Under someone reading one of them that would take
        // it from them and pull the page up, so the pack stays where it ended until some of the
        // first step, which never folds, is on screen again.
        const steps = list.current
        const top = steps?.firstElementChild
        if (turn === 'over' && steps && top) {
          // On a narrow screen the chunk's band is pinned over the top of the screen, and what is
          // under it is not on screen. The list carries the band's height (packs.module.css).
          const covered = Number.parseFloat(getComputedStyle(steps).scrollMarginTop) || 0
          if (top.getBoundingClientRect().bottom <= covered) {
            setLinger(WAITS)
            return
          }
        }
        press()
        if (turn === 'over') setDropped(false)
        setLinger(LINGER[turn])
      },
    ],
    seconds: linger,
  })
  const toured = tour.auto

  // Simulated time: a jar at the gate, or a moment of the start, is held, then the next arrives.
  // Only while it can be seen.
  useEffect(() => {
    if (!running || !inView) return
    const held = step === 2 ? JAR_MS : (BEATS[at]?.hold ?? STEP_MS)
    // The tour's run is the same run, each hold shortened alike so the whole fits its window.
    const hold = toured ? (held * TOURED_RUN_MS) / (step === 2 ? SORT_MS : START_MS) : held
    const timer = setTimeout(() => {
      follow.current = document.activeElement === primary.current
      dispatch({ type: 'tick' })
    }, hold)
    return () => clearTimeout(timer)
  }, [running, inView, step, at, toured])

  // The one button sits at the head of the step it starts, so it moves down as the pack does.
  // Moved by the tour it still takes the keyboard with it, but the page stays where it is.
  useEffect(() => {
    if (!follow.current) return
    follow.current = false
    if (primary.current !== null && document.activeElement !== primary.current)
      primary.current.focus({ preventScroll: toured })
  })

  const file = FILES[kind]
  const java = javaFor(PACK.game)
  const beat = step === 3 ? BEATS[at] : undefined
  const learned = beat?.learned === true
  const stamped = beat?.stamped ?? 0
  const online = beat?.online === true
  // Whether the pack names its loader build; a folder of mods names nothing.
  const build = kind === 'mods' ? null : PACK.build

  // The belt: who is through the gate, who waits, and who stands at it.
  const sorted = step === 2 ? at : step === 3 ? JARS.length : 0
  const through = JARS.slice(0, sorted)
  const kept = through.filter((jar) => jar.side === 'server' || (jar.side === 'either' && !learned))
  const left = through.filter((jar) => jar.side === 'players')
  const taught = learned ? through.filter((jar) => jar.side === 'either') : []
  const waiting = JARS.slice(sorted).reverse()
  const atGate = step === 2 && running ? JARS[at] : undefined

  // The size, and which of the things asked decided it.
  const asksMb = file.asks === null ? null : ASKS_MB
  const gb = startsOn(asksMb, INSTALLED_FIRST)

  // The room in the chunk: low while nothing runs, full while the belt or the server does.
  const lit = running || online
  useEffect(() => {
    stage.glow('packs', inView ? (lit ? 1 : LAMPS_LOW) : null)
  }, [inView, lit])
  useEffect(() => () => stage.glow('packs', null), [])

  // The room's scene plays this pack: which file was dropped, whether it has been read, whether a
  // jar stands at the gate, how many went each way, and how far the start has got. Out of sight
  // nothing here moves, so the room is left to play by itself.
  const read = step > 0
  const gate = atGate !== undefined
  const server = kept.length
  const players = left.length + taught.length
  const power = beat === undefined ? 'off' : online ? 'online' : beat.stopped ? 'fault' : 'starting'
  useEffect(() => {
    stage.show('packs', inView ? { kind, read, gate, kept: server, left: players, power, stamped } : null)
  }, [inView, kind, read, gate, server, players, power, stamped])
  useEffect(() => () => stage.show('packs', null), [])

  const button = (label: string, quiet = false) => (
    <button
      ref={primary}
      type="button"
      className={quiet ? 'bl-btn bl-btn--sm bl-btn--quiet' : 'bl-btn'}
      onClick={() => {
        // A person's press earns the window the tour's would have, so a run they start is over,
        // with time to look at where it ended, before the tour moves on. Their press holds the
        // tour, so no bar is running to change; one that only finishes a run earns nothing new.
        if (!running && !tour.running) setLinger(LINGER[TURNS[step]])
        press()
      }}
    >
      {label}
    </button>
  )

  const needs: StepState = step === 0 ? 'next' : 'done'
  const sorts: StepState =
    step === 0 ? 'todo' : step === 1 ? 'next' : step === 2 && running ? 'running' : 'done'
  const starts: StepState =
    step < 2 || (step === 2 && running) ? 'todo' : step === 2 ? 'next' : running ? 'running' : 'done'

  // What a screen reader is told as it goes: one line for where the pack has got to.
  const names = (jars: readonly { name: string }[]) => jars.map((jar) => jar.name).join(', ')
  const tells = file.inside
    .filter((entry) => entry.tell)
    .map((entry) => entry.name)
    .join(' and ')
  const status =
    step === 0
      ? `An example pack, dropped as ${file.name}. Cubepals knows it by ${tells}.`
      : step === 1
        ? `Read. It needs Minecraft ${PACK.game}, ${PACK.loader} and Java ${java}.`
        : step === 2
          ? running
            ? `Sorting ${JARS.length} jars.`
            : `Sorted. For the server: ${names(kept)}. Left out, for players’ games: ${names(left)}.`
          : beat === undefined || online
            ? `Online, on its second start. Every installed jar matched the pack. It starts on ${gb} GB.`
            : beat.row === 0
              ? beat.stopped
                ? `The first start stopped. ${READING} Cubepals leaves it out and starts again.`
                : 'The first start.'
              : beat.row === 1
                ? `The second start, without ${CULPRIT}.`
                : beat.row === 2
                  ? 'Checking every installed jar against the pack.'
                  : 'Letting players in.'

  return (
    <div className={styles.demo} ref={root}>
      <TourBar tour={tour} label={TURNS[step] === 'read' && !dropped ? SOON.drop : SOON[TURNS[step]]} />
      {/* While the tour is what moves the pack, a screen reader is not read every change. */}
      <p className={styles.sr} aria-live={toured ? 'off' : 'polite'}>
        {status}
      </p>

      <ol className={styles.steps} ref={list}>
        <Step no={1} title="What it is" state="done">
          <p className="bl-small">
            An example pack, dropped as one file. Pick which kind: Cubepals tells them apart by the names of
            the files inside, trying them in this order.
          </p>
          <fieldset className={styles.kinds}>
            <legend className={styles.sr}>The kind of file that was dropped</legend>
            <div className={styles.chips}>
              {KINDS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="bl-chip"
                  aria-pressed={kind === key}
                  onClick={() => {
                    // A kind somebody picked is this round's file: the tour reads it, and
                    // doesn't drop another over it.
                    setDropped(true)
                    dispatch({ type: 'kind', kind: key })
                  }}
                >
                  {FILES[key].chip}
                </button>
              ))}
            </div>
          </fieldset>
          <div className={`bl-frame bl-frame--bare ${styles.file}`}>
            <div>
              <p className="bl-small">
                Inside the <V>{file.ext}</V>, with what gives it away marked
              </p>
              <ul className={`bl-mono ${styles.names}`}>
                {file.inside.map((entry) => (
                  <li key={entry.name} data-tell={entry.tell}>
                    {entry.name}
                    {entry.tell && <span className={styles.sr}> gives it away</span>}
                  </li>
                ))}
              </ul>
            </div>
            <p className={styles.how}>{file.how}</p>
          </div>
        </Step>

        <Step no={2} title="What it needs" state={needs}>
          {needs === 'next' ? (
            <div className={styles.ask}>
              {button('Read the pack')}
              <p className={styles.what}>
                No one is asked for a Minecraft version, a loader or a Java. The file says, and Cubepals reads
                it.
              </p>
            </div>
          ) : (
            <>
              <p className={styles.from}>
                <SaidIn kind={kind} />
              </p>
              <dl className={styles.sums}>
                <div>
                  <dt className="bl-small">Minecraft</dt>
                  <dd>
                    <span className={`bl-mono bl-num ${styles.sum}`}>{PACK.game}</span>
                  </dd>
                </div>
                <div>
                  <dt className="bl-small">Loader</dt>
                  <dd>
                    <span className={`bl-mono ${styles.sum}`}>{PACK.loader}</span>
                  </dd>
                </div>
                <div>
                  <dt className="bl-small">Loader build</dt>
                  <dd>
                    {build === null ? (
                      <>
                        <span className={styles.sum}>The current one</span>
                        <span className={`bl-small ${styles.sub}`}>none is named</span>
                      </>
                    ) : (
                      <span className={`bl-mono bl-num ${styles.sum}`}>{build}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="bl-small">Java</dt>
                  <dd>
                    <span className={`bl-mono bl-num ${styles.sum}`}>{java}</span>
                    <span className={`bl-small ${styles.sub}`}>never said, always worked out</span>
                  </dd>
                </div>
              </dl>
              <div>
                <p className="bl-small">Java follows the Minecraft</p>
                <ul className={styles.javas}>
                  {JAVAS.map((row) => (
                    <li key={row.java} className={styles.java} data-on={row.java === java || undefined}>
                      <span className={`bl-small bl-num ${styles.range}`}>{row.range}</span>
                      <span className="bl-mono bl-num">Java {row.java}</span>
                      {row.java === java && <span className={styles.sr}>This pack’s.</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="bl-small">
                Whatever it came as, Cubepals now holds it as one shape: a Modrinth pack, with the{' '}
                <V>sha512</V> of every jar a server installs from it.
              </p>
            </>
          )}
        </Step>

        <Step no={3} title="What a server runs" state={sorts}>
          <div className={styles.ask}>
            {(sorts === 'next' || sorts === 'running') &&
              button(sorts === 'next' ? 'Sort it' : 'Sort the rest')}
            {sorts !== 'running' && (
              <p className={styles.what}>
                {sorts === 'done'
                  ? `${JARS.length} jars through. The ones left out are listed for the owner, on the server’s Mods page.`
                  : 'A pack is put together for players’ games, and some of its mods draw the screen. A server has no screen, so those stay out.'}
              </p>
            )}
          </div>
          {(sorts === 'running' || sorts === 'done') && (
            <>
              <p className="bl-small">
                Each jar is found on Modrinth by its hash, and that file’s own record says where it runs.
                Failing that, the jar’s metadata. With neither, it stays.
              </p>
              <div className={styles.belt} aria-hidden>
                <div className={styles.track}>
                  {waiting.map((jar, index) => (
                    <i
                      key={jar.name}
                      className={styles.jar}
                      data-at={(running && index === waiting.length - 1) || undefined}
                    />
                  ))}
                </div>
                <i className={`bl-dither ${styles.floor}`} data-level="3" />
                <i className={styles.post} />
              </div>
              <div className={`bl-frame bl-frame--solid ${styles.gate}`}>
                {atGate === undefined ? (
                  <>
                    <p className={styles.at}>
                      <span>Through the gate</span>
                      <span className="bl-num">
                        {JARS.length} of {JARS.length}
                      </span>
                    </p>
                    <p className={styles.mod}>{kept.length} for the server</p>
                    <p className={styles.does}>
                      {left.length + taught.length} left out, for players’ games alone.
                    </p>
                  </>
                ) : (
                  <>
                    <p className={styles.at}>
                      <span>At the gate</span>
                      <span className="bl-num">
                        {at + 1} of {JARS.length}
                      </span>
                    </p>
                    <p className={styles.mod}>{atGate.name}</p>
                    <p className={styles.does}>{atGate.does}</p>
                    <p className={styles.verdict}>
                      <span className={styles.to}>{VERDICT[atGate.side].to}</span>
                      {VERDICT[atGate.side].why}
                    </p>
                  </>
                )}
              </div>
              <div className={styles.bins}>
                <div className={`bl-frame bl-frame--bare ${styles.bin}`}>
                  <p className={styles.binName}>
                    <span>The server</span>
                    <span className="bl-num">{kept.length}</span>
                  </p>
                  <p className="bl-small">Installed as it starts.</p>
                  <ul className={styles.list}>
                    {kept.map((jar, index) => (
                      <li key={jar.name} className={styles.kept}>
                        <i className={styles.stamp} data-on={index < stamped || undefined} aria-hidden />
                        <span>
                          {jar.name}
                          {index < stamped && <span className={styles.sr}>, hash matched</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className={`bl-small ${styles.key}`}>
                    <i className={styles.stamp} data-on aria-hidden />
                    <span>
                      Filled once its <V>sha512</V> is the pack’s.
                    </span>
                  </p>
                </div>
                <div className={`bl-frame bl-frame--bare ${styles.bin}`}>
                  <p className={styles.binName}>
                    <span>Players only</span>
                    <span className="bl-num">{left.length + taught.length}</span>
                  </p>
                  <p className="bl-small">Left out of the server.</p>
                  <ul className={styles.list}>
                    {left.map((jar) => (
                      <li key={jar.name} className={styles.left}>
                        {jar.name}
                      </li>
                    ))}
                    {taught.map((jar) => (
                      <li key={jar.name} className={styles.left}>
                        {jar.name}
                        <small>learned at a start</small>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}
        </Step>

        <Step no={4} title="The start that learns" state={starts}>
          <div className={styles.ask}>
            {starts !== 'todo' &&
              button(
                starts === 'next' ? 'Start it' : starts === 'running' ? 'Skip to the end' : 'Start over',
                starts === 'done',
              )}
            {(starts === 'todo' || starts === 'next') && (
              <p className={styles.what}>
                Some mods say they run on a server and stop one. Only a start shows which.
              </p>
            )}
          </div>
          {beat !== undefined && (
            <>
              <ol className={styles.starts}>
                {ROWS.slice(0, beat.row + 1).map((name, row) => {
                  const here = row === beat.row
                  const rowState =
                    row === 0 && (!here || beat.stopped)
                      ? 'stopped'
                      : !here
                        ? 'done'
                        : online
                          ? 'lit'
                          : 'active'
                  const line =
                    BEATS.slice(0, at + 1)
                      .filter((moment) => moment.row === row)
                      .at(-1)?.line ?? ''
                  return (
                    <li
                      key={name}
                      className={styles.row}
                      data-state={rowState}
                      aria-current={rowState === 'active' ? 'step' : undefined}
                    >
                      <span className={styles.mark} aria-hidden />
                      <div>
                        <p className={styles.rowName}>{name}</p>
                        <p className={styles.rowLine}>
                          <span className={styles.says}>{line}</span>
                        </p>
                        {row === 2 && (
                          <p className="bl-small">
                            <V>sha512sum</V> on every jar it installed:{' '}
                            <span className="bl-num">
                              {stamped} of {INSTALLED_AFTER}
                            </span>{' '}
                            hold the bytes the pack lists.
                          </p>
                        )}
                      </div>
                      {row === 0 && rowState === 'stopped' && (
                        <div className={`bl-frame bl-frame--bare ${styles.found}`}>
                          <p className="bl-small">What gave it away in the server’s output</p>
                          <pre className={`bl-frame bl-frame--solid bl-mono ${styles.log}`}>{TELL}</pre>
                          <p className="bl-small">Cubepals reads that as</p>
                          <p className={styles.reading}>{READING}</p>
                          <p className="bl-small">What Cubepals does, without asking</p>
                          <p className={styles.then}>
                            The pack learns it, as <V>crashed</V>: that jar is left out of every server
                            playing this pack from now on, and this one starts again.
                          </p>
                          <p className={styles.meter}>
                            <span className={styles.cells} aria-hidden>
                              {Array.from({ length: LEARNED_PER_START }, (_, cell) => cell).map((cell) => (
                                <i
                                  key={cell}
                                  className={styles.cell}
                                  data-on={(learned && cell === 0) || undefined}
                                />
                              ))}
                            </span>
                            <span>
                              Learned{' '}
                              <span className="bl-num">
                                {learned ? 1 : 0} of {LEARNED_PER_START}
                              </span>
                              . Past that, a start fails and says why.
                            </span>
                          </p>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>

              {online && (
                <div className={`bl-frame bl-frame--bare ${styles.size}`}>
                  <p className={styles.sizeName}>The size it starts on, and what decided it</p>
                  <ol className={styles.order}>
                    <li className={styles.row} data-state={file.asks === null ? 'silent' : 'done'}>
                      <span className={styles.mark} aria-hidden />
                      <div>
                        <p className={styles.rowName}>What its author asks for</p>
                        <p className="bl-small">
                          {file.asks === null ? (
                            'This kind of file has nowhere to say.'
                          ) : (
                            <>
                              <V>{file.asks.key}</V> in <V>{file.asks.file}</V>, here <V>{ASKS_MB} MB</V>. Up
                              to <V>{AUTHOR_MIDDLE_MB} MB</V> asked for is the middle size.
                            </>
                          )}
                        </p>
                      </div>
                    </li>
                    <li className={styles.row} data-state={file.asks === null ? 'silent' : 'unasked'}>
                      <span className={styles.mark} aria-hidden>
                        {file.asks !== null && <i className="bl-dither" data-level="3" />}
                      </span>
                      <div>
                        <p className={styles.rowName}>The catalog’s tags</p>
                        <p className="bl-small">
                          <V>kitchen-sink</V> starts on the large size and <V>lightweight</V> on the small.{' '}
                          {file.asks === null ? 'A pack built from a file has none.' : 'Not asked.'}
                        </p>
                      </div>
                    </li>
                    <li className={styles.row} data-state={file.asks === null ? 'done' : 'unasked'}>
                      <span className={styles.mark} aria-hidden>
                        {file.asks !== null && <i className="bl-dither" data-level="3" />}
                      </span>
                      <div>
                        <p className={styles.rowName}>What its jars weigh</p>
                        <p className="bl-small">
                          Fewer than <V>{HEAVY_MODS}</V> mods and under <V>{HEAVY_JARS_MB} MB</V> of jars is
                          the middle size. Counting never puts a pack on the small one.{' '}
                          {file.asks !== null && 'Not asked.'}
                        </p>
                      </div>
                    </li>
                  </ol>
                  <p className={styles.result}>
                    <span className={`bl-mono bl-num ${styles.big}`}>{gb} GB</span>
                    <span className="bl-small">
                      {SIZE_WORDS[gb]} of three sizes. If it runs out of room, the next one up is offered in
                      one press.
                    </span>
                  </p>
                </div>
              )}
            </>
          )}
        </Step>
      </ol>
    </div>
  )
}
