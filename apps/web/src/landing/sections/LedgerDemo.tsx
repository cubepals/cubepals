// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The ledger: every decision Blockly makes for the server that was chosen, written out line by
 * line and rewritten as the choice changes, with the count the film quotes.
 */
import type { PublicPlan } from '@blockly/contracts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import {
  addressOf,
  choice,
  EXAMPLE_NAME,
  FIRST_PLAY,
  type Fit,
  fitOf,
  PARTIES,
  type Party,
  type PartyKey,
  PLAYS,
  type Play,
  type PlayKey,
  partyOf,
  playOf,
  SMALLEST,
  useChoice,
  useToured,
} from './choice'
import styles from './ledger.module.css'

type GroupKey = 'game' | 'address' | 'machine' | 'upkeep'

/** One decision: its plain name, and the value Blockly's code gives it for this server. */
interface Line {
  id: string
  group: GroupKey
  name: string
  /** Null where this server has no such decision: plain Minecraft has no loader build to pin. */
  value: string | null
  /** A value said in words, where the code holds nothing to quote. */
  said?: boolean
  /** A value too long to sit beside its name. */
  long?: boolean
}

/** The ledger's two columns on a wide screen, and its reading order on a narrow one. */
const COLUMNS: readonly (readonly { key: GroupKey; title: string }[])[] = [
  [
    { key: 'game', title: 'The game' },
    { key: 'address', title: 'The address' },
  ],
  [
    { key: 'machine', title: 'The machine' },
    { key: 'upkeep', title: 'The upkeep' },
  ],
]

/** The release of the game image every server runs (apps/control/src/minecraft/runtime-spec.ts). */
const IMAGE_RELEASE = '2026.9.1'

/** Whether a choice runs the image's Alpine build: plain Minecraft on Java 21 or 25 (runtime-spec.ts). */
const alpine = (play: Play, java: number): boolean =>
  play.loader === 'vanilla' && play.mods.length === 0 && (java === 21 || java === 25)

/** The Java a Minecraft release needs (apps/control/src/minecraft/versions.ts). */
function javaFor(release: string): number {
  const [major = 0, minor = 0, patch = 0] = release.split('.').map((part) => Number.parseInt(part, 10))
  if (major >= 26) return 25
  if (major === 1 && (minor > 20 || (minor === 20 && patch >= 5))) return 21
  if (major === 1 && minor >= 17) return 17
  return 8
}

/**
 * What the image calls each server type and the variable its build is pinned in
 * (apps/control/src/minecraft/runtime-spec.ts; plain Minecraft has no build,
 * apps/control/src/app/revisions/pins.ts), and where its jars go
 * (apps/control/src/minecraft/jars.ts).
 */
const SERVER_TYPE: Record<Play['loader'], { type: string; build: string | null; jars: string | null }> = {
  vanilla: { type: 'VANILLA', build: null, jars: null },
  paper: { type: 'PAPER', build: 'PAPER_BUILD', jars: '/data/plugins' },
  neoforge: { type: 'NEOFORGE', build: 'NEOFORGE_VERSION', jars: '/data/mods' },
}

/**
 * How much of a server's memory is the Java heap: 75%, or 65% with mods, and from 3 GB up never
 * less than a gigabyte left outside it (apps/control/src/minecraft/runtime-spec.ts).
 */
function heapMb(memoryMb: number, modded: boolean): number {
  const share = Math.floor(memoryMb * (modded ? 0.65 : 0.75))
  return memoryMb >= 3072 ? Math.min(share, memoryMb - 1024) : share
}

/** Dedicated cores, by memory (apps/control/src/infra/fly/machine-config.ts). */
const coresFor = (memoryMb: number): number => (memoryMb <= 3072 ? 1 : memoryMb <= 4096 ? 2 : 4)

/**
 * What a plan sets that the public plans don't carry, from the plan table
 * (apps/control/src/domain/account/entitlements.ts). Free fits a new server's settings down to its
 * caps (apps/control/src/app/revisions/caps.ts), and has a 2,500-block border, a 3 GB disk that
 * doesn't grow, 3 backups and a week of trash. The paid plan has no caps, so the defaults stand
 * (apps/control/src/domain/revision/revision.ts), with a 10,000-block border, a 5 GB disk that
 * grows to 20, 14 backups and a month of trash.
 */
const BY_PLAN = {
  free: { view: 8, simulation: 6, border: 2500, diskGb: 3, diskMostGb: null, backups: 3, trashDays: 7 },
  paid: { view: 10, simulation: 10, border: 10000, diskGb: 5, diskMostGb: 20, backups: 14, trashDays: 30 },
} as const

/**
 * A new server's line in Minecraft's server list; a name too long to quote in one line leaves just
 * the words (apps/control/src/domain/revision/revision.ts).
 */
function welcome(name: string): string {
  const quoted = `"${name}", a server created by Cubepals`
  return quoted.length <= 59 ? quoted : 'A server created by Cubepals'
}

/**
 * Every decision Blockly makes for one choice, in the order the ledger lists them. Each value is
 * what the code named beside it sets; nothing here is typed in to look good.
 */
function ledgerOf(play: Play, party: Party, typed: string, fit: Fit): Line[] {
  const name = typed.trim() || EXAMPLE_NAME
  const type = SERVER_TYPE[play.loader]
  const modded = play.mods.length > 0
  const java = javaFor(play.release)
  const heap = heapMb(party.memoryMb, modded)
  const plan = fit.free ? BY_PLAN.free : BY_PLAN.paid
  const sleeps = fit.plan?.sleepsAfterMinutes ?? null
  const rests = fit.plan?.restsAfterDays ?? null

  return [
    // choice.ts PLAYS: the newest release everything in the choice runs on.
    { id: 'release', group: 'game', name: 'Minecraft release', value: play.release },
    // TYPE (runtime-spec.ts).
    { id: 'type', group: 'game', name: 'Server type', value: type.type },
    // The build is pinned into the first revision (apps/control/src/app/servers/service.ts).
    { id: 'build', group: 'game', name: 'Build pinned in', value: type.build },
    // The Modrinth project the template brings (apps/control/src/app/setups/templates.ts).
    { id: 'mods', group: 'game', name: 'Mod installed', value: modded ? play.mods.join(', ') : null },
    { id: 'jars', group: 'game', name: 'Jars go in', value: type.jars },
    { id: 'java', group: 'game', name: 'Java', value: String(java) },
    // The image's tag: plain Minecraft on Java 21 or 25 takes the Alpine build (imageFor, runtime-spec.ts).
    {
      id: 'image',
      group: 'game',
      name: 'Image tag',
      value: `${IMAGE_RELEASE}-java${java}${alpine(play, java) ? '-alpine' : ''}`,
    },
    // MODE, DIFFICULTY, HARDCORE, PVP, from the template (templates.ts; runtime-spec.ts).
    { id: 'mode', group: 'game', name: 'Game mode', value: play.gameMode },
    { id: 'difficulty', group: 'game', name: 'Difficulty', value: play.difficulty },
    { id: 'hardcore', group: 'game', name: 'Hardcore', value: String(play.hardcore) },
    { id: 'pvp', group: 'game', name: 'PvP', value: String(play.pvp) },
    { id: 'view', group: 'game', name: 'View distance', value: `${plan.view} chunks` },
    { id: 'simulation', group: 'game', name: 'Simulation distance', value: `${plan.simulation} chunks` },
    // revision.ts.
    { id: 'spawn', group: 'game', name: 'Spawn protection', value: '0 blocks' },
    // LEVEL: a server's first world (apps/control/src/domain/world/world.ts).
    { id: 'level', group: 'game', name: 'World folder', value: 'world' },
    // No seed is set unless one is given, and the create page gives none (servers/service.ts).
    { id: 'seed', group: 'game', name: 'Seed', value: 'random', said: true },
    // MAX_WORLD_SIZE (runtime-spec.ts).
    { id: 'border', group: 'game', name: 'World border', value: `${plan.border} blocks from the center` },
    // MAX_PLAYERS, from the group (apps/control/src/domain/server/size.ts).
    { id: 'players', group: 'game', name: 'Max players', value: String(party.maxPlayers) },
    // ONLINE_MODE: on for every new server (revision.ts; runtime-spec.ts).
    { id: 'online', group: 'game', name: 'Accounts verified', value: 'TRUE' },
    // EULA (runtime-spec.ts), named as the create page says it: "Every server runs Minecraft
    // under Mojang’s End User License Agreement." (apps/web/src/app/(app)/servers/new/page.tsx).
    // Under this heading the bare name would read as Blockly agreeing to it for the owner.
    { id: 'eula', group: 'game', name: 'Runs under Mojang’s EULA', value: 'TRUE' },

    // The name as a slug, on the play domain (choice.ts addressOf).
    { id: 'address', group: 'address', name: 'Address', value: addressOf(name), long: true },
    // Minecraft assumes it, so the address leaves it out (apps/control/src/minecraft/address.ts).
    { id: 'port', group: 'address', name: 'Port, left out of it', value: '25565' },
    { id: 'motd', group: 'address', name: 'Server-list message', value: welcome(name), long: true },
    // Blockly's own until the owner picks one (packages/contracts/src/server.ts).
    { id: 'icon', group: 'address', name: 'Server-list icon', value: 'the Cubepals mark' },
    // Drawn when the server is made (apps/control/src/app/servers/invites.ts).
    { id: 'invite', group: 'address', name: 'Invite code', value: '12 characters' },
    // Off on a new server: anyone with the address can join (apps/control/src/domain/access/access.ts).
    { id: 'whitelist', group: 'address', name: 'Whitelist', value: 'false' },

    { id: 'memory', group: 'machine', name: 'Memory', value: `${party.memoryMb} MB` },
    // MEMORY (runtime-spec.ts).
    { id: 'heap', group: 'machine', name: 'Java heap', value: `${heap}M` },
    // runtime-spec.ts.
    { id: 'flags', group: 'machine', name: 'JVM flags', value: 'USE_AIKAR_FLAGS' },
    { id: 'cores', group: 'machine', name: 'Dedicated cores', value: String(coresFor(party.memoryMb)) },
    { id: 'disk', group: 'machine', name: 'Disk', value: `${plan.diskGb} GB` },
    // The volume's mount point (apps/control/src/minecraft/jars.ts; runtime-spec.ts).
    { id: 'mount', group: 'machine', name: 'Disk mounted at', value: '/data' },
    {
      id: 'grows',
      group: 'machine',
      name: 'Disk grows up to',
      value: plan.diskMostGb === null ? null : `${plan.diskMostGb} GB`,
    },
    // RCON_PORT, reachable by the control plane only (runtime-spec.ts).
    { id: 'rcon', group: 'machine', name: 'Console port', value: '25575' },
    // Derived per server, never stored (apps/control/src/app/secrets.ts).
    { id: 'secret', group: 'machine', name: 'Console password from', value: 'HMAC-SHA-256' },
    // runtime-spec.ts, and its STOP_DURATION.
    { id: 'signal', group: 'machine', name: 'Stop signal', value: 'SIGTERM' },
    { id: 'grace', group: 'machine', name: 'Time to save on stop', value: '60 s' },
    // restart on-failure, max_retries 3 (apps/control/src/infra/fly/machine-config.ts).
    { id: 'restarts', group: 'machine', name: 'Crash restarts allowed', value: '3' },

    // Queued in the same transaction that makes the server (servers/service.ts).
    { id: 'job', group: 'upkeep', name: 'First job queued', value: 'provision' },
    // A status ping until it answers (apps/control/src/app/operations/boot.ts).
    { id: 'ready', group: 'upkeep', name: 'Pinged until ready, every', value: '2 s' },
    // The remedies a failed start is read into (apps/control/src/minecraft/diagnosis.ts).
    {
      id: 'diagnosis',
      group: 'upkeep',
      name: 'A failed start is read as one of',
      value: 'ours, more_room, mods, modpack, restore, retry',
      long: true,
    },
    // The step that puts the last configuration back (apps/control/src/app/operations/runner.ts).
    { id: 'rollback', group: 'upkeep', name: 'A change that fails', value: 'rolling_back' },
    // Every installed jar is hashed against its pin (apps/control/src/minecraft/install-check.ts).
    { id: 'verify', group: 'upkeep', name: 'Mods checked with', value: modded ? 'sha512sum' : null },
    // The plan's own number (PublicPlan.sleepsAfterMinutes).
    {
      id: 'sleeps',
      group: 'upkeep',
      name: 'Sleeps when empty, after',
      value: sleeps === null ? null : `${sleeps} min`,
    },
    // PLAYER_IDLE_TIMEOUT: 15 on both plans (entitlements.ts).
    { id: 'afk', group: 'upkeep', name: 'Kicks the idle, after', value: '15 min' },
    // A snapshot each day it was played (apps/control/src/app/operations/schedules.ts).
    { id: 'backups', group: 'upkeep', name: 'Daily backups kept', value: String(plan.backups) },
    // The plan's own number (PublicPlan.restsAfterDays).
    {
      id: 'rests',
      group: 'upkeep',
      name: 'Rests when unplayed for',
      value: rests === null ? null : `${rests} days`,
    },
    { id: 'trash', group: 'upkeep', name: 'Trash keeps it', value: `${plan.trashDays} days` },
  ]
}

/** How fast the ledger rewrites itself: about twelve lines a second. */
const TICK_MS = 85

/** A rewrite: the ledger as it stood, as it will stand, and how many changed lines are done. */
interface Run {
  from: Line[]
  to: Line[]
  step: number
}

const SETTLED = Number.POSITIVE_INFINITY

/**
 * One stop on the round the ledger makes when nobody is using it: the choice it arrives at, what
 * the bar says while that is coming, and how many seconds it then stands, which is the rewrite
 * (about a twelfth of a second a line) and time to look at what it marked.
 */
interface Stop {
  play: PlayKey
  party: PartyKey
  label: string
  stands: number
}

const picked = (key: PlayKey): string => `${playOf(key).title} is picked`

/** Where the page starts, and where every round ends. */
const HOME: Stop = { play: FIRST_PLAY.key, party: SMALLEST.key, label: 'Back to the start', stands: 5 }

/**
 * The round's first press, and the longest reach of any one answer: a mod loader, an older
 * release, another plan's numbers.
 */
const FURTHEST: Stop = { play: 'create', party: SMALLEST.key, label: picked('create'), stands: 7 }

/** The round: one chip a stop, each chosen for how far its answer reaches. */
const ROUND: readonly Stop[] = [
  HOME,
  FURTHEST,
  // The third question, where it is asked: the machine's lines move, and the count says three.
  { play: 'create', party: '20', label: 'A bigger group', stands: 5 },
  // Plain Minecraft again with the group kept: the loader's lines go, and the plan's stay.
  { play: 'hardcore', party: '20', label: picked('hardcore'), stands: 6 },
]

/** How many things Blockly decides for one choice: the ledger's own count, for whoever quotes it. */
export const decisionsOf = (plans: readonly PublicPlan[], play: Play, party: Party, typed: string): number =>
  ledgerOf(play, party, typed, fitOf(plans, play, party)).filter((line) => line.value !== null).length

/**
 * How many seconds a choice a person made stands before the round takes it on: as long as the
 * tour leaves anything a person touched (tour.tsx, `rest`).
 */
const THEIRS_STANDS = 9

/**
 * The ledger: everything Blockly decided for the server chosen above, each line a plain name and
 * the value the code really sets. Changing the choice rewrites only the lines it changes, top to
 * bottom, so the reach of one answer can be seen; the count at the end is the lines on the page.
 * Left alone it presses its own chips, one every few seconds, and comes back to where it started.
 */
export function LedgerDemo({ plans }: { plans: PublicPlan[] }) {
  const play = playOf(useChoice((chosen) => chosen.play))
  const party = partyOf(useChoice((chosen) => chosen.party))
  const typed = useChoice((chosen) => chosen.name)
  const toured = useToured()
  const reduced = useReducedMotion()
  const sheet = useRef<HTMLDivElement>(null)
  const inView = useInView(sheet)
  const heading = useId()

  const fit = useMemo(() => fitOf(plans, play, party), [plans, play, party])
  const target = useMemo(() => ledgerOf(play, party, typed, fit), [play, party, typed, fit])

  const [run, setRun] = useState<Run>({ from: target, to: target, step: SETTLED })
  // The places where the two differ, top to bottom: the order they are rewritten in.
  const changed = run.to.flatMap((line, index) => (run.from[index]?.value === line.value ? [] : [index]))
  const done = reduced || run.step > changed.length
  const written = done ? changed.length : run.step
  const writing = done ? undefined : changed[run.step - 1]
  const shown = run.to.map((line, index) => {
    const turn = changed.indexOf(index)
    return turn >= written ? (run.from[index] ?? line) : line
  })
  const marked = new Set(changed.slice(0, written))

  // The server drawn under the house is told which lines the last choice changed, by group, so
  // the part of it they are about is lit as the squares here are.
  const kept = shown
    .map((line, index) => `${line.group[0]}${line.value === null ? 0 : marked.has(index) ? 2 : 1}`)
    .join('')
  useEffect(() => {
    stage.set({ ledger: kept })
  }, [kept])

  // A new choice starts a rewrite from whatever is on the page now, its first line at once. Out
  // of sight, or with less motion asked for, the whole ledger is simply the new one.
  if (run.to !== target) setRun({ from: shown, to: target, step: inView && !reduced ? 1 : SETTLED })

  useEffect(() => {
    if (done) return
    if (!inView) {
      setRun((now) => ({ ...now, step: SETTLED }))
      return
    }
    const timer = setInterval(() => setRun((now) => ({ ...now, step: now.step + 1 })), TICK_MS)
    return () => clearInterval(timer)
  }, [done, inView])

  const count = shown.filter((line) => line.value !== null).length
  // Where the count ends once the rewrite is done: what is said aloud, once.
  const total = target.filter((line) => line.value !== null).length
  // The three rows at the top: what to play, who's playing, what to call it. (On the free plan
  // the group has one size and the second isn't asked; here it is a row like the others, and
  // the count says what the rows show.)
  const made = 3
  const runsOn = fit.why ?? (fit.plan ? `Runs on ${fit.plan.name}.` : null)

  // The tour's next stop is read off the choice as it stands, never off what the tour did last.
  // On the round it is the stop after this one. Off it, where a person left the choice or the
  // questions' own tour did (they share it), a small group is one chip from the round's first
  // press and goes there; anything else goes back to the start.
  const here = ROUND.findIndex((stop) => stop.play === play.key && stop.party === party.key)
  const offRound = party.key === SMALLEST.key ? FURTHEST : HOME
  const next = here < 0 ? offRound : (ROUND[here + 1] ?? HOME)
  // A choice a person made is theirs wherever they made it: with these chips, or in the questions
  // above, where the tour here never sees the press. This ledger is written for what they
  // answered, so their answer stands that long before the round takes it on. Where the page
  // starts is nobody's answer, and what a tour left is not a person's: those keep their windows.
  const theirs = !toured && here !== 0
  const tour = useTour({
    ref: sheet,
    steps: [() => choice.set({ play: next.play, party: next.party }, 'tour')],
    seconds: theirs ? THEIRS_STANDS : (ROUND[here]?.stands ?? 4),
    first: theirs ? THEIRS_STANDS : 3,
  })

  return (
    <div className={styles.sheet} ref={sheet}>
      <TourBar tour={tour} label={next.label} className={styles.tour} />

      {/* The decisions that were the visitor's, each on a row of its own with its number, so they
          can be counted where they are made: the total under the ledger says the same three. */}
      <div className={styles.choices}>
        <p className={`bl-small ${styles.yours}`}>What you decided</p>
        <div className={styles.choice}>
          <span className={`bl-num ${styles.nth}`} aria-hidden>
            1
          </span>
          <span className={`bl-small ${styles.asked}`} id={`${heading}-play`}>
            What to play
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset */}
          <div className={styles.chips} role="group" aria-labelledby={`${heading}-play`}>
            {PLAYS.map((way) => (
              <button
                key={way.key}
                type="button"
                className="bl-chip"
                aria-pressed={way.key === play.key}
                onClick={() => choice.set({ play: way.key })}
              >
                {way.title}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.choice}>
          <span className={`bl-num ${styles.nth}`} aria-hidden>
            2
          </span>
          <span className={`bl-small ${styles.asked}`} id={`${heading}-party`}>
            Who’s playing
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset */}
          <div className={styles.chips} role="group" aria-labelledby={`${heading}-party`}>
            {PARTIES.map((size) => (
              <button
                key={size.key}
                type="button"
                className="bl-chip bl-num"
                aria-pressed={size.key === party.key}
                onClick={() => choice.set({ party: size.key })}
              >
                {size.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.choice}>
          <span className={`bl-num ${styles.nth}`} aria-hidden>
            3
          </span>
          <span className={`bl-small ${styles.asked}`}>What to call it</span>
          {/* The name is typed in the questions above, and only there; here it is read back. */}
          <p className={styles.named}>
            <span className={styles.name}>{typed.trim() || EXAMPLE_NAME}</span>
            {typed.trim() === '' && <span className="bl-small"> until you name yours above</span>}
          </p>
        </div>
        {runsOn && <p className={`bl-small ${styles.runs}`}>{runsOn}</p>}
      </div>

      <p className={`bl-small ${styles.theirs}`}>What Cubepals decided</p>
      <div className={styles.columns}>
        {COLUMNS.map((column, at) => (
          <div key={column.map((group) => group.key).join()} className={styles.column}>
            {column.map((group) => (
              <section key={group.key} aria-labelledby={`${heading}-${group.key}`}>
                <h3 id={`${heading}-${group.key}`} className={styles.groupTitle}>
                  {group.title}
                </h3>
                <dl className={styles.lines}>
                  {shown.map((line, index) =>
                    line.group !== group.key || line.value === null ? null : (
                      <div
                        key={line.id}
                        className={styles.line}
                        data-long={line.long || undefined}
                        data-changed={marked.has(index) || undefined}
                        data-now={writing === index || undefined}
                      >
                        <dt>{line.name}</dt>
                        <dd className={line.said ? styles.said : 'bl-mono'}>
                          <span className={styles.value}>{line.value}</span>
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              </section>
            ))}
            {/* The total goes where a ledger's total goes: under the last column. */}
            {at === COLUMNS.length - 1 && (
              <p className={`bl-h3 bl-num ${styles.count}`}>
                {/* The number ticks as lines are written. What is said aloud is where it ends,
                    once for each choice a person makes, and not at all for one a tour made,
                    this ledger's or the questions' above. The choice itself says who made it. The
                    tour's `auto` can't: a chip pressed from a screen reader arrives as a click,
                    which the tour doesn't take for a touch, so it would keep a person's own
                    choice quiet. */}
                <span aria-hidden>
                  {count} decisions. You made {made}.
                </span>
                <span className={styles.aside} aria-live={toured ? 'off' : 'polite'} aria-atomic="true">
                  {play.title}, {party.label}: {total} decisions. You made {made}.
                </span>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
