'use client'

/**
 * The edge, shown by letting someone knock on it. One row of Minecraft's server list, the two
 * things Minecraft can do to an address (ask how the server is, or join), and the wire both
 * travel: Minecraft, the edge, and then whichever end really answers, the server or the edge's
 * own notice. Under it, the handshake the edge reads, byte for byte.
 *
 * Every string a player would see is the product's own, and the order of each sequence is the
 * code's (apps/edge/agent.ts, apps/edge/notice.ts, apps/control/src/app/edge/service.ts). The
 * times are not: the demonstration is sped up, and it shows the wake that finishes inside the
 * edge's hold. The section's note says what happens when it doesn't.
 *
 * Left alone it knocks by itself (`useTour`), with the same presses a person would make: a friend
 * joins the sleeping server, the list refreshes while that join is held, the server restarts, a
 * friend joins and is turned away, the server sleeps again.
 */

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Mark } from '../../ui/brand'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './address.module.css'
import { addressOf, EXAMPLE_NAME } from './choice'

// ─── The product's own words and numbers ─────────────────────────────────────────────────────

/** The hero's server, at an example address: <slug>.<play domain>, the port left out. */
const NAME = EXAMPLE_NAME
const ADDRESS = addressOf(EXAMPLE_NAME)

/** An awake server's default message. apps/control/src/domain/revision/revision.ts */
const MOTD_AWAKE = `"${NAME}", a server created by Cubepals`
/** The sleeping notice's answer to a ping. apps/edge/agent.ts */
const MOTD_ASLEEP = 'Sleeping · join to wake it up'
/** The restarting notice's answer to a ping, and to a join. apps/edge/agent.ts */
const MOTD_RESTARTING = 'Restarting · back in a moment'
const JOIN_RESTARTING = 'Restarting · join again in a moment'
/** What a ping reads while a join is waking the server. apps/edge/agent.ts */
const MOTD_STARTING = 'Starting up · try again in a moment'
/** Minecraft's own word for a row it has asked about and not heard from yet. */
const PINGING = 'Pinging...'

/** Where a sleeping server's name leads: a listener inside the edge. apps/edge/agent.ts */
const SLEEPING_NOTICE = '127.0.0.1:25563'
/** Where a restarting server's name leads. apps/edge/agent.ts */
const RESTARTING_NOTICE = '127.0.0.1:25564'
/** How long a join is held for a wake: wakeWaitMs 25_000. apps/control/src/main.node.ts */
const HOLD = '25 s'

/** The protocol version the edge's own status request speaks, a 1.21 client's. apps/edge/notice.ts */
const PROTOCOL = 767
/** Minecraft's port, the one the edge listens on. apps/edge/agent.ts */
const PORT = 25565

// ─── The handshake, encoded as Minecraft encodes it ──────────────────────────────────────────

/** A Minecraft VarInt: seven bits to a byte, low bits first, the top bit set while more follow. */
function varInt(value: number): number[] {
  const bytes: number[] = []
  let rest = value >>> 0
  do {
    const byte = rest & 0x7f
    rest >>>= 7
    bytes.push(rest === 0 ? byte : byte | 0x80)
  } while (rest !== 0)
  return bytes
}

const hex = (bytes: readonly number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')

/**
 * The first packet a client sends: its length, packet id 0, the protocol version, the address as
 * a length and UTF-8 bytes, the port big-endian, and the next state (1 asks for status, 2 joins).
 * The same layout apps/edge/notice.ts writes and reads.
 */
function handshake(address: string, port: number, next: 1 | 2) {
  const name = [...new TextEncoder().encode(address)]
  const id = varInt(0)
  const protocol = varInt(PROTOCOL)
  const size = varInt(name.length)
  const body = id.length + protocol.length + size.length + name.length + 2 + 1
  return {
    length: varInt(body),
    body,
    id,
    protocol,
    size,
    name,
    port: [port >> 8, port & 0xff],
    next: [next],
  }
}

/** Both handshakes this page can show; only the last byte differs. */
const SHAKE = { 1: handshake(ADDRESS, PORT, 1), 2: handshake(ADDRESS, PORT, 2) } as const

interface Cell {
  id: string
  hex: string
  /** What the byte spells: a letter of the name, or for the first cell how many bytes follow. */
  glyph: string
  counts?: boolean
}

/**
 * The address field, a byte to a cell with the letter it spells under it, in groups that begin at
 * each dot so a row can break between the labels of the name. An address is letters, digits,
 * dashes and dots, so each byte is one character. The first cell is the field's own length.
 */
const NAME_CELLS = SHAKE[1].name.reduce<Cell[][]>(
  (groups, byte, index) => {
    const cell: Cell = { id: `byte-${index}`, hex: hex([byte]), glyph: String.fromCharCode(byte) }
    const last = groups[groups.length - 1]
    if (last && byte !== 0x2e) last.push(cell)
    else groups.push([cell])
    return groups
  },
  [[{ id: 'size', hex: hex(SHAKE[1].size), glyph: String(SHAKE[1].name.length), counts: true }]],
)

// ─── What the demonstration holds ────────────────────────────────────────────────────────────

type Server = 'awake' | 'asleep' | 'restarting'
/** Where the edge's routes send the name: to the server, or to one of its own two notices. */
type Route = 'server' | 'sleeping' | 'restarting'
/** The control plane's own status names. apps/control/src/domain/server/lifecycle.ts */
type Status = 'running' | 'stopped' | 'starting'
/** Places on the wire the travelling block can be; the stylesheet knows where each one is. */
type At = 'mc' | 'edge' | 'fork' | 'turnServer' | 'server' | 'turnNotice' | 'notice'

/** What the server list last heard, and from whom. */
interface Listing {
  motd: string
  by: 'server' | 'notice' | 'edge'
  online: number
}

interface View {
  server: Server
  /** Null while it restarts: a restart passes through more than one status. */
  status: Status | null
  route: Route
  online: number
  joined: boolean
  /** The restarting notice turned the last join away. */
  turned: boolean
  /** The next state of the last handshake sent: 1 for a refresh, 2 for a join. */
  intent: 1 | 2
  at: At | null
  /** The edge is holding a join while the control plane works. */
  hold: boolean
  /** The list has asked and not heard back yet. */
  asking: boolean
  listing: Listing
  said: ReactNode
  busy: 'refresh' | 'join' | null
}

interface Step {
  wait: number
  patch: Partial<View>
  /** The gate's lamps in the chunk: a level, or null to hand them back to the page. */
  glow?: number | null
}

const CHIPS: { key: Server; label: string }[] = [
  { key: 'awake', label: 'Awake' },
  { key: 'asleep', label: 'Asleep' },
  { key: 'restarting', label: 'Restarting' },
]

/** Each state as the control plane and the routes hold it. Awake has two friends already on. */
const BASE: Record<Server, Pick<View, 'server' | 'status' | 'route' | 'online'>> = {
  awake: { server: 'awake', status: 'running', route: 'server', online: 2 },
  asleep: { server: 'asleep', status: 'stopped', route: 'sleeping', online: 0 },
  restarting: { server: 'restarting', status: null, route: 'restarting', online: 0 },
}

/**
 * What a status ping is answered, by where the name leads. The notices answer 0/0 players
 * (apps/edge/notice.ts); a running server answers its own message and count.
 */
const answer = (route: Route, online: number): Listing =>
  route === 'server'
    ? { motd: MOTD_AWAKE, by: 'server', online }
    : { motd: route === 'sleeping' ? MOTD_ASLEEP : MOTD_RESTARTING, by: 'notice', online: 0 }

const quote = (text: string) => <span className={`bl-game ${styles.quote}`}>{text}</span>

/** What just happened, a sentence at a time. */
const SAID = {
  // The row opens with an answer already in it, as Minecraft's list does: it asks when it is opened.
  idle: 'The list asked once, and the edge’s own notice answered. Refresh asks again; Join asks to come in.',
  asks: 'Minecraft asks the address how the server is.',
  reads: 'The edge reads the name in the handshake and looks up where it leads.',
  byServer: 'Your server answered for itself, with its own message and who is on.',
  bySleeping:
    'The edge’s own notice answered. Nothing woke: a refresh never wakes a server or keeps one awake.',
  byRestarting: 'The edge’s own notice answered while the server restarts. Nothing reached the server.',
  byEdge: 'A join is waking the server, so the edge answered the list by itself.',
  joins: 'Minecraft sends the same handshake, this time asking to join.',
  leads: 'The edge reads the name, and it leads to the server.',
  passed: 'The edge passed the connection through. From here the server checks the player itself.',
  holds: (
    <>
      The edge holds the connection, for up to <span className="bl-mono">{HOLD}</span>, and asks the control
      plane to wake the server.
    </>
  ),
  starting:
    'The control plane runs the same checks as the Start button, then starts it. A refresh now gets a different answer.',
  running: 'It is running. The control plane tells the edge the server’s private address.',
  flips: 'The route for this name now leads to the server, not the notice.',
  goes: 'The held join goes on to the server.',
  through: 'The held join got in. From here the server checks the player itself.',
  waits:
    'The edge holds the join while the control plane waits for the restart. It never starts the server twice.',
  turned: <>Still restarting. The edge’s own notice turns the join away: {quote(JOIN_RESTARTING)}</>,
  // The whole of a held join in one go, for someone who asked for less motion and sees no steps.
  wokeWhole: (
    <>
      The edge held the join, for up to <span className="bl-mono">{HOLD}</span>, while the control plane woke
      the server: <span className="bl-mono">stopped</span>, <span className="bl-mono">starting</span>,{' '}
      <span className="bl-mono">running</span>. The route turned to the server and the join got in.
    </>
  ),
  turnedWhole: (
    <>
      The edge held the join while the restart was waited for, and never started the server twice. Still
      restarting, so its own notice turned the join away: {quote(JOIN_RESTARTING)}
    </>
  ),
} satisfies Record<string, ReactNode>

const FIRST: View = {
  ...BASE.asleep,
  joined: false,
  turned: false,
  intent: 1,
  at: null,
  hold: false,
  asking: false,
  listing: answer('sleeping', 0),
  said: SAID.idle,
  busy: null,
}

/** One hop of the block along the wire, and how long an answer rests before the wire clears. */
const HOP = 300
const REST = 700
/** The gate's lamps dip as a handshake leaves Minecraft and come on as it arrives at the edge. */
const DIM = 0.25

const travel = (path: readonly At[]): Step[] => path.map((at) => ({ wait: HOP, patch: { at } }))
const CLEAR: Step = { wait: REST, patch: { at: null, busy: null }, glow: null }

/** A refresh: the ping goes to wherever the name leads, and the row reads what comes back. */
function refresh(now: View): Step[] {
  const said =
    now.route === 'server' ? SAID.byServer : now.route === 'sleeping' ? SAID.bySleeping : SAID.byRestarting
  return [
    {
      wait: 0,
      patch: { busy: 'refresh', intent: 1, at: 'mc', asking: true, hold: false, said: SAID.asks },
      glow: DIM,
    },
    { wait: HOP, patch: { at: 'edge', said: SAID.reads }, glow: 1 },
    ...travel(now.route === 'server' ? ['fork', 'turnServer', 'server'] : ['fork', 'turnNotice', 'notice']),
    { wait: HOP, patch: { asking: false, listing: answer(now.route, now.online), said } },
    CLEAR,
  ]
}

/**
 * A join. Awake, it is passed straight through. Asleep, the edge holds it and asks for a wake:
 * the status walks stopped, starting, running, the route turns to the server, and the join goes
 * on. Restarting, it is held while the restart is waited for, then turned away with a message.
 */
function join(now: View, fits: (players: number) => number): Step[] {
  const start: Step = {
    wait: 0,
    patch: { busy: 'join', intent: 2, at: 'mc', asking: false, hold: false, said: SAID.joins },
    glow: DIM,
  }
  if (now.route === 'server') {
    const online = fits(now.online + 1)
    return [
      start,
      { wait: HOP, patch: { at: 'edge', said: SAID.leads }, glow: 1 },
      ...travel(['fork', 'turnServer', 'server']),
      { wait: HOP, patch: { joined: true, online, listing: answer('server', online), said: SAID.passed } },
      CLEAR,
    ]
  }
  if (now.route === 'restarting')
    return [
      start,
      { wait: HOP, patch: { at: 'edge', hold: true, said: SAID.waits }, glow: 1 },
      { wait: 2200, patch: { at: 'fork', hold: false } },
      ...travel(['turnNotice', 'notice']),
      { wait: HOP, patch: { turned: true, said: SAID.turned } },
      CLEAR,
    ]
  const online = fits(1)
  return [
    start,
    { wait: HOP, patch: { at: 'edge', hold: true, said: SAID.holds }, glow: 1 },
    { wait: 1800, patch: { status: 'starting', said: SAID.starting } },
    { wait: 2800, patch: { status: 'running', server: 'awake', said: SAID.running } },
    { wait: 1400, patch: { route: 'server', said: SAID.flips } },
    { wait: 1100, patch: { at: 'fork', hold: false, said: SAID.goes } },
    ...travel(['turnServer', 'server']),
    {
      wait: HOP,
      patch: { joined: true, online, asking: false, listing: answer('server', online), said: SAID.through },
    },
    CLEAR,
  ]
}

// ─── Left alone, it plays itself ─────────────────────────────────────────────────────────────

/**
 * What the tour does next: a friend joins the sleeping server, the list refreshes while that join
 * is held, the server restarts, a friend joins and is turned away, the server sleeps again.
 */
type Move = 'wake' | 'ask' | 'restart' | 'knock' | 'sleep'

/**
 * The next move is read off where the demonstration stands, never off what the tour did last: a
 * person may have left it anywhere, in the middle of a join included. So no move ever lands on a
 * Join that has nothing to do, and from any state the tour is back on its round within a move.
 */
function moveFrom(view: View): Move {
  // One join to a restart: once it is under way or has been turned away, the server goes to sleep.
  if (view.server === 'restarting') return view.turned || view.busy === 'join' ? 'sleep' : 'knock'
  if (view.busy === 'join') {
    const asked = view.asking || view.listing.by === 'edge'
    return view.route === 'sleeping' && !asked ? 'ask' : 'restart'
  }
  return view.server === 'asleep' ? 'wake' : 'restart'
}

/**
 * What the bar says is coming, and how many seconds it runs first: long enough for the sequence
 * the move before it started to finish and its last line to be read. One is shorter on purpose:
 * the list refreshes three seconds into a wake, while the edge still holds the join, and the
 * restart then waits out the rest of that join.
 *
 * On an untouched round the move that is next never changes while its bar runs. It can when the
 * tour picks a wake up part-way (played again after a pause, or scrolled back to) too late for the
 * refresh to land: the route turns and the restart becomes next while the refresh's short bar is
 * still running. The window is fixed when the countdown starts (tour.tsx), so the step lets that
 * turn pass and the restart gets a bar of its own.
 */
const TOUR: Record<Move, { label: string; after: number }> = {
  wake: { label: 'A friend joins', after: 6 },
  ask: { label: 'The list refreshes', after: 3 },
  restart: { label: 'The server restarts', after: 9 },
  knock: { label: 'A friend joins', after: 5 },
  sleep: { label: 'The server sleeps', after: 7 },
}

// ─── Playing a sequence in time ──────────────────────────────────────────────────────────────

/** The steps still to come, and the timers that will take them. */
interface Player {
  queue: Step[]
  timer: ReturnType<typeof setTimeout> | null
  /** A refresh pressed while a join is held: answered apart from the join, which goes on. */
  side: ReturnType<typeof setTimeout> | null
}

/** Takes the next step when its time comes, then the one after. */
function advance(player: Player, apply: (step: Step) => void): void {
  const step = player.queue[0]
  if (!step) {
    player.timer = null
    return
  }
  player.timer = setTimeout(() => {
    player.queue.shift()
    apply(step)
    advance(player, apply)
  }, step.wait)
}

/** A line of the wire: solid where the route leads, dither (a pixel on, a pixel off) where not. */
function Wire({
  ghost,
  x1,
  y1,
  x2,
  y2,
}: {
  ghost?: boolean
  x1: string | number
  y1: number
  x2: string | number
  y2: number
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      strokeLinecap={ghost ? 'butt' : 'square'}
      strokeDasharray={ghost ? '2 2' : undefined}
    />
  )
}

const BARS = [1, 2, 3, 4, 5]

export function AddressDemo({ maxPlayers }: { maxPlayers: number | null }) {
  const root = useRef<HTMLDivElement>(null)
  const statesId = useId()
  const inView = useInView(root)
  const reduced = useReducedMotion()
  // The truth is kept in a ref so a press reads it at once; the state only redraws.
  const now = useRef<View>(FIRST)
  const [view, setView] = useState<View>(FIRST)
  const player = useRef<Player>({ queue: [], timer: null, side: null })

  const update = useCallback((patch: Partial<View>) => {
    now.current = { ...now.current, ...patch }
    setView(now.current)
  }, [])

  const apply = useCallback(
    (step: Step) => {
      update(step.patch)
      if (step.glow !== undefined) stage.glow('edge', step.glow)
    },
    [update],
  )

  /** Finishes whatever is under way at once, leaving its end state. */
  const flush = useCallback(() => {
    const held = player.current
    if (held.timer) clearTimeout(held.timer)
    held.timer = null
    if (held.side) {
      clearTimeout(held.side)
      held.side = null
      update({ asking: false })
    }
    for (const step of held.queue.splice(0)) apply(step)
  }, [apply, update])

  /** Runs `steps` in time. `whole` says all of it at once, for when nothing is shown in between. */
  const play = (steps: Step[], whole?: ReactNode) => {
    flush()
    // Asked for less motion: the answer arrives at once, with nothing travelling.
    if (reduced) {
      for (const step of steps) apply(step)
      if (whole) update({ said: whole })
      return
    }
    const queue = [...steps]
    let first = queue[0]
    while (first && first.wait === 0) {
      apply(first)
      queue.shift()
      first = queue[0]
    }
    player.current.queue = queue
    advance(player.current, apply)
  }

  const put = (server: Server) => {
    flush()
    update({ ...BASE[server], joined: false, turned: false, hold: false, at: null, busy: null })
    // Minecraft asks again whenever its list is opened; so does this, when the server changes.
    play(refresh(now.current))
  }

  const pressRefresh = () => {
    const held = player.current
    // A join is waking the server: this ping is a second connection, and the join goes on.
    if (now.current.busy === 'join' && now.current.hold && now.current.route === 'sleeping') {
      if (held.side) clearTimeout(held.side)
      update({ asking: true, intent: 1 })
      held.side = setTimeout(() => {
        held.side = null
        update(
          now.current.hold
            ? { asking: false, listing: { motd: MOTD_STARTING, by: 'edge', online: 0 }, said: SAID.byEdge }
            : { asking: false },
        )
      }, 480)
      return
    }
    flush()
    play(refresh(now.current))
  }

  const pressJoin = () => {
    if (now.current.joined || now.current.busy === 'join') return
    flush()
    const { route } = now.current
    play(
      join(now.current, (players) => (maxPlayers ? Math.min(players, maxPlayers) : players)),
      route === 'sleeping' ? SAID.wokeWhole : route === 'restarting' ? SAID.turnedWhole : undefined,
    )
  }

  // Nothing here waits for a press. The tour makes the presses a person would, one move at a time,
  // and each is valid wherever the demonstration stands (`moveFrom`).
  const coming = TOUR[moveFrom(view)]
  const tour = useTour({
    ref: root,
    steps: [
      () => {
        const move = moveFrom(now.current)
        // A wake picked up part-way can turn its route inside the refresh's short window. The
        // restart then waits a window of its own: this step is let pass, and the next bar runs
        // the restart's, by which the join is in.
        if (move === 'restart' && now.current.busy === 'join') return
        if (move === 'wake' || move === 'knock') pressJoin()
        else if (move === 'ask') pressRefresh()
        else put(move === 'restart' ? 'restarting' : 'asleep')
      },
    ],
    seconds: coming.after,
    first: 3,
  })

  // Scrolled away mid-run: nothing keeps ticking out of sight.
  useEffect(() => {
    if (!inView) flush()
  }, [inView, flush])

  // The room drawn beside this plays the same thing out: a server behind a door. It is told only
  // what it can show: what the server is doing, where the name leads, and what is at the door.
  useEffect(() => {
    stage.show('edge', {
      power: view.status ?? 'restarting',
      route: view.route === 'server' ? 'server' : 'notice',
      joining: view.busy === 'join',
      held: view.hold,
      asking: view.asking,
    })
  }, [view.status, view.route, view.busy, view.hold, view.asking])

  useEffect(() => {
    const held = player.current
    return () => {
      if (held.timer) clearTimeout(held.timer)
      if (held.side) clearTimeout(held.side)
      held.queue = []
      stage.glow('edge', null)
      // Gone from the page: the room has nothing to follow, and plays by itself.
      stage.show('edge', null)
    }
  }, [])

  const { listing } = view
  const fromServer = !view.asking && listing.by === 'server'
  // A notice answers "0/0", which is accurate and reads as nonsense: the row shows nobody on of
  // however many may be, as a person would expect.
  const online = fromServer ? listing.online : 0
  const count = maxPlayers ? `${online}/${maxPlayers}` : `${online}`
  const toServer = view.route === 'server'
  const noticeAt = view.route === 'restarting' ? RESTARTING_NOTICE : SLEEPING_NOTICE
  const shake = SHAKE[view.intent]
  const joinLabel = view.joined ? 'Joined' : view.busy === 'join' ? 'Joining' : 'Join'
  const joinOff = view.joined || view.busy === 'join'

  return (
    <div className={styles.panel} ref={root}>
      <TourBar tour={tour} label={coming.label} className={styles.tour} />
      <div className={styles.stack}>
        <div className={styles.list}>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset */}
          <div className={styles.states} role="group" aria-labelledby={statesId}>
            <span className={styles.statesLabel} id={statesId}>
              The server is
            </span>
            {CHIPS.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="bl-chip"
                aria-pressed={view.server === chip.key}
                onClick={() => put(chip.key)}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div
            className={`bl-frame bl-frame--solid ${styles.listing}`}
            data-by={view.asking ? undefined : listing.by}
          >
            <span className={styles.icon}>
              <Mark />
            </span>
            <span className={`bl-game ${styles.name}`}>{NAME}</span>
            <span className={`bl-game bl-num ${styles.count}`}>
              {view.asking ? '' : count}
              <span className={styles.bars} aria-hidden>
                {BARS.map((bar) => (
                  <i key={bar} data-on={fromServer || undefined} style={{ height: `${bar * 3 + 1}px` }} />
                ))}
              </span>
            </span>
            <span className={`bl-game ${styles.motd}`}>{view.asking ? PINGING : listing.motd}</span>
          </div>

          <div className={styles.under}>
            <span className={`bl-game ${styles.host}`}>{ADDRESS}</span>
            <span className={styles.actions}>
              <button type="button" className="bl-btn bl-btn--sm bl-btn--quiet" onClick={pressRefresh}>
                Refresh
              </button>
              <button type="button" className="bl-btn bl-btn--sm" aria-disabled={joinOff} onClick={pressJoin}>
                {joinLabel}
              </button>
            </span>
          </div>
        </div>

        <hr className="bl-rule" />

        <div className={styles.wire}>
          <svg
            className={`${styles.lines} ${styles.linesWide}`}
            width="100%"
            height="100%"
            shapeRendering="crispEdges"
            aria-hidden
            focusable="false"
          >
            <g stroke="currentColor" strokeWidth="2" fill="none">
              <Wire x1="19%" y1={68} x2="27%" y2={68} />
              <Wire x1="51%" y1={68} x2="55.5%" y2={68} />
              <Wire ghost={!toServer} x1="55.5%" y1={68} x2="55.5%" y2={30} />
              <Wire ghost={!toServer} x1="55.5%" y1={30} x2="60%" y2={30} />
              <Wire ghost={toServer} x1="55.5%" y1={68} x2="55.5%" y2={106} />
              <Wire ghost={toServer} x1="55.5%" y1={106} x2="60%" y2={106} />
            </g>
          </svg>
          <svg
            className={`${styles.lines} ${styles.linesTall}`}
            width="100%"
            height="100%"
            shapeRendering="crispEdges"
            aria-hidden
            focusable="false"
          >
            <g stroke="currentColor" strokeWidth="2" fill="none">
              <Wire x1={16} y1={44} x2={16} y2={80} />
              <Wire x1={16} y1={140} x2={16} y2={190} />
              <Wire ghost={!toServer} x1={16} y1={190} x2={40} y2={190} />
              <Wire ghost={toServer} x1={16} y1={190} x2={16} y2={262} />
              <Wire ghost={toServer} x1={16} y1={262} x2={40} y2={262} />
            </g>
          </svg>

          {view.at && (
            <i className={styles.block} data-at={view.at} data-held={view.hold || undefined} aria-hidden />
          )}

          <div className={`bl-frame ${styles.station} ${styles.mc}`}>
            <span className={styles.title}>Minecraft</span>
          </div>
          <div className={`bl-frame ${styles.station} ${styles.edge}`}>
            <span className={styles.title}>The edge</span>
            {view.hold && <span className={styles.sub}>holding the join</span>}
          </div>
          <div
            className={`bl-frame ${toServer ? 'bl-frame--solid ' : ''}${styles.station} ${styles.server}`}
            data-ghost={!toServer || undefined}
          >
            {!toServer && <i className={`bl-dither ${styles.tint}`} data-level="2" aria-hidden />}
            <span className={styles.title}>Your server</span>
            {view.status ? (
              <span className={`bl-mono ${styles.sub}`}>
                {view.status === 'running' && <i className={styles.lamp} aria-hidden />}
                {view.status}
              </span>
            ) : (
              <span className={styles.sub}>restarting</span>
            )}
            <span className={styles.sr}>
              {toServer ? 'The name leads here.' : 'The name does not lead here.'}
            </span>
          </div>
          <div
            className={`bl-frame ${toServer ? '' : 'bl-frame--solid '}${styles.station} ${styles.notice}`}
            data-ghost={toServer || undefined}
          >
            {toServer && <i className={`bl-dither ${styles.tint}`} data-level="2" aria-hidden />}
            <span className={styles.title}>The edge’s own notice</span>
            <span className={`bl-mono ${styles.sub}`}>{noticeAt}</span>
            <span className={styles.sr}>
              {toServer ? 'The name does not lead here.' : 'The name leads here.'}
            </span>
          </div>
        </div>

        <p className={`bl-body ${styles.said}`} aria-live={tour.auto ? 'off' : 'polite'}>
          {view.said}
        </p>

        <hr className="bl-rule" />

        <div className={styles.shake}>
          <p className="bl-small">
            The handshake: the first thing Minecraft sends, here from a 1.21 client. The address in it is all
            the edge routes by.
          </p>
          <dl className={styles.packet}>
            <div className={styles.field}>
              <dt>
                length <span className="bl-mono">{shake.body}</span>
              </dt>
              <dd className="bl-mono">{hex(shake.length)}</dd>
            </div>
            <div className={styles.field}>
              <dt>
                packet id <span className="bl-mono">0</span>
              </dt>
              <dd className="bl-mono">{hex(shake.id)}</dd>
            </div>
            <div className={styles.field}>
              <dt>
                protocol version <span className="bl-mono">{PROTOCOL}</span>
              </dt>
              <dd className="bl-mono">{hex(shake.protocol)}</dd>
            </div>
            <div className={`bl-frame bl-frame--solid ${styles.field} ${styles.wanted}`}>
              <dt>The address, as the player typed it</dt>
              <dd>
                <span className={styles.sr}>
                  {hex(shake.size)}, then the {shake.name.length} bytes of {ADDRESS}
                </span>
                <span className={styles.cells} aria-hidden>
                  {NAME_CELLS.map((group) => (
                    <span key={group[0]?.id} className={styles.label}>
                      {group.map((cell) => (
                        <span key={cell.id} className={styles.cell}>
                          <span className="bl-mono">{cell.hex}</span>
                          {cell.counts ? (
                            <span className={`bl-mono ${styles.size}`}>{cell.glyph}</span>
                          ) : (
                            <span className={`bl-game ${styles.glyph}`}>{cell.glyph}</span>
                          )}
                        </span>
                      ))}
                    </span>
                  ))}
                </span>
              </dd>
            </div>
            <div className={styles.field}>
              <dt>
                port <span className="bl-mono">{PORT}</span>
              </dt>
              <dd className="bl-mono">{hex(shake.port)}</dd>
            </div>
            <div className={styles.field}>
              <dt>
                next state <span className="bl-mono">{view.intent}</span>
                {view.intent === 1 ? ', a refresh' : ', a join'}
              </dt>
              <dd className="bl-mono">{hex(shake.next)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}
