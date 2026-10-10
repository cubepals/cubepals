// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The runtimes stratum's demonstration: the rule ladder.
 *
 * New servers arrive at the top and drop through the placement rules in the order the rules were
 * made. Each rung prints what the policy records about that server, in the policy's own words, and
 * the first rule that matches sends it down a track to one of three runtimes. Under the ladder is
 * the row the control plane keeps for it, with every runtime it looked at.
 *
 * The policy is a port of `decidePlacement` (apps/control/src/app/runtimes/placement.ts): the
 * same checks in the same order, the same outcomes, the same sentences. None of it has run in
 * production yet.
 * Two things differ here, and the note under the demonstration says both: the two clouds' provider
 * ids are replaced by `cloud-a` and `cloud-b`, since the page names no other company, and whether
 * a runtime has room is reduced to whether it places the server's region, which is what the
 * example's region maps decide. So only the default, which has a switch for it, is ever full.
 *
 * Nobody arriving knows the buttons are there to press, so left alone it presses them itself
 * (`turns`): three servers walk the ladder one at a time, a dozen follow, the canary's share
 * widens and a dozen more show what that changes and what it doesn't, the default fills and the
 * next dozen that no rule takes overflow, and back to the start. A person's press takes it over;
 * the tour carries on from wherever they left it.
 */
import { type ReactNode, useEffect, useId, useReducer, useRef } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './runtimes.module.css'

// ─── The example deployment ──────────────────────────────────────────────────────────────────

type Provider = 'cloud-a' | 'cloud-b' | 'fleet'

/**
 * Every runtime the example runs, in the order it lists them, which is the order a full default
 * overflows in. The documented three-runtime deployment (docs/runtimes.md), with its two
 * clouds' ids replaced; `fleet` is the real id of Blockly's own machines.
 */
const PROVIDERS: readonly Provider[] = ['cloud-a', 'cloud-b', 'fleet']
/** Where every new server goes that no rule sends elsewhere: RUNTIME_PROVIDER. docs/runtimes.md */
const DEFAULT: Provider = 'cloud-a'
/**
 * The product regions each runtime places, from the same example's region maps: the default must
 * place every region, the others only some (docs/runtimes.md). A runtime says it
 * has no room for a region it does not place (apps/control/src/app/ports/runtime.ts).
 */
const PLACES: Record<Provider, readonly string[]> = {
  'cloud-a': ['eu', 'us'],
  'cloud-b': ['eu'],
  fleet: ['eu'],
}

/** What each track's end is, in plain words. */
const ENDS: Record<Provider, { title: string; kind: string | null }> = {
  'cloud-a': { title: 'A cloud, by the second', kind: 'The default.' },
  'cloud-b': { title: 'A second cloud, by the second', kind: null },
  fleet: { title: 'Cubepals’ own machines', kind: 'Rented by the month.' },
}

/** A rule as placement reads it. apps/control/src/app/runtimes/placement.ts */
interface Rule {
  id: string
  provider: Provider
  enabled: boolean
  /** The share of matching new servers it sends, 0 to 100. */
  percent: number
  /** Empty lists match everything. */
  accounts: readonly string[]
  regions: readonly string[]
  plans: readonly string[]
  note: string
}

/** The owners the first rule names. The ids are examples. */
const ACCOUNTS: readonly string[] = [
  '6f1d2c0e-83a4-4b7e-9d15-0c2e7a94b3f1',
  'a40b9e77-1c5d-4f20-8e3a-5d61f0c2b9e4',
  '0e7c5a31-f9b2-4d68-b0a7-93e1d4c6f258',
  'c82f64d9-07e1-4a3c-a5b8-2f9d0e7c1a63',
  '39d0b1f6-e4c7-4852-9f6e-b7a3c50d8e12',
]

/**
 * Two rules, in the order they were made, which is the order they are read in
 * (apps/control/src/app/runtimes/persistence.ts). The first is the allowlist the
 * placement test uses, note and all (placement.test.ts); the second is the canary rule as
 * documented, `rule add fleet --percent 5 --plan plus --region eu --note "canary"`
 * (docs/runtimes.md). Their ids are examples.
 */
const ALLOW: Rule = {
  id: '1c9e42d7-5b0a-4f3e-9c61-2a7d8e0b4f15',
  provider: 'fleet',
  enabled: true,
  percent: 100,
  accounts: ACCOUNTS,
  regions: [],
  plans: [],
  note: 'the five canary owners',
}
const CANARY: Rule = {
  id: 'b3f1a2c4-7d58-4e09-a6c2-91e0f3b7d5a8',
  provider: 'fleet',
  enabled: true,
  percent: 5,
  accounts: [],
  regions: ['eu'],
  plans: ['plus'],
  note: 'canary',
}

// ─── The bucket: a server's place in a rule's rollout ────────────────────────────────────────

/** SHA-256's round constants. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * The first four bytes of the SHA-256 of an ASCII string, as one unsigned number: what
 * `digest.readUInt32BE(0)` reads in the control plane. Written out here because the browser's own
 * SHA-256 only answers later, and a rung prints its verdict at once. Checked against Node's on
 * twenty thousand pairs of ids before it was put here.
 */
function sha256Head(text: string): number {
  const size = (((text.length + 8) >> 6) + 1) * 64
  const view = new DataView(new ArrayBuffer(size))
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i))
  view.setUint8(text.length, 0x80)
  view.setUint32(size - 4, text.length * 8)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new DataView(new ArrayBuffer(256))
  for (let block = 0; block < size; block += 64) {
    for (let t = 0; t < 16; t++) w.setUint32(t * 4, view.getUint32(block + t * 4))
    for (let t = 16; t < 64; t++) {
      const x = w.getUint32((t - 15) * 4)
      const y = w.getUint32((t - 2) * 4)
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w.setUint32(t * 4, (w.getUint32((t - 16) * 4) + s0 + w.getUint32((t - 7) * 4) + s1) >>> 0)
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, j = 0] = h
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const t1 = (j + s1 + ((e & f) ^ (~e & g)) + (K[t] ?? 0) + w.getUint32(t * 4)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      j = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, j]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0
  }
  return h[0] ?? 0
}

/**
 * A server's place in a rule's rollout, in [0, 100): the same server always gets the same number
 * under the same rule, so a share grows by adding servers, never by moving the ones already in.
 * The product's own sum: SHA-256 of `ruleId:serverId`, its first four bytes, mod 10,000, over 100
 * (apps/control/src/app/runtimes/placement.ts).
 */
function rolloutBucket(ruleId: string, serverId: string): number {
  return (sha256Head(`${ruleId}:${serverId}`) % 10_000) / 100
}

// ─── The servers that arrive ─────────────────────────────────────────────────────────────────

/** What placement is told about a new server. apps/control/src/app/runtimes/placement.ts */
interface Server {
  serverId: string
  ownerId: string
  plan: 'free' | 'plus'
  regionKey: 'eu' | 'us'
  memoryMb: number
}

/** The example ends here; starting over sends the same servers again. */
const MOST = 48
/** How many one press of the second button sends. */
const BATCH = 12
/** Picked so the first few servers between them meet every verdict a rung can print. */
const SEED = 2128

/** A small seeded generator (mulberry32), so the same servers arrive in the same order every time. */
function random(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEX = '0123456789abcdef'

/** An id shaped like the ones the database makes. */
function uuid(next: () => number): string {
  let out = ''
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += '-'
    if (i === 12) out += '4'
    else if (i === 16) out += HEX.charAt(8 + Math.floor(next() * 4))
    else out += HEX.charAt(Math.floor(next() * 16))
  }
  return out
}

/**
 * The sizes sold (apps/control/src/domain/server/size.ts). Free is the smallest only
 * (apps/control/src/domain/account/entitlements.ts).
 */
const SIZES_MB = [3072, 4096, 8192] as const

/** The first six are chosen, one for each way through the ladder; the rest are drawn. */
const OPENING: readonly (Pick<Server, 'plan' | 'regionKey' | 'memoryMb'> & { named: boolean })[] = [
  { plan: 'plus', regionKey: 'eu', memoryMb: 3072, named: false },
  { plan: 'free', regionKey: 'eu', memoryMb: 3072, named: false },
  { plan: 'plus', regionKey: 'eu', memoryMb: 4096, named: true },
  { plan: 'plus', regionKey: 'us', memoryMb: 3072, named: false },
  { plan: 'plus', regionKey: 'eu', memoryMb: 8192, named: false },
  { plan: 'free', regionKey: 'us', memoryMb: 3072, named: true },
]

/** The server that arrives at this place in the queue. An example: nobody's real server. */
function serverAt(index: number): Server {
  const next = random(SEED + index * 7919)
  const serverId = uuid(next)
  const set = OPENING[index]
  const named = set ? set.named : next() < 0.08
  const plan = set ? set.plan : next() < 0.6 ? 'plus' : 'free'
  const regionKey = set ? set.regionKey : next() < 0.8 ? 'eu' : 'us'
  const size = set || plan === 'free' ? 0 : Math.floor(next() * SIZES_MB.length)
  const memoryMb = set ? set.memoryMb : (SIZES_MB[size] ?? SIZES_MB[0])
  const ownerId = named ? (ACCOUNTS[index % ACCOUNTS.length] ?? uuid(next)) : uuid(next)
  return { serverId, ownerId, plan, regionKey, memoryMb }
}

// ─── The policy ──────────────────────────────────────────────────────────────────────────────

/** packages/db/src/json.ts. `not_run` and `disabled` never happen in this example. */
type Outcome = 'chosen' | 'not_matched' | 'not_in_rollout' | 'no_room'

/** One runtime a placement looked at: whether it was chosen, and why. */
interface Considered {
  provider: Provider
  ruleId: string | null
  outcome: Outcome
  detail: string
}

interface Decision {
  provider: Provider
  ruleId: string | null
  reason: string
  considered: Considered[]
}

const listed = (list: readonly string[], value: string) => list.length === 0 || list.includes(value)

/**
 * Which runtime a new server goes to: `decidePlacement`, line for line
 * (apps/control/src/app/runtimes/placement.ts), without the check for a runtime the
 * deployment doesn't run, since both rules name one it does. Every sentence is the code's.
 */
function decide(server: Server, rules: readonly Rule[], defaultFull: boolean): Decision {
  const considered: Considered[] = []
  // Only the default has a provider that caps the servers it holds; the switch fills it.
  const atLimit = (provider: Provider) => provider === DEFAULT && defaultFull
  const hasRoom = (provider: Provider) => PLACES[provider].includes(server.regionKey)
  for (const rule of rules) {
    if (!rule.enabled) continue
    const seen = (outcome: Outcome, detail: string) =>
      considered.push({ provider: rule.provider, ruleId: rule.id, outcome, detail })
    if (!listed(rule.accounts, server.ownerId)) {
      seen('not_matched', 'its owner is not on the rule')
      continue
    }
    if (!listed(rule.regions, server.regionKey)) {
      seen('not_matched', `the rule does not cover ${server.regionKey}`)
      continue
    }
    if (!listed(rule.plans, server.plan)) {
      seen('not_matched', `the rule does not cover the ${server.plan} plan`)
      continue
    }
    const bucket = rolloutBucket(rule.id, server.serverId)
    if (bucket >= rule.percent) {
      seen('not_in_rollout', `${bucket.toFixed(2)} is outside the rule's ${rule.percent}%`)
      continue
    }
    if (atLimit(rule.provider)) {
      seen('no_room', 'it holds as many servers as its provider allows')
      continue
    }
    if (!hasRoom(rule.provider)) {
      seen('no_room', `no room for ${server.memoryMb} MB in ${server.regionKey}`)
      continue
    }
    seen('chosen', rule.note === '' ? 'matched the rule' : `matched the rule: ${rule.note}`)
    return {
      provider: rule.provider,
      ruleId: rule.id,
      reason: `rule ${rule.id.slice(0, 8)} (${rule.percent}%)`,
      considered,
    }
  }
  // The default at its provider's limit overflows to the first other runtime with room.
  if (atLimit(DEFAULT)) {
    considered.push({
      provider: DEFAULT,
      ruleId: null,
      outcome: 'no_room',
      detail: 'the default runtime holds as many servers as its provider allows',
    })
    for (const provider of PROVIDERS) {
      if (provider === DEFAULT || atLimit(provider)) continue
      if (!hasRoom(provider)) {
        considered.push({ provider, ruleId: null, outcome: 'no_room', detail: 'no room to overflow to' })
        continue
      }
      considered.push({ provider, ruleId: null, outcome: 'chosen', detail: 'the default runtime was full' })
      return {
        provider,
        ruleId: null,
        reason: `overflow: ${DEFAULT} is at its provider's limit`,
        considered,
      }
    }
  }
  const full = considered.filter((c) => c.outcome === 'no_room').map((c) => c.provider)
  considered.push({ provider: DEFAULT, ruleId: null, outcome: 'chosen', detail: 'the default runtime' })
  return {
    provider: DEFAULT,
    ruleId: null,
    reason:
      full.length === 0
        ? 'the default runtime'
        : `the default runtime: ${[...new Set(full)].join(', ')} had no room`,
    considered,
  }
}

// ─── What has happened so far ────────────────────────────────────────────────────────────────

/** The three rungs, top to bottom. */
const RUNGS = ['allow', 'canary', 'default'] as const
type Rung = (typeof RUNGS)[number]

/** The rung a line of a decision was printed at: a rule's own, or the default's. */
const rungOf = (line: Considered | undefined): Rung =>
  line?.ruleId === ALLOW.id ? 'allow' : line?.ruleId === CANARY.id ? 'canary' : 'default'

/** One server placed: the decision as it was made then, whatever the rules say now. */
interface Entry {
  server: Server
  decision: Decision
  /** The rung that placed it. */
  by: Rung
  /** Its bucket under the canary rule, where that rule got as far as working one out. */
  bucket: number | null
  /** When the visitor sent it. */
  at: string
}

interface Settings {
  percent: number
  canaryOn: boolean
  defaultFull: boolean
}

function place(index: number, settings: Settings, at: string): Entry {
  const server = serverAt(index)
  const canary = { ...CANARY, enabled: settings.canaryOn, percent: settings.percent }
  const decision = decide(server, [ALLOW, canary], settings.defaultFull)
  const read = decision.considered.find((line) => line.ruleId === CANARY.id)
  return {
    server,
    decision,
    by: rungOf(decision.considered[decision.considered.length - 1]),
    bucket: read && read.outcome !== 'not_matched' ? rolloutBucket(CANARY.id, server.serverId) : null,
    at,
  }
}

/** A decision shown whole, with nothing left to arrive. */
const SETTLED = Number.POSITIVE_INFINITY

interface State extends Settings {
  /** Every decision so far, oldest first. Nothing is ever taken out of it but by starting over. */
  log: readonly Entry[]
  /** The decision on show: its path on the rails, its verdicts, its row. -1 before the first. */
  sel: number
  /** How many of its lines have been printed; past the last, the server has landed. */
  shown: number
  /** Servers a batch still has to send. */
  queue: number
}

type Action =
  | { type: 'percent'; percent: number }
  | { type: 'canary'; on: boolean }
  | { type: 'full'; full: boolean }
  /** `still`: the visitor asked for less motion, so everything arrives at once. */
  | { type: 'send'; count: number; still: boolean; at: string }
  | { type: 'tick'; at: string }
  | { type: 'look'; sel: number }
  | { type: 'reset' }

const START: State = {
  percent: CANARY.percent,
  canaryOn: true,
  defaultFull: false,
  log: [],
  sel: -1,
  shown: SETTLED,
  queue: 0,
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'percent':
      return { ...state, percent: action.percent }
    case 'canary':
      return { ...state, canaryOn: action.on }
    case 'full':
      return { ...state, defaultFull: action.full }
    case 'send': {
      const count = Math.min(action.count, MOST - state.log.length)
      if (count <= 0) return state
      // A batch lands one server a beat, whole; with less motion asked for, all of it at once.
      const now = action.still ? count : 1
      const log = [...state.log]
      for (let i = 0; i < now; i++) log.push(place(log.length, state, action.at))
      const walked = action.count === 1 && !action.still
      // What a batch still has to send is kept: one more server sent in the middle of it walks
      // the ladder first, and the rest of the batch follows.
      const queue = state.queue + count - now
      return { ...state, log, sel: log.length - 1, shown: walked ? 0 : SETTLED, queue }
    }
    case 'tick': {
      const last = state.log[state.log.length - 1]
      if (last && state.sel === state.log.length - 1 && state.shown <= last.decision.considered.length)
        return { ...state, shown: state.shown + 1 }
      if (state.queue === 0 || state.log.length >= MOST)
        return state.queue === 0 ? state : { ...state, queue: 0 }
      const log = [...state.log, place(state.log.length, state, action.at)]
      return { ...state, log, sel: log.length - 1, shown: SETTLED, queue: state.queue - 1 }
    }
    case 'look':
      return { ...state, sel: action.sel, shown: SETTLED, queue: 0 }
    case 'reset':
      // The rules stay as the visitor set them, so the same servers can be sent through them again.
      return { ...START, percent: state.percent, canaryOn: state.canaryOn, defaultFull: state.defaultFull }
  }
}

// ─── The rails ───────────────────────────────────────────────────────────────────────────────

/** The ladder's rows, top to bottom: where a server arrives, the three rungs, the three ends. */
const ROWS = ['arrive', ...RUNGS, ...PROVIDERS] as const
type RowKey = (typeof ROWS)[number]

/**
 * The pieces of track a row can hold. Two tracks run down the ladder side by side: the main one
 * through every rung (`m`), and the one to Blockly's own machines (`f`), which both rules switch
 * onto. `Up` is the piece above a row's junction and `Down` the piece below it; `toF` is a switch
 * from the main track onto the other; `outM` and `outF` leave a track for what the row holds.
 */
type Piece = 'mUp' | 'mDown' | 'fUp' | 'fDown' | 'toF' | 'outM' | 'outF'

const TRACK: Record<RowKey, readonly Piece[]> = {
  arrive: ['outM', 'mDown'],
  allow: ['mUp', 'mDown', 'toF', 'fDown'],
  canary: ['mUp', 'mDown', 'toF', 'fUp', 'fDown'],
  default: ['mUp', 'mDown', 'fUp', 'fDown'],
  'cloud-a': ['mUp', 'mDown', 'outM', 'fUp', 'fDown'],
  'cloud-b': ['mUp', 'outM', 'fUp', 'fDown'],
  fleet: ['fUp', 'outF'],
}

type Step = readonly [RowKey, Piece]

/** The second track from under the first rule down to its end. */
const DOWN_F: readonly Step[] = [
  ['canary', 'fUp'],
  ['canary', 'fDown'],
  ['default', 'fUp'],
  ['default', 'fDown'],
  ['cloud-a', 'fUp'],
  ['cloud-a', 'fDown'],
  ['cloud-b', 'fUp'],
  ['cloud-b', 'fDown'],
  ['fleet', 'fUp'],
  ['fleet', 'outF'],
]

/**
 * Every piece of track a placed server went over, in order. Both rules send to Blockly's own
 * machines. Past the rules a server goes to the default or overflows to the second cloud; an
 * overflow never reaches Blockly's own machines here, because the second cloud places every
 * region they do and is asked first.
 */
function routeOf(entry: Entry): readonly Step[] {
  const top: Step[] = [
    ['arrive', 'mDown'],
    ['allow', 'mUp'],
  ]
  if (entry.by === 'allow') return [...top, ['allow', 'toF'], ['allow', 'fDown'], ...DOWN_F]
  const second: Step[] = [...top, ['allow', 'mDown'], ['canary', 'mUp']]
  if (entry.by === 'canary') return [...second, ['canary', 'toF'], ['canary', 'fDown'], ...DOWN_F.slice(2)]
  const third: Step[] = [
    ...second,
    ['canary', 'mDown'],
    ['default', 'mUp'],
    ['default', 'mDown'],
    ['cloud-a', 'mUp'],
  ]
  if (entry.decision.provider === DEFAULT) return [...third, ['cloud-a', 'outM']]
  return [...third, ['cloud-a', 'mDown'], ['cloud-b', 'mUp'], ['cloud-b', 'outM']]
}

type NodeState = 'idle' | 'passed' | 'cart'

/** One row's share of the rails, and the junction on the main track where it has one. */
function Rails({ row, lit, node }: { row: RowKey; lit: ReadonlySet<string>; node?: NodeState }) {
  return (
    <span className={styles.rails} aria-hidden>
      {TRACK[row].map((piece) => (
        <i key={piece} className={styles[piece]} data-on={lit.has(`${row}.${piece}`) || undefined} />
      ))}
      {node && <i className={styles.node} data-state={node} />}
    </span>
  )
}

// ─── Small parts ─────────────────────────────────────────────────────────────────────────────

/** A real string inside a sentence. */
function V({ children }: { children: ReactNode }) {
  return <span className={`bl-mono ${styles.v}`}>{children}</span>
}

/** One line a rung printed: the outcome and the reason, as they are recorded. */
function Verdict({ line, hidden, named }: { line: Considered; hidden: boolean; named?: boolean }) {
  return (
    <li className={styles.verdict} data-outcome={line.outcome} data-hidden={hidden || undefined}>
      {named && <span className={`bl-mono ${styles.who}`}>{line.provider}</span>}
      <span className={`bl-mono ${styles.outcome}`}>{line.outcome}</span>
      <span className={`bl-mono ${styles.detail}`}>{line.detail}</span>
    </li>
  )
}

/** One of two: a rule that is on or off, a runtime with room or full. */
function Either({
  legend,
  options,
  first,
  onChange,
}: {
  legend: string
  options: readonly [string, string]
  /** Whether the first of the two is chosen. */
  first: boolean
  onChange: (first: boolean) => void
}) {
  return (
    <fieldset className={styles.either}>
      <legend className={styles.sr}>{legend}</legend>
      <div className={styles.chips}>
        <button type="button" className="bl-chip" aria-pressed={first} onClick={() => onChange(true)}>
          {options[0]}
        </button>
        <button type="button" className="bl-chip" aria-pressed={!first} onClick={() => onChange(false)}>
          {options[1]}
        </button>
      </div>
    </fieldset>
  )
}

const servers = (count: number) => `${count} ${count === 1 ? 'server' : 'servers'}`
const now = () => new Date().toISOString()

/** A beat of the walk down the ladder, slow enough to read a rung; and of a batch, a server a beat. */
const STEP_MS = 650
const BATCH_MS = 150
/** The room's lamps while nothing is being placed: low, not out. */
const LAMPS_LOW = 0.25

/**
 * Where the tour moves the canary's marker to: half the line, far enough to take in servers the
 * rule had already passed by.
 */
const WIDE = 50

/**
 * One turn of the tour: what the bar says is coming, what then happens, and how many seconds that
 * is left on show before the next. A walk down the ladder is at most seven beats of STEP_MS and a
 * batch is BATCH beats of BATCH_MS, so each is over well inside the time its turn is given.
 */
interface Turn {
  soon: string
  run: () => void
  holds: number
}

export function RuntimesDemo() {
  const root = useRef<HTMLDivElement>(null)
  const inView = useInView(root)
  const still = useReducedMotion()
  const share = useId()
  const [state, dispatch] = useReducer(reduce, START)
  const { percent, canaryOn, defaultFull, log, sel, shown, queue } = state

  const entry = log[sel]
  const lines = entry?.decision.considered ?? []
  // The newest server walks the ladder a line at a time; any other decision is shown whole.
  const walking = !still && entry !== undefined && sel === log.length - 1 && shown <= lines.length
  const landed = entry !== undefined && !walking
  const printed = walking ? shown : lines.length
  // A batch is still arriving, a server a beat.
  const batching = !still && queue > 0
  const busy = walking || batching
  // A server still on the ladder is in no pile yet.
  const placed = walking ? log.slice(0, -1) : log
  const full = log.length >= MOST

  const send = (count: number) => dispatch({ type: 'send', count, still, at: now() })

  // Left alone, it plays itself. Every turn reads where the demonstration is now, because a person
  // may have left it anywhere: each does what presses could do from there, and none counts on the
  // turn before it having run. A turn that lands on a walk or a batch still going only sends more.
  //
  // What the tour sends arrives whole: where the example hasn't that many servers left, it starts
  // over first, as the line by the buttons tells a person to.
  const short = (count: number) => log.length + count > MOST
  const arrive = (count: number) => {
    if (short(count)) dispatch({ type: 'reset' })
    send(count)
  }
  // One server, walking the ladder a rung at a time. The first three are chosen (OPENING): one the
  // canary rule works a bucket out for, one it doesn't cover, and one the first rule sends to
  // Blockly's own machines.
  const walk: Turn = {
    soon: log.length === 0 || short(1) ? 'A server arrives' : 'Another arrives',
    run: () => arrive(1),
    holds: 6,
  }
  const batch: Turn = {
    soon: log.length === 0 || short(BATCH) ? `${BATCH} arrive` : `${BATCH} more arrive`,
    run: () => arrive(BATCH),
    holds: 5,
  }
  // The marker moves and nothing already placed does, whichever way it goes: out to WIDE, or back
  // to the rule's own share if someone left it at WIDE or past it. The rule is switched on, since
  // the share of a rule that is off places nothing.
  const widens = percent < WIDE
  const marker: Turn = {
    soon: widens ? 'The canary share widens' : 'The canary share narrows',
    run: () => {
      dispatch({ type: 'canary', on: true })
      dispatch({ type: 'percent', percent: widens ? WIDE : CANARY.percent })
    },
    holds: 6,
  }
  // A dozen and not one: which rule takes any one server is the hash's business, but about half of
  // the servers drawn get past both rules in a region the second cloud places, and those overflow.
  const fills: Turn = {
    soon: defaultFull ? batch.soon : 'The default runtime fills',
    run: () => {
      dispatch({ type: 'full', full: true })
      arrive(BATCH)
    },
    holds: 7,
  }
  // The rules as they began and nothing sent: what Start over does, and the rules put back too.
  const home: Turn = {
    soon: 'Back to the start',
    run: () => {
      dispatch({ type: 'percent', percent: CANARY.percent })
      dispatch({ type: 'canary', on: true })
      dispatch({ type: 'full', full: false })
      dispatch({ type: 'reset' })
    },
    holds: 3,
  }
  const turns = [walk, walk, walk, batch, marker, batch, fills, home]
  const tour = useTour({
    ref: root,
    steps: turns.map((turn) => turn.run),
    // The bar before a turn runs for as long as the turn before it is left on show.
    seconds: turns.map((_, index) => turns.at(index - 1)?.holds ?? 5),
    first: 3,
  })

  // Simulated time, only while it can be seen.
  useEffect(() => {
    if (!busy || !inView) return
    const timer = setInterval(() => dispatch({ type: 'tick', at: now() }), walking ? STEP_MS : BATCH_MS)
    return () => clearInterval(timer)
  }, [busy, inView, walking])

  // The room in the chunk: low at rest, full while a server is being placed. Handed back when the
  // demonstration is out of sight, and for someone who asked for less motion, where nothing walks.
  useEffect(() => {
    stage.glow('runtimes', inView && !still ? (busy ? 1 : LAMPS_LOW) : null)
  }, [inView, still, busy])
  useEffect(() => () => stage.glow('runtimes', null), [])

  // Where the server is: the row it stands on while it walks, the end it reached once it has landed.
  const where =
    entry === undefined
      ? -1
      : walking
        ? shown === 0
          ? 0
          : ROWS.indexOf(rungOf(lines[shown - 1]))
        : ROWS.indexOf(entry.decision.provider)
  const lit = new Set<string>()
  if (entry !== undefined) {
    lit.add('arrive.outM')
    for (const [row, piece] of routeOf(entry)) {
      const index = ROWS.indexOf(row)
      if (index < where || (index === where && (landed || piece === 'mUp' || piece === 'fUp')))
        lit.add(`${row}.${piece}`)
    }
  }
  const nodeOf = (row: RowKey): NodeState => {
    if (walking && ROWS[where] === row) return 'cart'
    if (row === 'arrive' ? entry !== undefined : lit.has(`${row}.mUp`)) return 'passed'
    return 'idle'
  }

  // The room's scene in the chunk sends the same servers down its own track: the rung the one on
  // the ladder has reached, how many each runtime holds, and whether the default is full. Which
  // rule is on and its share are left out, since the room has nothing to show them with. Out of
  // sight nothing here moves, and with less motion asked for nothing walks, so then the room is
  // left to play by itself.
  const at = walking ? (ROWS[where] ?? 'none') : 'none'
  const heldBy = (provider: Provider) => placed.filter((made) => made.decision.provider === provider).length
  const [a, b, fleet] = [heldBy('cloud-a'), heldBy('cloud-b'), heldBy('fleet')]
  useEffect(() => {
    stage.show('runtimes', inView && !still ? { at, a, b, fleet, full: defaultFull } : null)
  }, [inView, still, at, a, b, fleet, defaultFull])
  useEffect(() => () => stage.show('runtimes', null), [])

  /** What a rung printed for the server on show; a line not reached yet keeps its place, unseen. */
  const verdicts = (rung: Rung) => {
    const own = lines.flatMap((line, index) =>
      rungOf(line) === rung ? [{ line, hidden: index >= printed }] : [],
    )
    // A rung with nothing to print: a rule above placed the server, or this rule was off then.
    const skipped =
      entry === undefined || !landed || own.length > 0
        ? null
        : RUNGS.indexOf(rung) < RUNGS.indexOf(entry.by)
          ? 'Off when this server came, so it wasn’t read.'
          : 'Not read. A rule above had already placed this server.'
    return (
      <ul className={styles.verdicts}>
        {own.map(({ line, hidden }) => (
          <Verdict
            key={`${line.provider}-${line.outcome}`}
            line={line}
            hidden={hidden}
            named={rung === 'default'}
          />
        ))}
        {skipped && <li className="bl-small">{skipped}</li>}
      </ul>
    )
  }

  // The canary's line: every server that rule worked a bucket out for, and how it went then.
  const marks = placed.flatMap((made) => (made.bucket === null ? [] : [{ made, bucket: made.bucket }]))
  const sent = placed.filter((made) => made.decision.ruleId === CANARY.id).length
  const stayedOut = marks.filter(
    (mark) => mark.made.decision.ruleId !== CANARY.id && mark.bucket < percent,
  ).length
  const stayedIn = marks.filter(
    (mark) => mark.made.decision.ruleId === CANARY.id && mark.bucket >= percent,
  ).length
  // No rule placed it, the default was full, and so was everywhere else (docs/runtimes.md).
  const waits =
    landed &&
    entry.decision.provider === DEFAULT &&
    lines.some((line) => line.ruleId === null && line.provider === DEFAULT && line.outcome === 'no_room')

  // One sentence for someone who hears the page: the server on show, where it went, and the piles.
  const tally = PROVIDERS.map(
    (provider) =>
      `${provider} ${servers(placed.filter((made) => made.decision.provider === provider).length)}`,
  ).join(', ')
  const said =
    entry === undefined || busy
      ? ''
      : `Server ${entry.server.serverId.slice(0, 8)}, ${entry.server.plan}, ${entry.server.regionKey}, was placed on ${entry.decision.provider}. Reason recorded: ${entry.decision.reason}. Placed so far: ${tally}.`

  return (
    <div className={styles.demo} ref={root}>
      <TourBar tour={tour} label={turns[tour.next]?.soon} />
      {/* A button with nothing to do says so and does nothing, but stays in reach of the keyboard.
          The second and third go off under their own press, and any of the three can under the
          tour: a disabled button would drop the keyboard resting on it. */}
      <div className={styles.send}>
        <button
          type="button"
          className="bl-btn"
          aria-disabled={full || undefined}
          onClick={full ? undefined : () => send(1)}
        >
          New server
        </button>
        <button
          type="button"
          className="bl-btn bl-btn--quiet"
          aria-disabled={full || batching || undefined}
          onClick={full || batching ? undefined : () => send(BATCH)}
        >
          Send {BATCH}
        </button>
        <button
          type="button"
          className="bl-btn bl-btn--sm bl-btn--quiet"
          aria-disabled={log.length === 0 || undefined}
          onClick={log.length === 0 ? undefined : () => dispatch({ type: 'reset' })}
        >
          Start over
        </button>
        {full && (
          <p className={`bl-small ${styles.over}`}>
            That is all {MOST} of the example’s servers. Start over to send the same ones again.
          </p>
        )}
      </div>

      <ol className={styles.ladder}>
        <li className={styles.row}>
          <Rails row="arrive" lit={lit} node={nodeOf('arrive')} />
          <div className={styles.cell}>
            <div
              className={`bl-frame bl-frame--bare ${styles.box}`}
              data-here={entry !== undefined || undefined}
            >
              <p className={styles.name}>A new server</p>
              {entry === undefined ? (
                <p className={`bl-small ${styles.says}`}>
                  {/* Only where the tour won't send one itself is there anything to press for. */}
                  {(tour.off || tour.paused) && 'Press New server. '}It drops through the rules below, top to
                  bottom, and the first that matches places it.
                </p>
              ) : (
                <dl className={styles.attrs}>
                  <div>
                    <dt className="bl-mono">serverId</dt>
                    <dd className="bl-mono">{entry.server.serverId}</dd>
                  </div>
                  <div>
                    <dt className="bl-mono">plan</dt>
                    <dd className="bl-mono">{entry.server.plan}</dd>
                  </div>
                  <div>
                    <dt className="bl-mono">regionKey</dt>
                    <dd className="bl-mono">{entry.server.regionKey}</dd>
                  </div>
                  <div>
                    <dt className="bl-mono">memoryMb</dt>
                    <dd className="bl-mono bl-num">{entry.server.memoryMb}</dd>
                  </div>
                  <div>
                    <dt className="bl-mono">ownerId</dt>
                    <dd className="bl-mono">{entry.server.ownerId}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
        </li>

        <li className={styles.row}>
          <Rails row="allow" lit={lit} node={nodeOf('allow')} />
          <div className={styles.cell}>
            <div className={styles.head}>
              {/* The rung's name is the reason it records when it places a server (placement.ts). */}
              <p className={`bl-mono ${styles.title}`}>
                rule {ALLOW.id.slice(0, 8)} ({ALLOW.percent}%)
              </p>
            </div>
            <p className={`bl-small ${styles.says}`}>
              To <V>{ALLOW.provider}</V>: every new server whose owner is one of five named accounts.
            </p>
            {verdicts('allow')}
          </div>
        </li>

        <li className={styles.row}>
          <Rails row="canary" lit={lit} node={nodeOf('canary')} />
          <div className={styles.cell}>
            <div className={styles.head}>
              <p className={`bl-mono bl-num ${styles.title}`}>
                rule {CANARY.id.slice(0, 8)} ({percent}%)
              </p>
              <Either
                legend="The canary rule"
                options={['On', 'Off']}
                first={canaryOn}
                onChange={(on) => dispatch({ type: 'canary', on })}
              />
            </div>
            <p className={`bl-small ${styles.says}`}>
              To <V>{CANARY.provider}</V>: a share of new <V>plus</V> servers in <V>eu</V>.
            </p>
            {verdicts('canary')}

            <div className={styles.share}>
              <label htmlFor={share}>Its share of matching new servers</label>
              <output htmlFor={share} className="bl-mono bl-num" aria-live="off">
                {percent}%
              </output>
            </div>
            <div className={styles.bucket}>
              <div className={styles.scale} aria-hidden>
                <i className={`bl-dither ${styles.zone}`} data-level="2" style={{ width: `${percent}%` }} />
                {marks.map(({ made, bucket }) => (
                  <i
                    key={made.server.serverId}
                    className={styles.mark}
                    data-in={made.decision.ruleId === CANARY.id || undefined}
                    data-sel={made === entry || undefined}
                    style={{ left: `${bucket}%` }}
                  />
                ))}
              </div>
              <input
                id={share}
                className={styles.range}
                type="range"
                min={0}
                max={100}
                step={1}
                value={percent}
                aria-valuetext={`${percent}%`}
                onChange={(event) => dispatch({ type: 'percent', percent: Number(event.target.value) })}
              />
            </div>
            <div className={`bl-mono bl-num ${styles.axis}`} aria-hidden>
              <span>0</span>
              <span>100</span>
            </div>
            <p className={`bl-small ${styles.says}`}>
              Each bar is a server that matched this rule, at its bucket: a number from 0 to 100 hashed from
              the rule’s id and the server’s, so it never changes. Left of the marker is in. A solid bar went
              to Cubepals’ own machines.
            </p>
            {!canaryOn && (
              <p className={`bl-small ${styles.told}`}>
                Off. New servers pass this rule by.{' '}
                {sent === 0
                  ? 'Nothing already placed moves.'
                  : `The ${servers(sent)} it sent to Cubepals’ own machines ${sent === 1 ? 'stays' : 'stay'} there.`}
              </p>
            )}
            {stayedOut > 0 && (
              <p className={`bl-small ${styles.told}`}>
                {stayedOut === 1
                  ? '1 hollow bar is left of the marker: a server placed before the marker moved. It stays where it is.'
                  : `${stayedOut} hollow bars are left of the marker: servers placed before the marker moved. They stay where they are.`}
                {canaryOn &&
                  ' Start over to send the same servers again, and every bar left of the marker goes to Cubepals’ own machines.'}
              </p>
            )}
            {stayedIn > 0 && (
              <p className={`bl-small ${styles.told}`}>
                {stayedIn === 1
                  ? '1 solid bar is right of the marker: a server already on Cubepals’ own machines. It stays there.'
                  : `${stayedIn} solid bars are right of the marker: servers already on Cubepals’ own machines. They stay there.`}
              </p>
            )}
          </div>
        </li>

        <li className={styles.row}>
          <Rails row="default" lit={lit} node={nodeOf('default')} />
          <div className={styles.cell}>
            <div className={styles.head}>
              <p className={`bl-mono ${styles.title}`}>the default runtime</p>
              <Either
                legend="The default runtime"
                options={['Has room', 'Is full']}
                first={!defaultFull}
                onChange={(room) => dispatch({ type: 'full', full: !room })}
              />
            </div>
            <p className={`bl-small ${styles.says}`}>
              <V>{DEFAULT}</V>: where every new server goes that no rule sends elsewhere.
            </p>
            {verdicts('default')}
            {defaultFull && (
              <p className={`bl-small ${styles.told}`}>
                Full: it holds as many servers as its provider allows. New ones overflow to the first other
                runtime with room.
              </p>
            )}
            {waits && (
              <p className={`bl-small ${styles.told}`}>
                No runtime had room for this one, so it goes to the default and waits there.
              </p>
            )}
          </div>
        </li>

        {PROVIDERS.map((provider) => {
          const held = placed.filter((made) => made.decision.provider === provider)
          const here = landed && entry.decision.provider === provider
          return (
            <li key={provider} className={styles.row}>
              <Rails row={provider} lit={lit} />
              <div className={styles.cell} data-end>
                <div className={`bl-frame bl-frame--bare ${styles.box}`} data-here={here || undefined}>
                  <div className={styles.endHead}>
                    <p className={styles.name}>{ENDS[provider].title}</p>
                    <p className={`bl-small bl-num ${styles.held}`}>{servers(held.length)}</p>
                  </div>
                  <p className={`bl-small ${styles.says}`}>
                    <V>{provider}</V> {ENDS[provider].kind !== null && `${ENDS[provider].kind} `}Places{' '}
                    {PLACES[provider].map((region, index) => (
                      <span key={region}>
                        {index > 0 && ' and '}
                        <V>{region}</V>
                      </span>
                    ))}
                    .
                  </p>
                  <div className={styles.pile} aria-hidden>
                    {held.map((made) => (
                      <i key={made.server.serverId} data-sel={made === entry || undefined} />
                    ))}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {/* apps/control/src/app/runtimes/router.ts, apps/control/src/infra/fleet/handle.ts */}
      <p className={`bl-small ${styles.says}`}>
        Every handle a runtime issues begins with its own prefix, <V>fleet:v1:</V> on Cubepals’ own machines,
        and every later call for a server goes to the runtime that issued its handle.
      </p>

      <section
        className={`bl-frame bl-frame--bare ${styles.record}`}
        aria-label="The decision recorded for this server"
      >
        <div className={styles.recordHead}>
          <p className={styles.recordTitle}>
            {/* packages/db/src/schema.ts */}
            <span className={`bl-mono ${styles.v}`}>runtime_decisions</span>
            <span className="bl-small">The row kept for this server, and for every one before it.</span>
          </p>
          <div className={styles.pager}>
            <button
              type="button"
              className="bl-chip"
              aria-disabled={sel <= 0 || undefined}
              onClick={sel <= 0 ? undefined : () => dispatch({ type: 'look', sel: sel - 1 })}
            >
              Earlier
            </button>
            <button
              type="button"
              className="bl-chip"
              aria-disabled={sel >= log.length - 1 || undefined}
              onClick={sel >= log.length - 1 ? undefined : () => dispatch({ type: 'look', sel: sel + 1 })}
            >
              Later
            </button>
            <span className="bl-small bl-num">
              {log.length === 0 ? 'None yet' : `${sel + 1} of ${log.length}`}
            </span>
          </div>
        </div>
        {entry !== undefined && (
          <dl className={`bl-mono ${styles.fields}`}>
            <dt>kind</dt>
            <dd>placed</dd>
            <dt>serverId</dt>
            <dd>{entry.server.serverId}</dd>
            <dt>provider</dt>
            <dd data-hidden={!landed || undefined}>{entry.decision.provider}</dd>
            <dt>fromProvider</dt>
            <dd>null</dd>
            <dt>ruleId</dt>
            <dd data-hidden={!landed || undefined}>{entry.decision.ruleId ?? 'null'}</dd>
            <dt>reason</dt>
            <dd data-hidden={!landed || undefined}>{entry.decision.reason}</dd>
            <dt>considered</dt>
            <dd>
              <ol className={styles.considered}>
                {lines.map((line, index) => (
                  <li
                    key={`${line.provider}-${line.ruleId ?? 'none'}-${line.outcome}`}
                    data-outcome={line.outcome}
                    data-hidden={index >= printed || undefined}
                  >
                    <span className={styles.pair}>
                      <span className={styles.key}>provider</span> {line.provider}
                    </span>
                    <span className={styles.pair}>
                      <span className={styles.key}>ruleId</span> {line.ruleId ?? 'null'}
                    </span>
                    <span className={styles.pair}>
                      <span className={styles.key}>outcome</span>{' '}
                      <span className={styles.outcome}>{line.outcome}</span>
                    </span>
                    <span className={styles.pair}>
                      <span className={styles.key}>detail</span> {line.detail}
                    </span>
                  </li>
                ))}
              </ol>
            </dd>
            {/* The owner who made the server: `user:` and their id (apps/control/src/app/actor.ts). */}
            <dt>decidedBy</dt>
            <dd>user:{entry.server.ownerId}</dd>
            <dt>at</dt>
            <dd>{entry.at}</dd>
          </dl>
        )}
      </section>

      {/* Quiet while the tour is what is placing servers; a person's own press is read out. */}
      <p className={styles.sr} aria-live={tour.auto ? 'off' : 'polite'}>
        {said}
      </p>
    </div>
  )
}
