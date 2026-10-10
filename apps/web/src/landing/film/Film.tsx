// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * Every beat of the film, in the order the page puts them: where the camera stands, the one
 * sentence, and the cues that tell the stage what to show as the beat plays. The treatment is in
 * landing/README.md.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { type ReactNode, useId, useRef, useState } from 'react'
import { Lockup } from '../../ui/brand'
import type { RoomKey } from '../engine/chunk'
import type { Tone } from '../kit'
import {
  addressOf,
  choice,
  EXAMPLE_NAME,
  FIRST_PLAY,
  PLAYS,
  partyOf,
  playOf,
  SMALLEST,
  useChoice,
} from '../sections/choice'
import { decisionsOf } from '../sections/LedgerDemo'
import { Stars } from '../sections/Stars'
import { type Showing, stage } from '../stage'
import { Beat, type Playing, useBeat } from './Beat'
import { playing } from './clock'
import styles from './film.module.css'

/** The gate with the server asleep behind it and nobody at the door. */
const SHUT = { power: 'stopped', route: 'notice', joining: false, held: false, asking: false }
/** The sleep room with the server up and someone on it. */
const UP = { phase: 'awake', step: 2, copy: false }
/** A pack just dropped in: shut, unread, and the server not started. */
const PACK = { kind: 'mrpack', read: false, gate: false, kept: 0, left: 0, power: 'off', stamped: 0 }
/** The backups room before anything is done: the server asleep, three copies kept on the bench. */
const BENCH = { server: 'asleep', held: false, own: 3, safety: 0, kept: 3, back: 'none' }
/** The line before any server has come down it. */
const LINE = { at: 'none', a: 0, b: 0, fleet: 0, full: false }
/** Blockly's own two machines with every world asleep on its shelf. */
const SHELVES = {
  turn: 0,
  came: 'none',
  aGb: 0,
  aAwake: 0,
  aWorlds: 5,
  bGb: 0,
  bAwake: 0,
  bWorlds: 4,
  cable: 'up',
}

/** A line of the game's chat, said as a beat plays forward and not again when it is played back. */
const chat = (line: string) => {
  if (!playing.back) stage.say(line)
}

/** The server in the film (the address its example name gets), and whoever joins it. */
const ADDRESS = addressOf(EXAMPLE_NAME)
const FRIENDS = ['moss_walker', 'kai', 'noor']

/**
 * I. Night. The surface, the house dark, and the one sentence the page is for. Coming back here
 * puts the server back to sleep: the film starts from the top.
 */
export function Night({ create, signedIn }: { create: string; signedIn: boolean }) {
  const beat = useBeat(() => [[0, () => stage.set({ power: 'asleep', players: 0 })]])
  return (
    <Beat
      {...beat}
      id="top"
      name="The surface"
      cue="Scroll to join"
      tone="night"
      sky
      y={76}
      side="right"
      zoom="wide"
      className={styles.first}
    >
      <Stars className={styles.stars} />
      <span className="bl-moon" aria-hidden />
      <div className={styles.words} data-over>
        <header className={styles.nav}>
          <Link href="/" className={styles.wordmark} aria-label="Cubepals">
            <Lockup />
          </Link>
          <nav className={styles.links} aria-label="Cubepals">
            <Link href="/pricing" className={styles.link}>
              Pricing
            </Link>
            <Link href={signedIn ? '/servers' : '/sign-in'} className={styles.link}>
              {signedIn ? 'Your servers' : 'Sign in'}
            </Link>
          </nav>
        </header>
        <h1 className={`bl-display ${styles.headline}`}>
          A Minecraft server that starts when your friends join
        </h1>
        <div className={styles.go}>
          <Link href={create} className="bl-btn bl-btn--lg">
            Create a server
          </Link>
          <p>
            Free to start, no card needed.
            <br />
            For Minecraft: Java Edition.
          </p>
        </div>
      </div>
    </Beat>
  )
}

/**
 * The knock. Down at the path and the signpost, still night. The address is typed, a letter at a
 * time, in the game's own field. Nothing has woken yet.
 */
export function Knock() {
  const [typed, setTyped] = useState(0)
  const beat = useBeat(() => [
    [0, () => setTyped(0)],
    ...ADDRESS.split('').map((_, n) => [0.7 + n * 0.055, () => setTyped(n + 1)] as const),
  ])
  return (
    <Beat
      {...beat}
      name="The address"
      tone="night"
      sky
      act="knock"
      y={68}
      side={0.8}
      // The corner the path leaves by, nearest: whoever typed the address at the end of it, the
      // one warm thing on a dark world, and the house asleep behind them.
      shot={{ x: 10.5, z: 6, az: 62, el: 19, span: 19, drop: 0.5 }}
      line="Share the address."
      place="top"
    >
      <Stars className={styles.stars} />
      <div className={styles.address} data-over>
        <span className={styles.label}>Server Address</span>
        <span className={styles.field}>
          {ADDRESS.slice(0, typed)}
          {beat.on && <i className={styles.caret} aria-hidden />}
        </span>
      </div>
    </Beat>
  )
}

/**
 * The wake. Under the grass, at the gate, close. The friend is at the shut door; the knock runs
 * the floor to the server; its lamps climb; its world springs out; the door is thrown open. The
 * line changes as the world lifts. This is the film's one big moment.
 */
export function Wake({ proof }: { proof: ReactNode }) {
  const [awake, setAwake] = useState(false)
  const say = (values: Record<string, string | boolean>) => {
    stage.show('edge', { ...stage.get().rooms.edge, ...values })
  }
  const beat = useBeat(
    () => [
      [0, () => setAwake(false)],
      [0, () => stage.show('edge', SHUT)],
      [0.9, () => say({ joining: true })],
      [1.2, () => say({ held: true })],
      [3.0, () => say({ power: 'starting' })],
      [5.8, () => say({ power: 'running' })],
      [6.2, () => setAwake(true)],
      [7.2, () => say({ route: 'server' })],
      [8.3, () => say({ held: false })],
      [9.9, () => say({ joining: false })],
    ],
    () => stage.show('edge', SHUT),
  )
  return (
    <Beat
      {...beat}
      // The gate's room, by its own name, so the gauge and a sent link can reach it.
      id="edge"
      name="The wake"
      tone="stone"
      room="edge"
      shot={{ span: 8.4, drop: 0.6 }}
      line={awake ? 'If it’s asleep, give it a minute.' : 'They join like any server.'}
      place="top"
      proof={proof}
    />
  )
}

/**
 * Daybreak. Back up at the house. The windows light, the sky turns, and the friends come up the
 * path one after another.
 */
export function Daybreak() {
  const beat = useBeat(() => [
    [0.2, () => stage.set({ power: 'waking' })],
    [1.6, () => stage.set({ power: 'awake', players: 1 })],
    [1.6, () => chat(`${FRIENDS[0]} joined the game`)],
    [4.2, () => stage.set({ players: 2 })],
    [4.2, () => chat(`${FRIENDS[1]} joined the game`)],
    [6.8, () => stage.set({ players: 3 })],
    [6.8, () => chat(`${FRIENDS[2]} joined the game`)],
  ])
  return (
    <Beat
      {...beat}
      name="Daybreak"
      tone="night"
      sky
      y={69}
      zoom="near"
      side={0.74}
      shot={{ x: 8.5, z: 6.5, az: 50, el: 17, span: 24, drop: 0.56 }}
      line="No dashboard to open. No one to wait for."
      place="top"
    >
      <Stars className={styles.stars} />
    </Beat>
  )
}

/**
 * II. Play. The one thing on the main line that is pressed: what to play, and what to call it,
 * which is all the product asks. What is picked is played out on the grass. Left alone it answers
 * itself: a row, then the name a key at a time. Once a person has answered, the answers are
 * theirs for as long as the page is open, and the beat never answers for them again.
 */
export function Asks() {
  const play = playOf(useChoice((chosen) => chosen.play))
  const name = useChoice((chosen) => chosen.name)
  const field = useId()
  // Whether a person has answered here, ever.
  const theirs = useRef(false)
  const unless = (run: () => void) => () => {
    if (!theirs.current) run()
  }
  const beat = useBeat(() => [
    [0, unless(() => choice.set({ play: FIRST_PLAY.key, name: '', party: SMALLEST.key }, 'tour'))],
    [3.2, unless(() => choice.set({ play: 'creative' }, 'tour'))],
    ...EXAMPLE_NAME.split('').map(
      (_, n) =>
        [6.4 + n * 0.09, unless(() => choice.set({ name: EXAMPLE_NAME.slice(0, n + 1) }, 'tour'))] as const,
    ),
  ])
  return (
    <Beat
      {...beat}
      name="What it asks"
      tone="paper"
      y={66}
      zoom="near"
      act="play"
      side={0.72}
      shot={{ x: 7, z: 9, span: 24, el: 22, az: 48, drop: 0.56 }}
      line="Pick what to play, and name it."
      place="top"
      className={styles.asks}
    >
      <div className={styles.form} data-over>
        <div className={styles.ways} role="radiogroup" aria-label="What to play">
          {PLAYS.map((way) => (
            // biome-ignore lint/a11y/useSemanticElements: a row of chips that is pressed, as on the create page.
            <button
              key={way.key}
              type="button"
              role="radio"
              aria-checked={way.key === play.key}
              className={`bl-chip ${styles.way}`}
              onClick={() => {
                theirs.current = true
                beat.done()
                choice.set({ play: way.key })
              }}
            >
              {way.title}
            </button>
          ))}
        </div>
        <label className={styles.named} htmlFor={field}>
          <input
            id={field}
            className={styles.name}
            value={name}
            maxLength={40}
            placeholder={EXAMPLE_NAME}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              theirs.current = true
              beat.done()
              choice.set({ name: event.target.value })
            }}
          />
          <span className="bl-game">{addressOf(name.trim() || EXAMPLE_NAME)}</span>
        </label>
      </div>
    </Beat>
  )
}

/**
 * Everything it didn't ask. The vault under the house, close on the server, which builds itself
 * to the answers. The number is the ledger's own count for what was answered.
 */
export function Decided({ plans, proof }: { plans: PublicPlan[]; proof: ReactNode }) {
  const beat = useBeat(() => [])
  const play = playOf(useChoice((chosen) => chosen.play))
  const party = partyOf(useChoice((chosen) => chosen.party))
  const name = useChoice((chosen) => chosen.name)
  return (
    <Beat
      {...beat}
      name="What it didn’t ask"
      tone="stone"
      y={58.6}
      act="ledger"
      side={0.56}
      shot={{ x: 12.5, z: 4, az: 84, el: 11, span: 8.6, fov: 34, drop: 0.56 }}
      line={`The other ${decisionsOf(plans, play, party, name)} choices are made for you.`}
      place="top"
      proof={proof}
      says="Every one of them"
    />
  )
}

/**
 * III. Night again. The friends walk off down the path one after another, the world is saved,
 * and the house goes dark.
 */
export function Leaves() {
  const goes = (index: number) => () => {
    stage.set({ players: Math.max(0, FRIENDS.length - 1 - index) })
    chat(`${FRIENDS[index]} left the game`)
  }
  const beat = useBeat(() => [
    // Come to from below, where it is night already: everyone is in again first, at once.
    [0, () => stage.set({ power: 'awake', players: FRIENDS.length })],
    [1.4, goes(0)],
    [3.2, goes(1)],
    [5.0, goes(2)],
    [11.5, () => stage.set({ power: 'saving', players: 0 })],
    [14.5, () => stage.set({ power: 'asleep' })],
  ])
  return (
    <Beat
      {...beat}
      name="Everyone leaves"
      tone="night"
      sky
      y={69}
      zoom="near"
      side={0.74}
      shot={{ x: 9.5, z: 6, az: 58, el: 15, span: 23, drop: 0.56 }}
      line="Hours only count while it’s running."
      place="top"
    >
      <Stars className={styles.stars} />
    </Beat>
  )
}

/** Says more of what a room is showing, over what it was already told. */
const tell = (room: RoomKey) => (values: Showing) => () =>
  stage.show(room, { ...stage.get().rooms[room], ...values })

/**
 * A room of the dig: its picture close, one sentence over it, and its proof one layer down. What
 * the room plays as the page comes to rest on it is the beat's own to say.
 */
function Room({
  beat,
  room,
  name,
  tone,
  line,
  span,
  drop = 0.6,
  proof,
}: {
  beat: Playing
  room: RoomKey
  name: string
  tone: Tone
  line: string
  /** How many blocks its view is tall: as few as hold everything that happens in it. */
  span: number
  drop?: number
  proof: ReactNode
}) {
  return (
    <Beat
      {...beat}
      // The room's own name, so the gauge and a sent link can reach it.
      id={room}
      name={name}
      tone={tone}
      room={room}
      shot={{ span, drop }}
      line={line}
      place="top"
      proof={proof}
    />
  )
}

/**
 * Asleep. The sleep room: the world drops into its chest, the worker shuts the lid over it, the
 * latch lights, and the lamps go out from the top. The friends have just left (the beat above).
 */
export function Asleep({ proof }: { proof: ReactNode }) {
  const beat = useBeat(
    () => [
      [0, () => stage.show('sleep', UP)],
      [1.2, () => stage.show('sleep', { phase: 'empty', step: 0, copy: false })],
      [4.7, () => stage.show('sleep', { phase: 'saving', step: 0, copy: false })],
      [6.2, () => stage.show('sleep', { phase: 'asleep', step: 0, copy: false })],
    ],
    () => stage.show('sleep', UP),
  )
  return (
    <Room
      beat={beat}
      room="sleep"
      name="Asleep"
      tone="stone"
      line="It saves the world before it stops."
      span={8.6}
      proof={proof}
    />
  )
}

/** The steps of a start, in the order the machine room is told them. */
const START = [
  'queued',
  'allocating',
  'storage',
  'compute',
  'booting',
  'starting',
  'loading_world',
  'access',
  'online',
]

/**
 * IV. The dig. Built: the machine room. A start is a build, for the server that was chosen above:
 * as tall as its group needs, with the world of what is played on top.
 */
export function Built({ proof }: { proof: ReactNode }) {
  const play = playOf(useChoice((chosen) => chosen.play))
  const party = partyOf(useChoice((chosen) => chosen.party))
  // Memory by the group, and dedicated cores by memory, as the product sizes them
  // (apps/control/src/domain/server/size.ts, apps/control/src/infra/fly/machine-config.ts).
  const gb = Math.round(party.memoryMb / 1024)
  const built = { gb, cores: gb <= 3 ? 1 : gb <= 4 ? 2 : 4, modded: play.mods.length > 0, fault: false }
  const beat = useBeat(
    () => [
      [0, () => stage.show('machine', { ...built, step: 'idle' })],
      ...START.map((step, n) => [1.1 + n * 0.85, () => stage.show('machine', { ...built, step })] as const),
    ],
    () => stage.show('machine', { ...built, step: 'idle' }),
  )
  return (
    <Room
      beat={beat}
      room="machine"
      name="Built"
      tone="stone"
      line="Sized for your game and your group."
      span={9.4}
      proof={proof}
    />
  )
}

/** The jars of a pack in the order they are sorted: kept for the server, or left for players' games. */
const SORT = 'klklklklk'

/**
 * Fitted: the packs room. One chest of jars is read and sorted, the server is started, and each
 * jar it kept is checked.
 */
export function Fitted({ proof }: { proof: ReactNode }) {
  const beat = useBeat(
    () => {
      const say = (values: Partial<typeof PACK>) => () =>
        stage.show('packs', { ...stage.get().rooms.packs, ...values })
      const kept = SORT.split('k').length - 1
      const sorted = 3.6 + SORT.length * 0.6
      return [
        [0, () => stage.show('packs', PACK)],
        [1.0, say({ read: true })],
        [3.0, say({ gate: true })],
        ...SORT.split('').map((_, n) => {
          const far = SORT.slice(0, n + 1)
          const k = far.split('k').length - 1
          return [3.6 + n * 0.6, say({ kept: k, left: far.length - k, gate: n < SORT.length - 1 })] as const
        }),
        [sorted + 1.2, say({ power: 'starting' })],
        ...Array.from({ length: kept }, (_, n) => [sorted + 3 + n * 0.3, say({ stamped: n + 1 })] as const),
        [sorted + 3 + kept * 0.3 + 0.6, say({ power: 'online' })],
      ]
    },
    () => stage.show('packs', PACK),
  )
  return (
    <Room
      beat={beat}
      room="packs"
      name="Fitted"
      tone="stone"
      line="Pick a pack and Cubepals installs all of it."
      span={9}
      proof={proof}
    />
  )
}

/**
 * Copied: the backups room. A day of play ends, a copy of the world is taken and shelved, and the
 * oldest goes off the end of the bench. Then a change that does not start: a copy is taken first,
 * the server stops in smoke, and the copy is what comes back.
 */
export function Copied({ proof }: { proof: ReactNode }) {
  const say = tell('backups')
  const beat = useBeat(
    () => [
      [0, () => stage.show('backups', BENCH)],
      [1.2, say({ server: 'on' })],
      [4.2, say({ server: 'asleep' })],
      [5.5, say({ own: 4 })],
      [6.8, say({ own: 3 })],
      [10.2, say({ server: 'on', held: true })],
      [11.6, say({ safety: 1 })],
      [12.3, say({ held: false })],
      [13.0, say({ server: 'restarting' })],
      [15.0, say({ server: 'fault' })],
      [16.3, say({ back: 'safety' })],
      [17.6, say({ server: 'on' })],
    ],
    () => stage.show('backups', BENCH),
  )
  return (
    <Room
      beat={beat}
      room="backups"
      name="Copied"
      tone="stone"
      line="Daily backups while you play."
      span={9.6}
      drop={0.68}
      proof={proof}
    />
  )
}

/**
 * Sent: the runtimes room. Three servers come down the line one after another, each is read by
 * the rules, and each ends at a different door.
 */
export function Sent({ proof }: { proof: ReactNode }) {
  const say = tell('runtimes')
  const beat = useBeat(
    () => [
      [0, () => stage.show('runtimes', LINE)],
      [1.0, say({ at: 'arrive' })],
      [1.65, say({ at: 'allow' })],
      [2.3, say({ at: 'canary' })],
      [2.95, say({ at: 'default' })],
      [3.6, say({ at: 'none', a: 1 })],
      [8.0, say({ at: 'arrive' })],
      [8.65, say({ at: 'allow' })],
      [9.3, say({ at: 'none', fleet: 1 })],
      [13.0, say({ full: true })],
      [14.5, say({ at: 'arrive' })],
      [15.15, say({ at: 'allow' })],
      [15.8, say({ at: 'canary' })],
      [16.45, say({ at: 'default' })],
      [17.75, say({ at: 'none', b: 1 })],
    ],
    () => stage.show('runtimes', LINE),
  )
  return (
    <Room
      beat={beat}
      room="runtimes"
      name="Sent"
      tone="slate"
      line="Cubepals picks where it runs."
      span={9}
      proof={proof}
    />
  )
}

/**
 * Kept by the dozen: Blockly's own machines. Three worlds wake on the first, one after another,
 * until it is full; the next is carried across to the second and woken there.
 */
export function Kept({ proof }: { proof: ReactNode }) {
  const say = tell('fleet')
  const beat = useBeat(
    () => [
      [0, () => stage.show('fleet', SHELVES)],
      [1.5, say({ turn: 1, came: 'woke', aGb: 8, aAwake: 1 })],
      [5.5, say({ turn: 2, came: 'woke', aGb: 12, aAwake: 2 })],
      [9.5, say({ turn: 3, came: 'woke', aGb: 15, aAwake: 3 })],
      [13.5, say({ turn: 4, came: 'moved' })],
      [14.3, say({ bGb: 3, bAwake: 1, bWorlds: 5 })],
    ],
    () => stage.show('fleet', SHELVES),
  )
  return (
    <Room
      beat={beat}
      room="fleet"
      name="Kept"
      tone="slate"
      line="Cubepals is building its own machines for this."
      span={11.5}
      drop={0.68}
      proof={proof}
    />
  )
}

/** Where the film ends: everyone in, and the one button. */
export function Last({ create }: { create: string }) {
  const beat = useBeat(() => [])
  return (
    <Beat
      {...beat}
      name="Your own"
      closing
      tone="paper"
      y={68}
      zoom="near"
      act="friends"
      side={0.8}
      shot={{ az: 63, el: 9, span: 24, drop: 0.58 }}
      className={styles.last}
    >
      <div className={styles.words} data-over>
        <h2 className="bl-display">Start a world with your friends</h2>
        <div>
          <Link href={create} className="bl-btn bl-btn--lg">
            Create a server
          </Link>
        </div>
      </div>
    </Beat>
  )
}
