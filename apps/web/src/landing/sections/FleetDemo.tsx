// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The fleet stratum's demonstration: asleep is disk, awake is memory.
 *
 * Two of Blockly's own machines. Each is drawn as a column of memory over a shelf of the worlds
 * placed on it, and every world starts asleep: a flat slab on the shelf, nothing in the column.
 * Pressing a world wakes it the way the fleet runtime does: its memory is
 * claimed in the ledger first, then it stands in the column at its real size. A wake that doesn't
 * fit beside the worlds running on its machine goes through the archive store to the other machine
 * under a new placement epoch, and the copy it leaves is fenced. With no room on either, it is
 * refused in the code's own sentence.
 *
 * Apart from that, one machine has a cable. Cut it and its heartbeats stop: the ledger reads it
 * suspect, then unavailable, its lease runs out, and nothing moves. Only "Declare it lost", which
 * stands for an operator saying how the machine was stopped, rebuilds its worlds on the other
 * machine from their last uploaded backups.
 *
 * The rules are ports of `startRefusal` and `refusal` (apps/control/src/infra/fleet/placement.ts),
 * of the wake path in fleet-runtime.ts and of `confirmLost` in registry.ts, with their sentences
 * and event names. None of it has run in production yet; the machines, the worlds and their sizes
 * are examples. The example machines have cores, disk and ports to spare, so only memory ever
 * refuses here.
 *
 * Nothing here waits to be pressed. Left alone it plays itself (`useTour`) with the presses a
 * person would make on the worlds: one machine fills, the next world to wake there has to move, the
 * other machine fills, a wake is refused, a world goes back to sleep, and it starts over. Each
 * move is read off the fleet as it stands, so it carries on from wherever a person left it. The
 * cable is never the tour's to cut: it is too far down to be seen with the machines, and if
 * someone left it cut the tour starts over.
 */
import { type CSSProperties, Fragment, useEffect, useReducer, useRef, useState } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './fleet.module.css'

// ─── The numbers ─────────────────────────────────────────────────────────────────────────────

/**
 * What each example machine has for worlds, its `allocatableMemoryMb`: an 18 GB machine less the
 * 2 GB a node keeps for its host (`reserved_memory_mb`, docs/fleet.md).
 */
const ALLOCATABLE_MB = 16_384
/**
 * FLEET_MEMORY_OVERCOMMIT: the worlds placed on a machine, running or asleep, may add up to its
 * memory times this. apps/control/src/config/load.ts, apps/control/src/infra/fleet/placement.ts
 */
const MEMORY_OVERCOMMIT = 4
/** FLEET_HEADROOM_MB: memory kept free on every machine for a move to land. load.ts */
const HEADROOM_MB = 0
/** FLEET_HEARTBEAT_SECONDS, FLEET_SUSPECT_SECONDS, FLEET_UNAVAILABLE_SECONDS, FLEET_LEASE_SECONDS. load.ts */
const HEARTBEAT_SECONDS = 5
const SUSPECT_SECONDS = 15
const UNAVAILABLE_SECONDS = 45
const LEASE_SECONDS = 120
/** The smallest size sold, in MB. apps/control/src/domain/server/size.ts */
const SMALLEST_MB = 3072
/**
 * HOST_LOSS_GRACE_MS, in minutes: how long a lost machine's worlds wait before any is rebuilt
 * elsewhere, because hosts come back. apps/control/src/app/operations/schedules.ts
 */
const HOST_LOSS_GRACE_MINUTES = 10

/** What an owner reads when a runtime has no room. apps/control/src/app/errors.ts */
const NO_ROOM = 'There was no room for it where it runs just then. Try again in a few minutes.'
/** What a start of a displaced world is answered with. apps/control/src/infra/fleet/fleet-runtime.ts */
const HOST_LOST =
  "This server's host was lost. It is rebuilt from its newest backup where there is room; nothing runs it meanwhile."
/** blocklyd's journal, when its heartbeats stop being answered and when they are again. cubepals/blocklyd src/fleet/heartbeat.rs */
const JOURNAL_SILENT = "heartbeat: the control plane doesn't answer; workloads carry on"
const JOURNAL_BACK = 'heartbeat: the control plane answers again'
const JOURNAL_FENCED = 'heartbeat: fenced a superseded copy'
/** How an operator says a machine was stopped, and why it is lost. docs/fleet.md, docs/fleet-operations.md */
const FENCED_BY = "powered off in the provider's console"
const LOST_REASON = 'disk failure'

// ─── The example fleet ───────────────────────────────────────────────────────────────────────

type NodeId = 'a' | 'b'
const NODES: readonly NodeId[] = ['a', 'b']
/** Example names, in the shape of the node id in the protocol's own example. cubepals/blocklyd docs/protocol.md */
const NODE_NAME: Record<NodeId, string> = { a: 'fra-box-1', b: 'fra-box-2' }
/** The machine whose cable can be cut. */
const CABLED: NodeId = 'a'
const otherOf = (node: NodeId): NodeId => (node === 'a' ? 'b' : 'a')

interface World {
  id: string
  name: string
  memoryMb: number
  /** The machine it is placed on when the example starts. */
  home: NodeId
}

/** Nine worlds in the three sizes sold: 3, 4 and 8 GB (size.ts). Nobody's real servers. */
const WORLDS: readonly World[] = [
  { id: 'old-mill', name: 'Old Mill', memoryMb: 3072, home: 'a' },
  { id: 'copper-bay', name: 'Copper Bay', memoryMb: 8192, home: 'a' },
  { id: 'mossy-den', name: 'Mossy Den', memoryMb: 4096, home: 'a' },
  { id: 'fox-hill', name: 'Fox Hill', memoryMb: 3072, home: 'a' },
  { id: 'pine-ridge', name: 'Pine Ridge', memoryMb: 4096, home: 'a' },
  { id: 'salt-flats', name: 'Salt Flats', memoryMb: 8192, home: 'b' },
  { id: 'birch-row', name: 'Birch Row', memoryMb: 4096, home: 'b' },
  { id: 'stone-gate', name: 'Stone Gate', memoryMb: 3072, home: 'b' },
  { id: 'tall-grass', name: 'Tall Grass', memoryMb: 4096, home: 'b' },
]

// ─── The ledger ──────────────────────────────────────────────────────────────────────────────

/**
 * `stopped` and `running` are the placement's `desired_power`. `claimed` is `running` in the ledger
 * before the machine has reported the copy running: the claim is written first (fleet-runtime.ts).
 */
type Power = 'stopped' | 'claimed' | 'running'

/** A world's row in `fleet_placements`, as far as this example goes. */
interface Placement {
  node: NodeId
  /** Rises with every new home, and is never reused (docs/fleet.md). */
  epoch: number
  /** Its machine was declared lost: nothing runs it, and it holds no memory (registry.ts). */
  displaced: boolean
  power: Power
  /** When it last claimed memory, so the column stacks worlds in the order they woke. */
  since: number
  /** Rebuilt from its last uploaded backup after its machine was declared lost. */
  rebuilt: boolean
}

/** A copy of a world left on a machine that is no longer its home. */
interface Copy {
  world: string
  node: NodeId
  epoch: number
  fenced: boolean
  /** A lost machine's copy is kept for its owner; a move's is gone the next time anything happens. */
  kept: boolean
}

interface Sim {
  placements: Readonly<Record<string, Placement>>
  copies: readonly Copy[]
  /** The cabled machine's lifecycle is `lost`. */
  lost: boolean
}

type Health = 'healthy' | 'suspect' | 'unavailable'

/** One thing written to the ledger: a row of a table, or an event in `fleet_events`. */
interface Line {
  /** The step of the operation it is written at. */
  at: number
  /** The world it is about, in plain words; the row itself holds the server's id. */
  who?: string
  /** The table, or the event's kind. */
  kind: string
  pairs: readonly (readonly [string, string | number])[]
}

/** Something said beside the ledger: a record, a journal line, or what an owner reads. */
interface Note {
  label: string
  mono?: string
  quote?: string
}

interface Step {
  sim: Sim
  /** What just happened, in plain words. */
  tell: string
}

/** Everything one press sets going: the fleet after each step of it, and what each step wrote. */
interface Op {
  /** Whether the pressed thing was a world or the cable, which is where its words are shown. */
  where: 'worlds' | 'cable'
  /** What a press on a world came to. The tour reads it to choose what to show next, and for how long. */
  came?: 'woke' | 'moved' | 'refused' | 'slept'
  steps: readonly Step[]
  lines: readonly Line[]
  notes: readonly Note[]
}

interface State {
  op: Op
  /** How many of the operation's steps have landed. */
  shown: number
  cut: boolean
  /** Seconds since the cabled machine's last heartbeat was answered. */
  silent: number
  clock: number
  /** For someone who hears the page: the last thing that happened. */
  said: string
}

type Action =
  /** `still`: the visitor asked for less motion, so everything arrives at once. */
  | { type: 'press'; world: string; still: boolean }
  | { type: 'cut'; still: boolean }
  | { type: 'plug'; still: boolean }
  | { type: 'lose'; still: boolean }
  | { type: 'step' }
  | { type: 'beat' }
  | { type: 'reset' }

const START_SIM: Sim = {
  placements: Object.fromEntries(
    WORLDS.map((world): [string, Placement] => [
      world.id,
      { node: world.home, epoch: 1, displaced: false, power: 'stopped', since: 0, rebuilt: false },
    ]),
  ),
  copies: [],
  lost: false,
}

const START: State = {
  op: {
    where: 'worlds',
    steps: [{ sim: START_SIM, tell: 'Nothing is running, so neither machine’s memory is in use.' }],
    lines: [],
    notes: [],
  },
  shown: 1,
  cut: false,
  silent: 0,
  clock: 0,
  said: '',
}

const simOf = (state: State): Sim => state.op.steps[state.op.steps.length - 1]?.sim ?? START_SIM

/** The fleet before the next thing happens: a move's leftover copy has gone to its machine's trash by then. */
const tidy = (sim: Sim): Sim => ({ ...sim, copies: sim.copies.filter((copy) => copy.kept) })

function alter(sim: Sim, id: string, change: Partial<Placement>): Sim {
  const placement = sim.placements[id]
  if (!placement) return sim
  return { ...sim, placements: { ...sim.placements, [id]: { ...placement, ...change } } }
}

const sumOn = (sim: Sim, node: NodeId, counts: (placement: Placement) => boolean): number =>
  WORLDS.reduce((sum, world) => {
    const placement = sim.placements[world.id]
    return placement && placement.node === node && !placement.displaced && counts(placement)
      ? sum + world.memoryMb
      : sum
  }, 0)

/**
 * The memory the ledger holds on a machine: for the worlds that run or are being started, never
 * for one asleep (`HOLDS`, apps/control/src/infra/fleet/registry.ts).
 */
const heldMb = (sim: Sim, node: NodeId): number => sumOn(sim, node, (p) => p.power !== 'stopped')
/** The memory of every world placed on a machine, running or asleep (registry.ts). */
const placedMb = (sim: Sim, node: NodeId): number => sumOn(sim, node, () => true)

/**
 * What the ledger makes of a machine's silence. The code's test is "more than" each threshold
 * (apps/control/src/infra/fleet/health.ts); the test rig read suspect at 15.0 s and
 * unavailable at 45.0 s, and this clock moves a heartbeat at a time, so it turns on the threshold.
 */
function healthOf(state: Pick<State, 'cut' | 'silent'>, node: NodeId): Health {
  if (node !== CABLED || !state.cut) return 'healthy'
  if (state.silent >= UNAVAILABLE_SECONDS) return 'unavailable'
  return state.silent >= SUSPECT_SECONDS ? 'suspect' : 'healthy'
}

/**
 * Why a sleeping world can't start on the machine it is on, or null when it can: `startRefusal`
 * (apps/control/src/infra/fleet/placement.ts). The sentence is the code's.
 */
function startRefusal(sim: Sim, node: NodeId, memoryMb: number): string | null {
  const free = ALLOCATABLE_MB - heldMb(sim, node)
  return free < memoryMb
    ? `memory: ${free} MB free beside the servers running there, needs ${memoryMb}`
    : null
}

/**
 * Why a machine can't take a world that is moved or rebuilt onto it, or null when it can:
 * `refusal`, in its own order (placement.ts). A placement starts where it lands, so it
 * needs room to run now as well as room to stay.
 */
function refusal(state: State, sim: Sim, node: NodeId, memoryMb: number): string | null {
  if (node === CABLED && sim.lost) return 'lifecycle lost'
  const health = healthOf(state, node)
  if (health !== 'healthy') return `health ${health}`
  const free = ALLOCATABLE_MB - heldMb(sim, node) - HEADROOM_MB
  if (free < memoryMb) return `memory: ${free} MB free after headroom, needs ${memoryMb}`
  const placeable = ALLOCATABLE_MB * MEMORY_OVERCOMMIT - placedMb(sim, node)
  if (placeable < memoryMb) return `memory: ${placeable} MB left to place servers in, needs ${memoryMb}`
  return null
}

/**
 * Every machine a placement looked at, as its record lists them: by name, the one the world is
 * leaving `excluded` (placement.ts; fleet-runtime.ts).
 */
function considered(state: State, sim: Sim, leaving: NodeId, memoryMb: number) {
  const seen = NODES.map((node) => ({
    node,
    reason: node === leaving ? 'excluded' : (refusal(state, sim, node, memoryMb) ?? 'ok'),
  }))
  return {
    to: seen.find((entry) => entry.reason === 'ok')?.node ?? null,
    text: seen.map((entry) => `${NODE_NAME[entry.node]}: ${entry.reason}`).join('; '),
  }
}

const worlds = (count: number) => `${count} ${count === 1 ? 'world' : 'worlds'}`

/** A world wakes: `ensureProvisioned` for a server that is asleep (fleet-runtime.ts). */
function wake(state: State, sim: Sim, world: World, placement: Placement): Op {
  const from = placement.node
  const here = NODE_NAME[from]
  const why = startRefusal(sim, from, world.memoryMb)
  if (why === null) {
    // Room where it sleeps: its memory is claimed in the ledger, then its machine starts it.
    const claimed = alter(sim, world.id, { power: 'claimed', since: state.clock + 1 })
    const running = alter(claimed, world.id, { power: 'running' })
    const free = ALLOCATABLE_MB - heldMb(running, from)
    const tight =
      free < SMALLEST_MB
        ? ` No world fits in that: the next one to wake on ${here} has to go somewhere else.`
        : ''
    return {
      where: 'worlds',
      came: 'woke',
      steps: [
        {
          sim: claimed,
          tell: `The ledger claims ${world.memoryMb} MB on ${here} for ${world.name}, before the machine is asked for anything.`,
        },
        { sim: running, tell: `${world.name} runs on ${here}, which has ${free} MB left.${tight}` },
      ],
      lines: [
        {
          at: 0,
          who: world.name,
          kind: 'fleet_placements',
          pairs: [
            ['node_id', here],
            ['epoch', placement.epoch],
            ['memory_mb', world.memoryMb],
            ['desired_power', 'running'],
          ],
        },
        {
          at: 1,
          who: world.name,
          kind: 'fleet_observations',
          pairs: [
            ['node_id', here],
            ['epoch', placement.epoch],
            ['state', 'running'],
          ],
        },
      ],
      notes: [],
    }
  }

  // No room beside the worlds running there: it moves first, if another machine has room now
  // (`#startElsewhere`, fleet-runtime.ts).
  const elsewhere = considered(state, sim, from, world.memoryMb)
  if (elsewhere.to === null)
    return {
      where: 'worlds',
      came: 'refused',
      steps: [
        {
          sim,
          tell: `${here} has no room to run ${world.name} now, and it can’t go to ${NODE_NAME[otherOf(from)]} either, so the wake is refused before anything is copied. Put a world to sleep and try again.`,
        },
      ],
      lines: [],
      notes: [
        {
          label: 'On the operation’s record',
          // `RuntimeFull`, apps/control/src/app/ports/runtime.ts; fleet-runtime.ts
          mono: `The fleet runtime has no room: ${here}: ${why}; elsewhere: ${elsewhere.text}`,
        },
        { label: 'What its owner reads', quote: NO_ROOM },
      ],
    }

  const to = elsewhere.to
  const there = NODE_NAME[to]
  const epoch = placement.epoch + 1
  const left: Copy = { world: world.id, node: from, epoch: placement.epoch, fenced: false, kept: false }
  const rehomed: Sim = {
    ...alter(sim, world.id, { node: to, epoch, power: 'claimed', since: state.clock + 1 }),
    copies: [...sim.copies, left],
  }
  const fenced: Sim = { ...rehomed, copies: [...sim.copies, { ...left, fenced: true }] }
  const running = alter(fenced, world.id, { power: 'running' })
  return {
    where: 'worlds',
    came: 'moved',
    steps: [
      {
        sim,
        tell: `${here} has ${ALLOCATABLE_MB - heldMb(sim, from)} MB free and ${world.name} needs ${world.memoryMb}. ${there} has the room, so its world is copied from ${here} to the archive store.`,
      },
      {
        sim: rehomed,
        tell: `The ledger gives ${world.name} a new home on ${there}, under epoch ${epoch}, and claims its memory there.`,
      },
      {
        sim: fenced,
        tell: `${there} restores the world from the archive store. The copy left on ${here} is fenced: it is from an older epoch, so nothing will ever start it again.`,
      },
      {
        sim: running,
        tell: `${world.name} runs on ${there}, under epoch ${epoch}. Nobody was asked: the world is the same wherever it runs.`,
      },
    ],
    lines: [
      {
        at: 0,
        who: world.name,
        kind: 'move.exported',
        pairs: [
          ['node', here],
          ['epoch', placement.epoch],
        ],
      },
      {
        at: 1,
        who: world.name,
        kind: 'placement.moved_for_room',
        pairs: [
          ['node', there],
          ['epoch', epoch],
          ['fromNode', here],
          ['fromEpoch', placement.epoch],
          ['why', why],
        ],
      },
      {
        at: 2,
        who: world.name,
        kind: 'placement.restored',
        pairs: [
          ['node', there],
          ['epoch', epoch],
        ],
      },
      {
        at: 2,
        who: world.name,
        kind: 'copy.fenced',
        pairs: [
          ['node', here],
          ['epoch', placement.epoch],
        ],
      },
      {
        at: 3,
        who: world.name,
        kind: 'fleet_observations',
        pairs: [
          ['node_id', there],
          ['epoch', epoch],
          ['state', 'running'],
        ],
      },
    ],
    notes: [],
  }
}

/** A world goes to sleep: the stop gives its claim back (fleet-runtime.ts). */
function sleep(sim: Sim, world: World, placement: Placement): Op {
  const here = NODE_NAME[placement.node]
  return {
    where: 'worlds',
    came: 'slept',
    steps: [
      {
        sim: alter(sim, world.id, { power: 'stopped' }),
        tell: `${world.name} is asleep. Its ${world.memoryMb} MB went back to ${here}, and its world stays on the disk there.`,
      },
    ],
    lines: [
      {
        at: 0,
        who: world.name,
        kind: 'fleet_placements',
        pairs: [
          ['node_id', here],
          ['epoch', placement.epoch],
          ['desired_power', 'stopped'],
        ],
      },
    ],
    notes: [],
  }
}

/**
 * A displaced world is rebuilt on another machine from its last uploaded backup, under a new
 * epoch (`#rebuild`, fleet-runtime.ts). One that was running is started where it lands
 * (apps/control/src/app/operations/handlers.ts). A string is why no machine could take it.
 */
function rebuild(
  state: State,
  sim: Sim,
  world: World,
  placement: Placement,
  since: number,
): { sim: Sim; line: Omit<Line, 'at'>; epoch: number } | string {
  const from = placement.node
  const elsewhere = considered(state, sim, from, world.memoryMb)
  if (elsewhere.to === null) return elsewhere.text
  const epoch = placement.epoch + 1
  const moved = alter(sim, world.id, {
    node: elsewhere.to,
    epoch,
    displaced: false,
    power: placement.power === 'stopped' ? 'stopped' : 'running',
    since,
    rebuilt: true,
  })
  // A lost machine that is beating again holds the old copy, and is told to fence it.
  const back = !state.cut
  const copy: Copy = { world: world.id, node: from, epoch: placement.epoch, fenced: true, kept: true }
  return {
    sim: back ? { ...moved, copies: [...moved.copies, copy] } : moved,
    epoch,
    line: {
      who: world.name,
      kind: 'placement.rehomed',
      pairs: [
        ['node', NODE_NAME[elsewhere.to]],
        ['epoch', epoch],
        ['fromNode', NODE_NAME[from]],
        ['fromEpoch', placement.epoch],
        ['why', 'recover'],
      ],
    },
  }
}

/** A displaced world's owner tries again, once there may be room. */
function retry(state: State, sim: Sim, world: World, placement: Placement): Op {
  const there = NODE_NAME[otherOf(placement.node)]
  const made = rebuild(state, sim, world, placement, state.clock + 1)
  if (typeof made === 'string')
    return {
      where: 'worlds',
      steps: [{ sim, tell: `${there} still has no room to run ${world.name}, so it waits.` }],
      lines: [],
      notes: [
        { label: 'On the operation’s record', mono: `The fleet runtime has no room: ${made}` },
        { label: 'What its owner reads', quote: NO_ROOM },
      ],
    }
  return {
    where: 'worlds',
    steps: [
      {
        sim: made.sim,
        tell: `${world.name} is rebuilt on ${there} from its last uploaded backup, under epoch ${made.epoch}. What was played after that backup is not in it.`,
      },
    ],
    lines: [{ ...made.line, at: 0 }],
    notes: [],
  }
}

function press(state: State, id: string): Op | null {
  const world = WORLDS.find((candidate) => candidate.id === id)
  const sim = tidy(simOf(state))
  const placement = world ? sim.placements[world.id] : undefined
  if (!world || !placement) return null
  if (placement.displaced) return retry(state, sim, world, placement)
  // A machine that isn't answering can't be asked to start or stop anything.
  if (placement.node === CABLED && state.cut) return null
  if (placement.power !== 'stopped') return sleep(sim, world, placement)
  return wake(state, sim, world, placement)
}

/**
 * An operator declares the cabled machine lost: `confirmLost` (registry.ts), then the
 * application's rebuild of each of its worlds where there is room (docs/fleet-operations.md).
 */
function lose(state: State): Op | null {
  const before = tidy(simOf(state))
  if (!state.cut || before.lost) return null
  const name = NODE_NAME[CABLED]
  const there = NODE_NAME[otherOf(CABLED)]
  // A machine heard from this recently is refused (409 node_is_beating, registry.ts).
  if (healthOf(state, CABLED) === 'healthy')
    return {
      where: 'cable',
      steps: [
        {
          sim: before,
          tell: `Refused. ${name} was heard from ${state.silent} seconds ago, which is too recently to call it lost.`,
        },
      ],
      lines: [],
      notes: [{ label: 'The answer', mono: `the node beat ${state.silent} s ago; drain it instead` }],
    }

  const mine = WORLDS.filter((world) => before.placements[world.id]?.node === CABLED)
  let sim: Sim = { ...before, lost: true }
  for (const world of mine) sim = alter(sim, world.id, { displaced: true })
  const steps: Step[] = [
    {
      sim,
      tell:
        mine.length === 0
          ? `An operator has said ${name} is stopped, and how. No world was placed on it, so nothing is displaced.`
          : `An operator has said ${name} is stopped, and how. Its ${worlds(mine.length)} ${mine.length === 1 ? 'is' : 'are'} displaced, and the ledger holds no memory for ${mine.length === 1 ? 'it' : 'them'}.`,
    },
  ]
  const lines: Line[] = [
    {
      at: 0,
      kind: 'node.lost',
      pairs: [
        ['node', name],
        ['fencedBy', FENCED_BY],
        ['reason', LOST_REASON],
      ],
    },
  ]
  if (mine.length === 0) return { where: 'cable', steps, lines, notes: [] }
  lines.push({ at: 0, who: worlds(mine.length), kind: 'placement.displaced', pairs: [['node', name]] })

  let done = 0
  for (const world of mine) {
    const placement = sim.placements[world.id]
    if (!placement) continue
    const made = rebuild(state, sim, world, placement, state.clock + 1 + done)
    if (typeof made === 'string') continue
    sim = made.sim
    done += 1
    lines.push({ ...made.line, at: steps.length })
    steps.push({
      sim,
      tell: `${world.name} is rebuilt on ${there} from its last uploaded backup, under epoch ${made.epoch}.`,
    })
  }
  const waiting = mine.length - done
  const head =
    done === 0
      ? `None of ${name}’s ${worlds(mine.length)} could be rebuilt: ${there} has no room to run another now.`
      : waiting === 0
        ? `Every world ${name} held is rebuilt on ${there}, each from its last uploaded backup.`
        : `${done} of ${name}’s ${worlds(mine.length)} ${done === 1 ? 'is' : 'are'} rebuilt on ${there}, each from its last uploaded backup.`
  const gone = done > 0 ? ` Whatever was played after a world’s backup exists only on ${name}.` : ''
  const rest =
    waiting > 0 && done > 0
      ? ` The other ${waiting === 1 ? 'one waits' : `${waiting} wait`}: ${there} has no room to run ${waiting === 1 ? 'it' : 'them'} now.`
      : ''
  const next = waiting > 0 ? ` Put a world to sleep on ${there}, then press one that waits.` : ''
  steps.push({ sim, tell: `${head}${gone}${rest}${next}` })
  return {
    where: 'cable',
    steps,
    lines,
    notes:
      waiting > 0 ? [{ label: 'What starting a displaced world is answered with', mono: HOST_LOST }] : [],
  }
}

/** The cabled machine is heard from again. */
function plug(state: State): Op | null {
  if (!state.cut) return null
  const before = tidy(simOf(state))
  const name = NODE_NAME[CABLED]
  const there = NODE_NAME[otherOf(CABLED)]
  const was = healthOf(state, CABLED)
  const missed = state.silent >= HEARTBEAT_SECONDS
  const health: Line[] =
    was === 'healthy'
      ? []
      : [
          {
            at: 0,
            kind: 'node.health',
            pairs: [
              ['node', name],
              ['from', was],
              ['to', 'healthy'],
            ],
          },
        ]
  if (!before.lost)
    return {
      where: 'cable',
      steps: [
        {
          sim: before,
          tell: `${name} beats again, with the same certificate as before. Its first beat carried everything it holds, and nothing had moved, so there is nothing to undo.`,
        },
      ],
      lines: health,
      notes: missed ? [{ label: `blocklyd’s journal on ${name}`, mono: JOURNAL_BACK }] : [],
    }

  // Back while lost: its lease is zero, and the copies of worlds rebuilt elsewhere are fenced and
  // reported as forks (registry.ts; docs/fleet-operations.md). A
  // world not rebuilt yet has two ways out: room on another machine, or the machine reinstated
  // (docs/fleet-operations.md; registry.ts).
  const forked = WORLDS.filter((world) => before.placements[world.id]?.rebuilt)
  const waiting = WORLDS.filter((world) => before.placements[world.id]?.displaced)
  const copies: Copy[] = forked.map((world) => ({
    world: world.id,
    node: CABLED,
    epoch: (before.placements[world.id]?.epoch ?? 2) - 1,
    fenced: true,
    kept: true,
  }))
  const lines: Line[] = [
    ...health,
    {
      at: 0,
      kind: 'node.returned_while_lost',
      pairs: [
        ['node', name],
        ['fencedBy', FENCED_BY],
      ],
    },
  ]
  if (forked.length > 0)
    lines.push({ at: 0, who: worlds(forked.length), kind: 'fork.detected', pairs: [['node', name]] })
  const kept =
    forked.length === 0
      ? ''
      : ` Its ${forked.length === 1 ? 'copy of the world' : `copies of the ${forked.length} worlds`} rebuilt elsewhere ${forked.length === 1 ? 'is' : 'are'} fenced: stopped, kept, and never started again. ${forked.length === 1 ? 'It is' : 'Each is'} reported as a fork, for its owner to decide about.`
  const held =
    waiting.length === 0
      ? ''
      : ` The ${worlds(waiting.length)} not rebuilt ${waiting.length === 1 ? 'stays' : 'stay'} displaced: ${waiting.length === 1 ? 'it is' : 'each is'} rebuilt on ${there} once there is room, or placed on ${name} again if an operator reinstates the machine.`
  return {
    where: 'cable',
    steps: [
      {
        sim: { ...before, copies },
        tell: `${name} is back, and still lost in the ledger: its lease is zero, so it starts nothing by itself.${kept}${held}`,
      },
    ],
    lines,
    notes: [
      // The heartbeat's answer, cubepals/blocklyd docs/protocol.md.
      { label: 'In the answer to its first beat', mono: '"lifecycle": "lost", "leaseSeconds": 0' },
      ...(forked.length > 0 ? [{ label: `blocklyd’s journal on ${name}`, mono: JOURNAL_FENCED }] : []),
    ],
  }
}

/** A change of health, as upkeep records it (`node.health`, registry.ts). */
const turned = (from: Health, to: Health): Line => ({
  at: 0,
  kind: 'node.health',
  pairs: [
    ['node', NODE_NAME[CABLED]],
    ['from', from],
    ['to', to],
  ],
})

const SAID = {
  suspect: `${NODE_NAME[CABLED]} has been silent for ${SUSPECT_SECONDS} seconds and reads suspect. Nothing has moved.`,
  unavailable: `${NODE_NAME[CABLED]} has been silent for ${UNAVAILABLE_SECONDS} seconds and reads unavailable. Its worlds read unknown. Nothing has moved.`,
  lapsed: `${NODE_NAME[CABLED]} has been silent for ${LEASE_SECONDS} seconds. Its execution lease has run out, and nothing has moved.`,
}

/** Nothing was asked for and nothing was answered: only what upkeep wrote about the silence. */
const quiet = (sim: Sim, lines: readonly Line[]): Op => ({
  where: 'cable',
  steps: [{ sim, tell: '' }],
  lines,
  notes: [],
})

/** With less motion asked for, an operation lands whole and a cut cable has already gone quiet. */
function settle(state: State, still: boolean): State {
  const landed = { ...state, shown: state.op.steps.length }
  return still && state.cut ? { ...landed, silent: LEASE_SECONDS } : landed
}

function run(state: State, op: Op | null, still: boolean): State {
  if (op === null) return state
  return {
    ...state,
    op,
    shown: still ? op.steps.length : 1,
    clock: state.clock + WORLDS.length + 1,
    said: op.steps[op.steps.length - 1]?.tell ?? '',
  }
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'step':
      return state.shown < state.op.steps.length ? { ...state, shown: state.shown + 1 } : state
    case 'beat': {
      // One heartbeat that wasn't answered.
      if (!state.cut || state.silent >= LEASE_SECONDS) return state
      const silent = Math.min(LEASE_SECONDS, state.silent + HEARTBEAT_SECONDS)
      const next = { ...state, silent }
      const written = (line: Line) => ({ ...state.op, lines: [...state.op.lines, line] })
      // Whatever the cable's buttons were answered while it still read healthy has had its day.
      if (silent === SUSPECT_SECONDS)
        return {
          ...next,
          op: quiet(tidy(simOf(state)), [turned('healthy', 'suspect')]),
          shown: 1,
          said: SAID.suspect,
        }
      // Declared lost, its worlds have been displaced and rebuilt: upkeep still records the machine's
      // health (`recordHealth` leaves out only a retired one, registry.ts), but the
      // sentences about a silence in which nothing has moved are no longer true, so the last thing
      // said stays said.
      const lost = simOf(state).lost
      if (silent === UNAVAILABLE_SECONDS)
        return {
          ...next,
          op: written(turned('suspect', 'unavailable')),
          said: lost ? state.said : SAID.unavailable,
        }
      return silent === LEASE_SECONDS && !lost ? { ...next, said: SAID.lapsed } : next
    }
    case 'press': {
      const settled = settle(state, action.still)
      return run(settled, press(settled, action.world), action.still)
    }
    case 'cut': {
      const settled = settle(state, action.still)
      const sim = tidy(simOf(settled))
      if (settled.cut || sim.lost) return state
      return {
        ...settled,
        op: quiet(sim, action.still ? [turned('healthy', 'suspect'), turned('suspect', 'unavailable')] : []),
        shown: 1,
        cut: true,
        silent: action.still ? LEASE_SECONDS : 0,
        said: action.still
          ? `The cable to ${NODE_NAME[CABLED]} is cut. ${SAID.lapsed} It read suspect after ${SUSPECT_SECONDS} seconds and unavailable after ${UNAVAILABLE_SECONDS}, and its worlds read unknown.`
          : `The cable to ${NODE_NAME[CABLED]} is cut.`,
      }
    }
    case 'plug': {
      const settled = settle(state, action.still)
      const op = plug(settled)
      return op === null ? state : { ...run(settled, op, action.still), cut: false, silent: 0 }
    }
    case 'lose': {
      const settled = settle(state, action.still)
      return run(settled, lose(settled), action.still)
    }
    case 'reset':
      return START
  }
}

// ─── The tour ────────────────────────────────────────────────────────────────────────────────

/**
 * The order the tour wakes worlds in. From the start it tells the whole of it in seven wakes:
 * three fill fra-box-1 to 15 of its 16 GB, the fourth has to move, two more fill fra-box-2 as far,
 * and the seventh has nowhere to go. The last two are only reached from a fleet a person left.
 */
const TOUR_ORDER: readonly World[] = [
  'copper-bay',
  'mossy-den',
  'old-mill',
  'fox-hill',
  'salt-flats',
  'birch-row',
  'pine-ridge',
  'stone-gate',
  'tall-grass',
].flatMap((id) => WORLDS.filter((world) => world.id === id))

/**
 * How long the tour leaves each thing on show, in seconds: every beat of it at STEP_MS, then time
 * to look at where it ended. A move walks four steps, and a refusal leaves two notes to read.
 */
const TOUR_HOLDS = { woke: 4, moved: 7.5, refused: 7, slept: 4.5 } as const
/** The start, where every world is asleep and there is nothing to read yet. */
const TOUR_HOLDS_START = 3
/** Whatever was done with the cable is a person's, and is left the longest a bar may run. */
const TOUR_HOLDS_CABLE = 10

/** The cable was cut or its machine declared lost, which only a person does. */
const cableUsed = (state: State): boolean => state.cut || simOf(state).lost

function tourHold(state: State): number {
  if (cableUsed(state) || state.op.where === 'cable') return TOUR_HOLDS_CABLE
  return state.op.came === undefined ? TOUR_HOLDS_START : TOUR_HOLDS[state.op.came]
}

/**
 * What the tour does next, and the few words that say so on its bar. It is read off the fleet as
 * it stands and never off what the tour did last, so it is right wherever a person left things:
 * every action here is one the reducer takes from any state, and the label is worked out with the
 * same rules the press will run, so the bar never promises what doesn't come.
 */
function tourMove(state: State): { label: string; action: Action } {
  const over = { label: 'All asleep again', action: { type: 'reset' } as const }
  const sim = tidy(simOf(state))
  // The tour doesn't play the cable. A fleet with one cut, or a machine lost, goes back to the start.
  if (cableUsed(state)) return over
  // A world went back to sleep and gave its memory back: that is the end of the story.
  if (state.op.came === 'slept') return over

  if (state.op.came === 'refused') {
    // "Put a world to sleep and try again": the biggest one running, and of two as big, the one
    // that comes first in the tour's order.
    const running = TOUR_ORDER.filter((world) => sim.placements[world.id]?.power === 'running')
    const biggest = running.find(
      (world) => world.memoryMb === Math.max(...running.map((other) => other.memoryMb)),
    )
    return biggest
      ? { label: `${biggest.name} sleeps`, action: { type: 'press', world: biggest.id, still: false } }
      : over
  }

  const next = TOUR_ORDER.find((world) => sim.placements[world.id]?.power === 'stopped')
  const placement = next ? sim.placements[next.id] : undefined
  if (!next || !placement) return over
  const fits = startRefusal(sim, placement.node, next.memoryMb) === null
  const moves = !fits && considered(state, sim, placement.node, next.memoryMb).to !== null
  return {
    label: `${next.name} ${fits ? 'wakes' : moves ? 'moves' : 'is refused'}`,
    action: { type: 'press', world: next.id, still: false },
  }
}

// ─── The drawing ─────────────────────────────────────────────────────────────────────────────

/** A machine's memory, a row of blocks to the GB, bottom row first. */
const GB_ROWS = Array.from({ length: ALLOCATABLE_MB / 1024 }, (_, row) => row)
/** The blocks in a row. */
const BLOCKS = [0, 1, 2, 3] as const
/** The heartbeats from a cut cable to the lease running out, by the second each was due. */
const BEATS = Array.from(
  { length: LEASE_SECONDS / HEARTBEAT_SECONDS },
  (_, beat) => (beat + 1) * HEARTBEAT_SECONDS,
)

/** A beat of an operation's walk, slow enough to read a line; and of the silence, a heartbeat a beat. */
const STEP_MS = 800
const BEAT_MS = 300
/** The room's lamps with every world asleep: low, not out. */
const LAMPS_LOW = 0.2

/**
 * What a world reads: a displaced placement (fleet-runtime.ts), or the state the application
 * observes (apps/control/src/app/ports/runtime.ts), which is `unknown` on a machine that is
 * unavailable (fleet-runtime.ts).
 */
function wordOf(placement: Placement, unknown: boolean): 'displaced' | 'unknown' | 'running' | 'stopped' {
  if (placement.displaced) return 'displaced'
  if (unknown) return 'unknown'
  return placement.power === 'running' ? 'running' : 'stopped'
}

function Machine({
  node,
  sim,
  health,
  silent,
  waiting,
  onPress,
}: {
  node: NodeId
  sim: Sim
  health: Health
  /** Its cable is cut: nothing on it can be asked to start or stop. */
  silent: boolean
  /** A person's own press is still landing, so their next would be too soon. */
  waiting: boolean
  onPress: (world: string) => void
}) {
  const name = NODE_NAME[node]
  const lost = node === CABLED && sim.lost
  const unknown = silent && !lost && health === 'unavailable'
  const here = WORLDS.flatMap((world) => {
    const placement = sim.placements[world.id]
    return placement && placement.node === node ? [{ world, placement }] : []
  })
  // The worlds that hold memory, standing in the column in the order they woke.
  const stood: { world: World; state: 'claimed' | 'running' | 'unknown'; gb: number; from: number }[] = []
  let used = 0
  for (const { world, placement } of here
    .filter((entry) => !entry.placement.displaced && entry.placement.power !== 'stopped')
    .sort((one, two) => one.placement.since - two.placement.since)) {
    const gb = world.memoryMb / 1024
    stood.push({
      world,
      state: unknown ? 'unknown' : placement.power === 'running' ? 'running' : 'claimed',
      gb,
      from: used,
    })
    used += gb
  }
  const copies = sim.copies.filter((copy) => copy.node === node)

  return (
    <section
      className={`bl-frame bl-frame--bare ${styles.machine}`}
      data-lost={lost || undefined}
      aria-label={`The machine ${name}`}
    >
      <div className={styles.mhead}>
        <p className={`bl-mono ${styles.mname}`}>{name}</p>
        {/* A node's lifecycle and its health, as `bun scripts/fleet.ts nodes` lists them (scripts/fleet.ts). */}
        <p className={`bl-mono ${styles.mstate}`}>
          <span data-alarm={lost || undefined}>{lost ? 'lost' : 'active'}</span>
          <span data-alarm={health !== 'healthy' || undefined}>{health}</span>
        </p>
      </div>

      <div className={styles.zone}>
        <p className={styles.zname}>Running, in memory</p>
        <p className={`bl-mono bl-num ${styles.zvalue}`}>
          {heldMb(sim, node)}/{ALLOCATABLE_MB} MB
        </p>
      </div>
      <div className={styles.memory} aria-hidden>
        {GB_ROWS.map((row) => (
          <span key={row} className={`${styles.gb} ${styles.slot}`} style={{ gridRow: GB_ROWS.length - row }}>
            {BLOCKS.map((block) => (
              <i key={block} />
            ))}
          </span>
        ))}
        {stood.map(({ world, state, gb, from }) => (
          <Fragment key={world.id}>
            {GB_ROWS.slice(0, gb).map((row) => (
              <span
                key={row}
                className={`${styles.gb} ${styles.lit}`}
                data-state={state}
                style={{ gridRow: GB_ROWS.length - from - row, '--i': row } as CSSProperties}
              >
                {BLOCKS.map((block) => (
                  <i key={block}>
                    {state === 'claimed' && <b className={`bl-dither ${styles.dots}`} data-level="3" />}
                  </i>
                ))}
              </span>
            ))}
            <span
              className={styles.label}
              data-state={state}
              style={{ gridRow: `${GB_ROWS.length - from - gb + 1} / span ${gb}` }}
            >
              <span className={styles.lname}>{world.name}</span>
              <span className={`bl-mono bl-num ${styles.lsize}`}>{world.memoryMb} MB</span>
            </span>
          </Fragment>
        ))}
      </div>

      <div className={styles.zone}>
        <p className={styles.zname}>Placed, on disk</p>
        <p className={`bl-mono bl-num ${styles.zvalue}`}>
          {placedMb(sim, node)}/{ALLOCATABLE_MB * MEMORY_OVERCOMMIT} MB
        </p>
      </div>
      <ul className={styles.shelf}>
        {here.map(({ world, placement }) => {
          const word = wordOf(placement, unknown)
          // A machine whose cable is cut can't be asked anything; a displaced world can be tried again.
          const off = silent && !placement.displaced
          const hint = placement.displaced
            ? 'Its machine was declared lost. Press to try rebuilding it on the other machine.'
            : off
              ? 'Its machine is not answering, so it can’t be asked anything.'
              : placement.power === 'stopped'
                ? 'Asleep. Press to wake it.'
                : 'Press to put it to sleep.'
          return (
            <li key={world.id}>
              <button
                type="button"
                className={styles.tile}
                data-world={world.id}
                data-word={word}
                data-off={off || undefined}
                aria-pressed={word === 'running'}
                aria-disabled={off || waiting || undefined}
                onClick={() => {
                  if (!off && !waiting) onPress(world.id)
                }}
              >
                <i className={styles.slab} aria-hidden>
                  {word === 'stopped' && <b className={`bl-dither ${styles.dots}`} data-level="3" />}
                </i>
                <span className={styles.ttext}>
                  <span className={styles.tline}>
                    <span className={styles.tname}>{world.name}</span>
                    <span className={`bl-num ${styles.tsize}`}>{world.memoryMb / 1024} GB</span>
                  </span>
                  <span className={`bl-mono bl-num ${styles.tline} ${styles.tmeta}`}>
                    <span>{word}</span>
                    <span>epoch {placement.epoch}</span>
                  </span>
                  {placement.rebuilt && <span className={styles.tnote}>From its last uploaded backup</span>}
                  <span className={styles.sr}>{hint}</span>
                </span>
              </button>
            </li>
          )
        })}
        {copies.map((copy) => {
          const world = WORLDS.find((candidate) => candidate.id === copy.world)
          return (
            <li key={`copy-${copy.world}`} className={styles.copy}>
              <i className={styles.slab} aria-hidden />
              <span className={styles.ttext}>
                <span className={styles.tline}>
                  <span className={styles.tname}>{world?.name ?? copy.world}</span>
                  {world && <span className={`bl-num ${styles.tsize}`}>{world.memoryMb / 1024} GB</span>}
                </span>
                {/* `fenced` is blocklyd's state for a superseded copy (cubepals/blocklyd docs/protocol.md). */}
                <span className={`bl-mono bl-num ${styles.tline} ${styles.tmeta}`}>
                  <span>{copy.fenced ? 'fenced' : 'stopped'}</span>
                  <span>epoch {copy.epoch}</span>
                </span>
                <span className={styles.tnote}>
                  {copy.kept ? 'The copy it left, kept and never started' : 'The copy it left behind'}
                </span>
              </span>
            </li>
          )
        })}
        {here.length === 0 && copies.length === 0 && (
          <li className={`bl-small ${styles.none}`}>No world is placed here.</li>
        )}
      </ul>
    </section>
  )
}

/** The words an operation leaves beside what it wrote: a record, a journal line, what an owner reads. */
function Notes({ notes }: { notes: readonly Note[] }) {
  if (notes.length === 0) return null
  return (
    <dl className={styles.notes}>
      {notes.map((note) => (
        <div key={note.label}>
          <dt>{note.label}</dt>
          {note.mono !== undefined && <dd className={`bl-mono ${styles.v}`}>{note.mono}</dd>}
          {note.quote !== undefined && <dd className={styles.quote}>“{note.quote}”</dd>}
        </div>
      ))}
    </dl>
  )
}

export function FleetDemo() {
  const root = useRef<HTMLDivElement>(null)
  const inView = useInView(root)
  const still = useReducedMotion()
  const [state, dispatch] = useReducer(reduce, START)

  const { op } = state
  const at = still ? op.steps.length : Math.min(state.shown, op.steps.length)
  const step = op.steps[at - 1]
  const sim = step?.sim ?? START_SIM
  // An operation lands a step at a time; with less motion asked for, whole.
  const busy = at < op.steps.length
  const lines = op.lines.filter((line) => line.at < at)
  const silent = still && state.cut ? LEASE_SECONDS : state.silent
  const health = healthOf({ cut: state.cut, silent }, CABLED)
  const counting = state.cut && state.silent < LEASE_SECONDS && !still
  // Whose operation is landing. A person's own is let finish before their next press. The tour's
  // isn't theirs to wait for: the reducer lands it whole before it runs the press (`settle`).
  const [toured, setToured] = useState(false)
  const landing = busy && !toured
  // Everything a person does goes through here, so what lands next is known to be theirs.
  const act = (action: Action) => {
    setToured(false)
    dispatch(action)
  }
  // Until the ledger has read a cut machine suspect, a world could still be sent to it.
  const waiting = landing || (state.cut && !sim.lost && health === 'healthy')

  // A world that moves to the other machine is a new button there. If the old one held the
  // keyboard, the new one is given it, so focus isn't dropped in the middle of the demonstration.
  // The button is noted before anything that may move it, and only its own going is answered.
  // `scroll`: whether the page may move to show the new one, which it may after a person's own
  // press and never after the tour's.
  const follow = useRef<{ button: HTMLElement; world: string; scroll: boolean } | null>(null)
  const mind = (scroll: boolean) => {
    const held = document.activeElement
    const world = held instanceof HTMLElement ? held.dataset.world : undefined
    follow.current =
      held instanceof HTMLElement && world !== undefined && root.current?.contains(held)
        ? { button: held, world, scroll }
        : null
  }
  useEffect(() => {
    const kept = follow.current
    if (kept === null) return
    if (kept.button.isConnected) {
      // Still where it was. Once the operation has landed, nothing more will move it.
      if (!busy) follow.current = null
      return
    }
    follow.current = null
    const held = document.activeElement
    if (held !== null && held !== document.body) return
    root.current
      ?.querySelector<HTMLButtonElement>(`button[data-world="${kept.world}"]`)
      ?.focus({ preventScroll: !kept.scroll })
  })

  // The tour plays the worlds, so it only moves while the machines can be seen: what it writes
  // changes the height of everything under them, and someone reading down there is left alone.
  const machines = useRef<HTMLDivElement>(null)
  // (Anywhere below the top band counts: when the section first comes to rest the machines sit
  // low on a laptop's screen, and the tour should already be playing them.)
  const machinesSeen = useInView(machines, '-15% 0px 0px 0px')

  // Left alone, it plays itself: one step, which reads the fleet as it stands and does the next
  // thing (`tourMove`). The window after a step is the time what it set going is left on show. It
  // is always read off the fleet, the first one too (the start's is the short one already): a
  // window of its own for the first step would also cut short whatever a person did before it.
  const move = tourMove(state)
  const tour = useTour({
    ref: root,
    steps: [
      () => {
        // An operation still landing is let finish, and machines off screen are left as they
        // are; the next bar takes it from there.
        if (busy || !machinesSeen) return
        mind(false)
        setToured(true)
        dispatch(move.action)
      },
    ],
    seconds: tourHold(state),
  })

  // Simulated time, only while it can be seen.
  useEffect(() => {
    if (!busy || !inView) return
    const timer = setInterval(() => dispatch({ type: 'step' }), STEP_MS)
    return () => clearInterval(timer)
  }, [busy, inView])
  useEffect(() => {
    if (!counting || !inView) return
    const timer = setInterval(() => dispatch({ type: 'beat' }), BEAT_MS)
    return () => clearInterval(timer)
  }, [counting, inView])

  // The room in the chunk: its lamps follow how much of the two machines' memory is awake. A world
  // on a machine that reads unavailable isn't counted, since nobody can say whether it runs.
  const unknown = state.cut && !sim.lost && health === 'unavailable'
  const awake = WORLDS.reduce((sum, world) => {
    const placement = sim.placements[world.id]
    if (!placement || placement.displaced || placement.power !== 'running') return sum
    return unknown && placement.node === CABLED ? sum : sum + world.memoryMb
  }, 0)
  const lamps = LAMPS_LOW + (1 - LAMPS_LOW) * Math.min(1, awake / (ALLOCATABLE_MB * NODES.length))
  useEffect(() => {
    stage.glow('fleet', inView ? lamps : null)
  }, [inView, lamps])
  useEffect(() => () => stage.glow('fleet', null), [])

  // The room's scene plays this same fleet in the game's parts: two machines, a tray in each for
  // every 4 GB held there, a chest at its foot for every tile on its shelf here, thrown open over a
  // world that is awake. So it is told those three things of each machine, as they are drawn here;
  // what the last press came to, with a count of presses, since two alike change nothing else; and
  // how the ledger reads the cable. Out of sight nothing here moves, so the room is left to play
  // by itself.
  const roomOf = (node: NodeId) => {
    const placed = WORLDS.flatMap((world) => {
      const placement = sim.placements[world.id]
      return placement && placement.node === node ? [placement] : []
    })
    return {
      gb: heldMb(sim, node) / 1024,
      awake: placed.filter((placement) => !placement.displaced && placement.power !== 'stopped').length,
      worlds: placed.length + sim.copies.filter((copy) => copy.node === node).length,
    }
  }
  const { gb: aGb, awake: aAwake, worlds: aWorlds } = roomOf('a')
  const { gb: bGb, awake: bAwake, worlds: bWorlds } = roomOf('b')
  const turn = state.clock / (WORLDS.length + 1)
  const came = op.came ?? 'none'
  const cable = sim.lost
    ? state.cut
      ? 'lost'
      : 'back'
    : !state.cut
      ? 'up'
      : health === 'healthy'
        ? 'cut'
        : health
  useEffect(() => {
    stage.show('fleet', inView ? { turn, came, aGb, aAwake, aWorlds, bGb, bAwake, bWorlds, cable } : null)
  }, [inView, turn, came, aGb, aAwake, aWorlds, bGb, bAwake, bWorlds, cable])
  useEffect(() => () => stage.show('fleet', null), [])

  const cabled = NODE_NAME[CABLED]
  const tell = step?.tell ?? ''
  const notes = busy ? [] : op.notes
  // What the operation on show did, in plain words, beside whichever control set it going.
  const told = (where: Op['where']) =>
    op.where === where && (tell !== '' || notes.length > 0) ? (
      <>
        {tell !== '' && <p className={styles.tell}>{tell}</p>}
        <Notes notes={notes} />
      </>
    ) : null
  const reply = told('cable')

  // A button with nothing to do says so and does nothing, but stays in reach of the keyboard. Each
  // of these goes off under its own press, or under the tour: a disabled button would drop the
  // keyboard resting on it.
  const atStart = state === START
  const cableOff = landing || (sim.lost && !state.cut)
  const loseOff = landing || !state.cut || sim.lost

  return (
    <div className={styles.demo} ref={root}>
      <TourBar tour={tour} label={move.label} />
      <div className={styles.top}>
        <p className={`bl-small ${styles.says}`}>
          Two example machines with {WORLDS.length} worlds placed on them. Press a world to wake it, and press
          it again to put it to sleep.
        </p>
        <button
          type="button"
          className="bl-btn bl-btn--sm bl-btn--quiet"
          aria-disabled={atStart || undefined}
          onClick={atStart ? undefined : () => act({ type: 'reset' })}
        >
          Start over
        </button>
      </div>

      <ul className={styles.legend}>
        <li>
          <i className={styles.sw} data-kind="asleep" aria-hidden>
            <b className={`bl-dither ${styles.dots}`} data-level="3" />
          </i>
          Asleep: its disk, and nothing else
        </li>
        <li>
          <i className={styles.sw} data-kind="claimed" aria-hidden>
            <b className={`bl-dither ${styles.dots}`} data-level="3" />
          </i>
          Claimed in the ledger
        </li>
        <li>
          <i className={styles.sw} data-kind="running" aria-hidden />
          Running: a row of blocks is 1 GB
        </li>
        <li>
          <i className={styles.sw} data-kind="unknown" aria-hidden />
          Unknown: its machine isn’t answering
        </li>
      </ul>

      <div className={styles.machines} ref={machines}>
        {NODES.map((node) => (
          <Machine
            key={node}
            node={node}
            sim={sim}
            health={node === CABLED ? health : 'healthy'}
            silent={node === CABLED && state.cut}
            waiting={waiting}
            onPress={(world) => {
              mind(true)
              act({ type: 'press', world, still })
            }}
          />
        ))}
      </div>

      {/* docs/fleet.md; load.ts */}
      <p className={`bl-small ${styles.says}`}>
        Placed counts the memory each world needs awake. On one machine it may add up to that machine’s memory
        × <span className={`bl-mono ${styles.v}`}>FLEET_MEMORY_OVERCOMMIT</span>, which is {MEMORY_OVERCOMMIT}{' '}
        unless it is set otherwise. What is running has to fit in the memory itself.
      </p>

      <div className={styles.told}>{told('worlds')}</div>

      <section className={`bl-frame bl-frame--bare ${styles.ledger}`} aria-label="The ledger">
        <p className={styles.lhead}>
          <span className={styles.name}>The ledger</span>
          {/* docs/fleet.md */}
          <span className="bl-small">
            One database. Its rows say where each world is placed and what it holds; its events say what was
            decided. What the last thing to happen wrote there:
          </span>
        </p>
        {lines.length === 0 ? (
          <p className={`bl-small ${styles.says}`}>
            {state === START ? 'Nothing yet.' : busy ? '' : 'Nothing was written.'}
          </p>
        ) : (
          <ol className={styles.lines}>
            {lines.map((line) => (
              <li
                key={`${line.kind} ${line.who ?? ''} ${line.pairs.map(([, value]) => value).join(' ')}`}
                className={styles.line}
              >
                {line.who !== undefined && <span className={styles.who}>{line.who}</span>}
                <span className={`bl-mono ${styles.kind}`}>{line.kind}</span>
                {line.pairs.map(([key, value]) => (
                  <span key={key} className={`bl-mono bl-num ${styles.pair}`}>
                    <span className={styles.key}>{key}</span> {value}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.cable} aria-label={`The cable to ${cabled}`}>
        <div className={styles.chead}>
          <p className={styles.name}>The cable to {cabled}</p>
          <div className={styles.cbuttons}>
            <button
              type="button"
              className="bl-btn bl-btn--sm"
              aria-disabled={cableOff || undefined}
              onClick={cableOff ? undefined : () => act({ type: state.cut ? 'plug' : 'cut', still })}
            >
              {state.cut ? 'Plug it back in' : 'Cut the cable'}
            </button>
            <button
              type="button"
              className="bl-btn bl-btn--sm bl-btn--quiet"
              aria-disabled={loseOff || undefined}
              onClick={loseOff ? undefined : () => act({ type: 'lose', still })}
            >
              Declare it lost
            </button>
          </div>
        </div>

        <p className={`bl-small ${styles.says}`}>
          {state.cut ? (
            <>
              Silent for <span className={`bl-mono bl-num ${styles.v}`}>{silent} s</span>
              {silent >= LEASE_SECONDS && ' or more'}. Each filled block is a heartbeat that didn’t arrive.
            </>
          ) : (
            <>
              {cabled} sends the ledger a heartbeat every {HEARTBEAT_SECONDS} seconds. Cut its cable and see
              what the ledger does by itself.
            </>
          )}
        </p>

        <div className={styles.beats} aria-hidden>
          {BEATS.map((due) =>
            state.cut && silent >= due ? (
              <i key={due} className={`${styles.beat} ${styles.missed}`} />
            ) : (
              <i key={due} className={`bl-dither ${styles.beat}`} data-level="3" />
            ),
          )}
          <span className={`bl-mono bl-num ${styles.due}`} data-at="suspect">
            {SUSPECT_SECONDS} s
          </span>
          <span className={`bl-mono bl-num ${styles.due}`} data-at="unavailable">
            {UNAVAILABLE_SECONDS} s
          </span>
          <span className={`bl-mono bl-num ${styles.due}`} data-at="lease">
            {LEASE_SECONDS} s
          </span>
        </div>

        {/* docs/fleet.md; docs/fleet-operations.md */}
        <ol className={styles.marks}>
          <li data-on={(state.cut && silent >= SUSPECT_SECONDS) || undefined}>
            <span className="bl-mono bl-num">{SUSPECT_SECONDS} s</span>
            <span>
              It reads <span className="bl-mono">suspect</span>. No new world is placed there, and its last
              report is kept, so its worlds read as they did.
            </span>
          </li>
          <li data-on={(state.cut && silent >= UNAVAILABLE_SECONDS) || undefined}>
            <span className="bl-mono bl-num">{UNAVAILABLE_SECONDS} s</span>
            <span>
              It reads <span className="bl-mono">unavailable</span>, and its worlds read{' '}
              <span className="bl-mono">unknown</span>. Nothing is moved and nothing is rebuilt.
            </span>
          </li>
          <li data-on={(state.cut && silent >= LEASE_SECONDS) || undefined}>
            <span className="bl-mono bl-num">{LEASE_SECONDS} s</span>
            <span>
              The machine’s execution lease runs out. From here blocklyd restarts nothing by itself, and it
              stops nothing either: a world that was running still is, if the machine is.
            </span>
          </li>
        </ol>

        {state.cut && silent >= HEARTBEAT_SECONDS && !sim.lost && (
          <Notes notes={[{ label: `blocklyd’s journal on ${cabled}`, mono: JOURNAL_SILENT }]} />
        )}

        {reply !== null && <div>{reply}</div>}

        {/* docs/fleet-operations.md; scripts/fleet.ts (the command takes a node's id, not
            its name); apps/control/src/app/operations/schedules.ts */}
        <p className={`bl-small ${styles.says}`}>
          The ledger can’t tell a cut cable from a dead machine, so it never decides which. “Declare it lost”
          stands for an operator who has made sure the machine is stopped, and says how:{' '}
          <span className={`bl-mono ${styles.v}`}>
            bun scripts/fleet.ts lost &lt;node&gt; --fenced-by "{FENCED_BY}" --reason "{LOST_REASON}"
          </span>
          . The application waits {HOST_LOSS_GRACE_MINUTES} minutes, in case the machine comes back, then
          rebuilds each of its worlds from its last uploaded backup, on another machine that has room.
        </p>
      </section>

      {/* While the tour is what is changing things, a screen reader isn't read every change. */}
      <p className={styles.sr} aria-live={tour.auto ? 'off' : 'polite'}>
        {busy ? '' : state.said}
      </p>
    </div>
  )
}
