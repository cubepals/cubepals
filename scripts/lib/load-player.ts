// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One person in the load test, living their own life through the same public paths the website
 * uses, without knowing about anyone else in the run: signs up and confirms through the mail
 * catcher, is put on a plan, makes a server from a template the plan allows, opens it to their
 * friends, who arrive at random moments and play for random minutes, then everyone leaves and the
 * server goes to sleep. After that each person does what they would: comes back a few minutes
 * later and wakes it, starts and stops it from the website, puts it in the trash, or makes a
 * second server. What is chosen at random is chosen per person, and kept in their steps.
 *
 * Every step is timed and kept, failed or not, with its server, the operation on it and the error
 * the product gave; after a failure the person carries on where a person could, and gives up
 * where they couldn't. Nothing is retried here: a join the edge turns away while a world wakes is
 * tried again by the probe, as a player clicks Join again, and every attempt is counted.
 *
 * Not for: running the probes (`load-probe-fleet.ts`), or the report (`load-report.ts`).
 */
import { randomUUID } from 'node:crypto'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { ACCOUNT, ASLEEP, type ChaosFinding, type Hands, MAKING, PLAYING } from './load-chaos.ts'
import { type JobAnswer, leastBusy, type Probe } from './load-probe-fleet.ts'
import type { Api } from './people.ts'

/** One step of one person, as the report reads it. */
export interface StepRecord {
  player: number
  step: string
  ok: boolean
  ms: number
  /** When it began, ms since the epoch. */
  at: number
  server?: string
  template?: string
  plan?: string
  /** The operation on the server when it failed: its kind, step, and the error owners read. */
  operation?: string
  error?: string
  /** Join attempts the edge turned away before one got in: the product's own retries. */
  retries?: number
  note?: string
}

/** Where a person is now, for the live line and the timeline. */
export type Phase = 'signing up' | 'making' | 'playing' | 'asleep' | 'away' | 'done'

/** What a person needs from the run. */
export interface Run {
  id: string
  domain: string
  /** A create key for one of this run's servers: the run's mark, then a random UUID's rest. */
  key: () => string
  signUp: (email: string) => Promise<{ api: Api; password: string }>
  /** Sign-in and its mail as the website calls them, each request once. */
  auth: (path: string, body: unknown) => Promise<Response>
  mailpit: string
  sql: (statement: string) => Promise<string>
  probes: readonly Probe[]
  /** Friends a server gets, and the minutes each plays: each picked at random in its range. */
  friends: [number, number]
  playMinutes: [number, number]
  idleMinutes: number
  /** What Fly says the server's machine is: `suspended` or `stopped` once it sleeps. */
  machineState: (serverId: string) => Promise<string>
  record: (step: StepRecord) => void
  chaos: (finding: ChaosFinding) => void
  /** Called before a server goes to the trash, which takes its machine and Fly's record of its runs. */
  beforeTrash: (serverId: string) => Promise<void>
  /** The share of people who are impatient or careless somewhere in their life. */
  aggression: number
}

/** How players spread over the templates: vanilla survival most, then Duels, Skyblock, OneBlock and the rest. */
const SPREAD: Array<[string, number]> = [
  ['survival', 40],
  ['duels', 14],
  ['skyblock', 12],
  ['oneblock', 10],
  ['creative', 8],
  ['smooth', 5],
  ['lifesteal', 4],
  ['hardcore', 4],
  ['manhunt', 3],
]

/** What a person does once their server has slept, and how often people do it. */
const FATES: Array<['back' | 'start and stop' | 'trash' | 'second server', number]> = [
  ['back', 34],
  ['start and stop', 25],
  ['trash', 25],
  ['second server', 16],
]

const between = (least: number, most: number) => least + Math.floor(Math.random() * (most - least + 1))
function weighted<T>(choices: ReadonlyArray<[T, number]>): T {
  let left = Math.random() * choices.reduce((sum, [, weight]) => sum + weight, 0)
  for (const [choice, weight] of choices) {
    left -= weight
    if (left < 0) return choice
  }
  return (choices[0] as [T, number])[0]
}
const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`
const seconds = (ms: number) => `${(ms / SECOND_MS).toFixed(1)}s`
const JOIN_LIMIT_MS = 5 * MINUTE_MS

interface Server {
  id: string
  name: string
  slug: string
  version: string
  trashed: boolean
}

export class Player {
  phase: Phase = 'signing up'
  failed = false
  #api: Api = async () => {
    throw new Error('no account yet')
  }
  #email = ''
  #password = ''
  /** The careless things this person does, by name, picked when they arrive. */
  readonly acts: string[]
  #servers: Server[] = []
  #template = ''
  readonly #plan: 'free' | 'plus'
  readonly index: number
  readonly run: Run

  /** A burst's person: friends counted for them, and a life that ends once they have played. */
  readonly #burst: { friends: number; burst: boolean } | undefined

  constructor(index: number, plan: 'free' | 'plus', run: Run, burst?: { friends: number; burst: boolean }) {
    this.#burst = burst
    this.index = index
    this.#plan = plan
    this.run = run
    this.acts = Math.random() < run.aggression ? pickActs(plan) : []
  }

  /** What an act needs of this person. */
  #hands(): Hands {
    return {
      index: this.index,
      plan: this.#plan,
      email: this.#email,
      password: this.#password,
      api: this.#api,
      key: this.run.key,
      view: (id) => this.#view(id),
      machineState: this.run.machineState,
      job: (job) => this.#job(job),
      auth: this.run.auth,
      mailpit: this.run.mailpit,
    }
  }

  /** The act of this person's from `acts`, if they picked one; what it found goes to the run. */
  async #chaos(acts: Record<string, Act>, server: Server | undefined): Promise<void> {
    const act = this.acts.find((name) => name in acts)
    const run = act === undefined ? undefined : acts[act]
    if (act === undefined || run === undefined) return
    const at = Date.now()
    const target = server ?? { id: '', name: '', slug: '', version: '', trashed: false }
    const found = await run(this.#hands(), target).catch((error: unknown) => ({
      did: `the act itself failed: ${(error as Error).message}`,
      verdict: 'stuck' as const,
      ...(server ? { server: server.id } : {}),
    }))
    this.run.chaos({ act, player: this.index, at, ...found })
  }

  /** The server as its owner's page shows it now, for the run's own chaos. */
  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely
  look(serverId: string): Promise<any> {
    return this.#view(serverId)
  }

  get servers(): readonly Server[] {
    return this.#servers
  }

  /** A step timed and kept; false when it failed. */
  async #step(
    step: string,
    run: () => Promise<Partial<StepRecord> | undefined>,
    server = this.#servers[0],
  ): Promise<boolean> {
    const at = Date.now()
    try {
      const extra = (await run()) ?? {}
      this.run.record({ ...this.#base(step, at, server?.id), ok: true, ms: Date.now() - at, ...extra })
      return true
    } catch (error) {
      const id = extra(error).server ?? server?.id
      const operation = id === undefined ? undefined : await this.#lastOperation(id).catch(() => undefined)
      this.run.record({
        ...this.#base(step, at, id),
        ok: false,
        ms: Date.now() - at,
        error: (error as Error).message,
        ...(operation ? { operation } : {}),
        ...extra(error),
      })
      this.failed = true
      return false
    }
  }

  #base(step: string, at: number, server: string | undefined): StepRecord {
    return {
      player: this.index,
      step,
      ok: false,
      ms: 0,
      at,
      plan: this.#plan,
      ...(server ? { server } : {}),
      ...(this.#template ? { template: this.#template } : {}),
    }
  }

  /** The server's newest operation, as its record says: kind, step, status and error. */
  #lastOperation(serverId: string): Promise<string> {
    return this.run.sql(
      `select kind || ' ' || status || coalesce(' at ' || (progress->>'step'), '') || coalesce(': ' || error, '') || coalesce(' [' || left(detail, 300) || ']', '')
       from server_operations where server_id = ${sqlText(serverId)} order by created_at desc limit 1`,
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the staging check reads it
  #view(serverId: string): Promise<any> {
    return this.#api('servers.get', { serverId }, 'GET')
  }

  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the staging check reads it
  async #waitFor(serverId: string, want: (v: any) => boolean, what: string, limitS: number): Promise<any> {
    const deadline = Date.now() + limitS * SECOND_MS
    // biome-ignore lint/suspicious/noExplicitAny: as above
    let last: any = null
    while (Date.now() < deadline) {
      last = await this.#view(serverId)
      if (want(last)) return last
      if (last.status === 'failed' || last.activeOperation?.status === 'failed')
        throw new Error(
          `it ${last.status}${last.activeOperation?.error ? `: ${last.activeOperation.error}` : ''}`,
        )
      await Bun.sleep(3 * SECOND_MS)
    }
    const op = last?.activeOperation
    throw new Error(
      `never ${what} within ${limitS}s; it was ${last?.status}${op ? `, ${op.kind} ${op.status} at ${op.step}` : ''}`,
    )
  }

  #ready(serverId: string, limitS = 900) {
    const running = (v: { status: string; activeOperation: unknown }) =>
      v.status === 'running' && v.activeOperation === null
    return this.#waitFor(serverId, running, 'running', limitS)
  }

  #settledStopped(serverId: string, limitS: number) {
    const stopped = (v: { status: string; activeOperation: unknown }) =>
      v.status === 'stopped' && v.activeOperation === null
    return this.#waitFor(serverId, stopped, 'stopped', limitS)
  }

  /** A probe's job on the least busy probe, its join attempts counted; a failure keeps them too. */
  async #job(job: Record<string, unknown>): Promise<JobAnswer & { retries: number }> {
    const answer = await leastBusy(this.run.probes).run(job)
    const retries = Math.max(0, (answer.attempts?.length ?? 1) - 1)
    if (answer.error !== undefined) {
      const turned = (answer.attempts ?? []).map((a) => a.ended).filter(Boolean)
      const why = turned.length > 0 ? `; attempts ended: ${[...new Set(turned)].slice(0, 3).join(' | ')}` : ''
      throw Object.assign(new Error(`${answer.error}${why}`), { retries })
    }
    return { ...answer, retries }
  }

  /** Whether its headless players can play: a plan that lets the owner turn off account checks. */
  #plays(): boolean {
    return this.#plan === 'plus'
  }

  /** A join timed at a probe: in the world where it plays, the server's answer where it can't. */
  #join(server: Server, name: string) {
    const address = `${server.slug}.play.staging.cubepals.com`
    const kind = this.#plays() ? 'join' : 'answer'
    return this.#job({ kind, address, name, version: server.version, timeoutMs: JOIN_LIMIT_MS })
  }

  /** Their life, start to end; a failure ends it only where a person would give up. */
  async live(): Promise<void> {
    try {
      const first = await this.#begin()
      if (first === undefined) return
      await this.#together(first)
      if (this.#burst?.burst) return
      const sleptAs = await this.#sleeps(first)
      await this.#chaos(ASLEEP, first)
      this.phase = 'away'
      const fate = weighted(FATES)
      if (fate === 'trash') await this.#trash(first)
      else if (fate === 'start and stop') await this.#startAndStop(first)
      else if (fate === 'second server' && this.#plays()) await this.#second()
      else await this.#back(first, sleptAs)
      await this.#chaos(ACCOUNT, undefined)
    } finally {
      this.phase = 'done'
    }
  }

  /** Signed up, on its plan, its first server made and running; undefined where they gave up. */
  async #begin(): Promise<Server | undefined> {
    this.#email = `load-${this.run.id}-${this.index}@${this.run.domain}`
    const signedUp = await this.#step('sign up', async () => {
      const person = await this.run.signUp(this.#email)
      this.#api = person.api
      this.#password = person.password
      return { note: this.#email }
    })
    if (!signedUp) return undefined
    const onPlan = await this.#step('put on its plan', async () => {
      // Cubepals' own test account, so the run takes none of staging's free places; and its plan
      // given as an operator comps one, without payment.
      await this.run.sql(
        `update account_standing set test_account = true, plan = ${sqlText(this.#plan)}
         where user_id = (select id from users where email = ${sqlText(this.#email)})`,
      )
      const { entitlements } = await this.#api('account.overview', {}, 'GET')
      if (entitlements.plan !== this.#plan) throw new Error(`the plan is ${entitlements.plan}`)
      return undefined
    })
    if (!onPlan) return undefined
    this.phase = 'making'
    await this.#chaos(MAKING, undefined)
    const options = await this.#api('servers.createOptions', {}, 'GET').catch(() => ({ templates: [] }))
    const allowed = new Set<string>(
      (options.templates as { key: string; fits: { allowed: boolean } }[])
        .filter((t) => t.fits.allowed)
        .map((t) => t.key),
    )
    this.#template = weighted(SPREAD.filter(([key]) => allowed.has(key)))
    return this.#make('make a server, until it is running', this.#template, `Load ${this.index}`)
  }

  /**
   * A server of the template made and running. Where its players play, it runs the newest release
   * of the template the headless players speak, chosen as the create page's version picker
   * offers it; the template's own newest otherwise.
   */
  async #make(step: string, template: string, name: string): Promise<Server | undefined> {
    let made: Server | undefined
    await this.#step(
      step,
      async () => {
        let gameVersion: string | undefined
        if (this.#plays()) {
          const spoken = new Set(await leastBusy(this.run.probes).versions())
          const releases = (await this.#api('servers.setupReleases', { key: template }, 'GET')) as {
            gameVersion: string
            runs: boolean
          }[]
          gameVersion = releases.find((r) => r.runs && spoken.has(r.gameVersion))?.gameVersion
        }
        const created = await this.#api('servers.create', {
          idempotencyKey: this.run.key(),
          name,
          from: { kind: 'template', key: template, ...(gameVersion ? { gameVersion } : {}) },
          partySize: this.#plays() ? '10' : '5',
          regionKey: 'eu',
        })
        const server = { id: created.id, name, slug: created.slug, version: '', trashed: false }
        this.#servers.push(server)
        const up = await this.#ready(created.id).catch((error: unknown) => {
          throw Object.assign(error as Error, { server: created.id })
        })
        server.version = up.gameVersion
        made = server
        return { server: created.id, template, note: `${up.memoryTier}, ${up.gameVersion} ${up.loader}` }
      },
      undefined,
    )
    return made
  }

  /**
   * The owner and their friends, each arriving at a random moment in the first few minutes and
   * playing their own random minutes, nobody waiting on anybody. A server that checks accounts is
   * only reached: a headless player has no account.
   */
  async #together(server: Server): Promise<void> {
    this.phase = 'playing'
    const friends = this.#burst?.friends ?? between(...this.run.friends)
    const names = [
      `Load${this.index}`,
      ...Array.from({ length: friends }, (_, j) => `Load${this.index}x${j + 1}`),
    ]
    if (this.#plays()) {
      const open = await this.#step('open it to friends (account checks off, whitelist)', async () => {
        const view = await this.#view(server.id)
        await this.#api('servers.changeAuthentication', {
          serverId: server.id,
          requestId: randomUUID(),
          version: view.version,
          onlineMode: false,
        })
        const applied = await this.#ready(server.id, 600)
        if (applied.settings.onlineMode !== false)
          throw new Error('account checks are still on after the change settled')
        const access = await this.#api('access.get', { serverId: server.id }, 'GET')
        if (access.whitelistEnabled || access.pendingWhitelistEnabled)
          for (const name of names) await this.#api('access.addToWhitelist', { serverId: server.id, name })
        return { note: `${friends} friends coming` }
      })
      // Without their friends let in, the owner leaves it be.
      if (!open) return
    }
    const careless = this.#plays()
      ? Bun.sleep(MINUTE_MS + Math.random() * MINUTE_MS).then(() => this.#chaos(PLAYING, server))
      : Promise.resolve()
    await Promise.all([
      careless,
      ...names.map(async (name, j) => {
        await Bun.sleep(j === 0 ? 0 : Math.random() * 3 * MINUTE_MS)
        const minutes = between(...this.run.playMinutes)
        const step = j === 0 ? 'the owner plays' : 'a friend plays'
        if (!this.#plays())
          return this.#step(`${step} (account checks on: reached, not played)`, async () => {
            const { result, retries } = await this.#join(server, name)
            return { retries, note: `answered in ${seconds(result.ms)}` }
          })
        return this.#step(step, async () => {
          const address = `${server.slug}.play.staging.cubepals.com`
          const job = {
            kind: 'play',
            address,
            name,
            version: server.version,
            minutes,
            timeoutMs: JOIN_LIMIT_MS,
          }
          const { result, retries } = await this.#job(job)
          if (result.dropped !== null)
            throw Object.assign(new Error(`dropped mid-play: ${result.dropped}`), { retries })
          const misses = [...new Set(result.misses as string[])].slice(0, 2).join('; ')
          return {
            retries,
            note: `${minutes} min; in after ${seconds(result.ms)}; walked ${result.walked}, ${result.chats} chats, ${result.dug} broken, ${result.placed} placed${misses ? `; game misses: ${misses}` : ''}`,
          }
        })
      }),
    ])
  }

  /** Left alone until the product puts it to sleep; how Fly kept it, `suspended` or `stopped`. */
  async #sleeps(server: Server): Promise<string> {
    const account = `user_id = (select id from users where email = ${sqlText(this.#email)})`
    let sleptAs = ''
    await this.#step('goes to sleep with nobody on', async () => {
      // The control plane's own idle check, on this account's idle time rather than the plan's, as
      // the staging check does; the account goes back to its plan's after.
      await this.run.sql(
        `update account_standing set limit_overrides = limit_overrides || '{"idleShutdownAfterMinutes": ${this.run.idleMinutes}}' where ${account}`,
      )
      try {
        const slept = await this.#settledStopped(server.id, 1500)
        if (slept.stopReason !== 'idle') throw new Error(`it stopped for ${slept.stopReason}`)
        this.phase = 'asleep'
        sleptAs = await this.run.machineState(server.id)
        return { note: `idle after ${this.run.idleMinutes} min on this account; its machine is ${sleptAs}` }
      } finally {
        await this.run.sql(
          `update account_standing set limit_overrides = limit_overrides - 'idleShutdownAfterMinutes' where ${account}`,
        )
      }
    })
    return sleptAs
  }

  /** How a server comes back, as the report keeps the two apart. */
  #wakeKind(sleptAs: string): string {
    return sleptAs === 'suspended' ? 'resumed from suspend' : 'a full boot'
  }

  /** A few minutes later, a player joins and wakes it, timed. */
  async #back(server: Server, sleptAs: string): Promise<void> {
    await Bun.sleep(between(2, 6) * MINUTE_MS)
    await this.#step(`wakes when a player joins (${this.#wakeKind(sleptAs)})`, async () => {
      const { result, retries } = await this.#join(server, `Load${this.index}`)
      return { retries, note: `the player waited ${seconds(result.ms)}` }
    })
  }

  /** Started from the website a few minutes later, joined, then stopped from the website. */
  async #startAndStop(server: Server): Promise<void> {
    await Bun.sleep(between(1, 4) * MINUTE_MS)
    const sleptAs = await this.run.machineState(server.id).catch(() => '')
    const started = await this.#step(`starts from the website (${this.#wakeKind(sleptAs)})`, async () => {
      await this.#api('servers.start', { serverId: server.id, requestId: randomUUID() })
      await this.#ready(server.id, 600)
      return undefined
    })
    if (!started) return
    await this.#step('a player joins after a start', async () => {
      const { result, retries } = await this.#join(server, `Load${this.index}`)
      return { retries, note: `in after ${seconds(result.ms)}` }
    })
    await this.#step('stops from the website', async () => {
      await this.#api('servers.stop', { serverId: server.id, requestId: randomUUID() })
      await this.#settledStopped(server.id, 600)
      return undefined
    })
  }

  /** A second server, which the plan allows them. */
  async #second(): Promise<void> {
    await Bun.sleep(between(1, 4) * MINUTE_MS)
    await this.#make('make a second server, until it is running', 'survival', `Load ${this.index} B`)
  }

  /** In the trash, as its owner sends it. */
  async #trash(server: Server, step = 'goes to the trash'): Promise<void> {
    await this.#step(
      step,
      async () => {
        await this.run.beforeTrash(server.id)
        await this.#api('servers.delete', { serverId: server.id, confirmName: server.name })
        server.trashed = true
        await this.#waitFor(
          server.id,
          (v) => v.status === 'deleted' && v.activeOperation === null,
          'deleted',
          600,
        )
        return { server: server.id }
      },
      server,
    )
  }

  /** What they left at the end of the run, in the trash so the run can purge it. */
  async tidy(): Promise<void> {
    for (const server of this.#servers.filter((s) => !s.trashed))
      await this.#trash(server, 'what was left goes to the trash at the end')
  }
}

type Act = (typeof MAKING)[string]

/** One or two careless acts, at different moments, at most one on making: Free makes three an hour. */
function pickActs(plan: 'free' | 'plus'): string[] {
  const shuffled = <T>(list: T[]) => list.sort(() => Math.random() - 0.5)
  const moments = shuffled([MAKING, ASLEEP, ACCOUNT, ...(plan === 'plus' ? [PLAYING] : [])])
  return moments.slice(0, between(1, 2)).map((acts) => shuffled(Object.keys(acts))[0] ?? '')
}

/** What a failure carries besides its words: the server it was about, the joins turned away. */
function extra(error: unknown): { server?: string; retries?: number } {
  const { server, retries } = error as { server?: string; retries?: number }
  return { ...(server === undefined ? {} : { server }), ...(retries === undefined ? {} : { retries }) }
}
