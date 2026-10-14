// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One virtual player of the load test, start to end, through the same public paths the website
 * uses: signs up and confirms through the mail catcher, is put on its plan, makes a server of a
 * template picked the way players spread, opens it to its headless players, plays a few minutes
 * (as many headless players as the run gives it, each its own), leaves it to sleep and wakes it with a join, stops and
 * starts it from the website and joins again, makes a second server where its plan allows, and
 * puts what it made in the trash.
 *
 * Every step is timed and kept, failed or not, with its server, the operation on it and the error
 * the product gave. Nothing is retried here: a join the edge turns away while a world wakes is
 * tried again by the probe, as a player clicks Join again, and every attempt is counted.
 *
 * Not for: running the probes (`load-probe-fleet.ts`), or the report (`load-report.ts`).
 */
import { randomUUID } from 'node:crypto'
import type { JobAnswer, Probe } from './load-probe-fleet.ts'
import type { Api } from './people.ts'

/** One step of one player, as the report reads it. */
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

/** Where a player is now, for the live line. */
export type Phase = 'signing up' | 'making' | 'ready' | 'playing' | 'asleep' | 'waking' | 'done' | 'failed'

/** What a player needs from the run. */
export interface Run {
  id: string
  domain: string
  /** A create key for one of this run's servers: the run's mark, then a random UUID's rest. */
  key: () => string
  signUp: (email: string) => Promise<{ api: Api }>
  sql: (statement: string) => Promise<string>
  playMinutes: number
  idleMinutes: number
  record: (step: StepRecord) => void
  /** Called before a server goes to the trash, which takes its machine and Fly's record of its runs. */
  beforeTrash: (serverId: string) => Promise<void>
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

/** A number in [0, 1) that is the same for the same player in every run, so runs compare. */
function steady(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

/** A template as players pick one: by the spread, among those their plan runs. */
function pickTemplate(index: number, allowed: ReadonlySet<string>): string {
  const choices = SPREAD.filter(([key]) => allowed.has(key))
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0)
  let left = steady(index) * total
  for (const [key, weight] of choices) {
    left -= weight
    if (left < 0) return key
  }
  return choices[0]?.[0] ?? 'survival'
}

const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`

export class Player {
  phase: Phase = 'signing up'
  accountMade = false
  hasPlayers = false
  failed = false
  #api: Api = async () => {
    throw new Error('no account yet')
  }
  #email = ''
  #servers: { id: string; name: string; slug: string }[] = []
  #template = ''
  /** The game version its server runs, which its headless players play. */
  #version = ''
  #plan: 'free' | 'plus'
  readonly index: number
  readonly run: Run
  /** Where each of its headless players runs, the first the one who made the server. */
  readonly probes: readonly Probe[]

  constructor(index: number, plan: 'free' | 'plus', run: Run, probes: readonly Probe[]) {
    this.index = index
    this.#plan = plan
    this.run = run
    this.probes = probes
  }

  /** The probe its owner plays from. */
  #own(): Probe {
    const probe = this.probes[0]
    if (probe === undefined) throw new Error('a player needs a probe')
    return probe
  }

  get servers(): readonly { id: string; name: string; slug: string }[] {
    return this.#servers
  }

  /** A step timed and kept; false when it failed, so what needs it is skipped. */
  async #step(step: string, run: () => Promise<Partial<StepRecord> | undefined>): Promise<boolean> {
    const at = Date.now()
    const server = this.#servers.at(-1)?.id
    try {
      const extra = (await run()) ?? {}
      this.run.record({ ...this.#base(step, at, server), ok: true, ms: Date.now() - at, ...extra })
      return true
    } catch (error) {
      const operation =
        server === undefined ? undefined : await this.#lastOperation(server).catch(() => undefined)
      this.run.record({
        ...this.#base(step, at, server),
        ok: false,
        ms: Date.now() - at,
        error: (error as Error).message,
        ...(operation ? { operation } : {}),
        ...((error as { retries?: number }).retries === undefined
          ? {}
          : { retries: (error as { retries: number }).retries }),
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
    const deadline = Date.now() + limitS * 1000
    // biome-ignore lint/suspicious/noExplicitAny: as above
    let last: any = null
    while (Date.now() < deadline) {
      last = await this.#view(serverId)
      if (want(last)) return last
      if (last.status === 'failed' || last.activeOperation?.status === 'failed')
        throw new Error(
          `it ${last.status}${last.activeOperation?.error ? `: ${last.activeOperation.error}` : ''}`,
        )
      await Bun.sleep(3000)
    }
    const op = last?.activeOperation
    throw new Error(
      `never ${what} within ${limitS}s; it was ${last?.status}${op ? `, ${op.kind} ${op.status} at ${op.step}` : ''}`,
    )
  }

  #ready(serverId: string, limitS = 900) {
    return this.#waitFor(
      serverId,
      (v) => v.status === 'running' && v.activeOperation === null,
      'running',
      limitS,
    )
  }

  /** A probe's job, its join attempts counted; a failure keeps them too. */
  async #job(probe: Probe, job: Record<string, unknown>): Promise<JobAnswer & { retries: number }> {
    const answer = await probe.run(job)
    const retries = Math.max(0, (answer.attempts?.length ?? 1) - 1)
    if (answer.error !== undefined) {
      const turned = (answer.attempts ?? []).map((a) => a.ended).filter(Boolean)
      const why = turned.length > 0 ? `; attempts ended: ${[...new Set(turned)].slice(0, 3).join(' | ')}` : ''
      throw Object.assign(new Error(`${answer.error}${why}`), { retries })
    }
    return { ...answer, retries }
  }

  #address(): string {
    return `${this.#servers[0]?.slug}.play.staging.cubepals.com`
  }

  /** Whether its headless players can play: a plan that lets the owner turn off account checks. */
  #plays(): boolean {
    return this.#plan === 'plus'
  }

  /** A join timed at the probe: in the world where it plays, the server's answer where it can't. */
  #join(name: string, timeoutMs: number) {
    const kind = this.#plays() ? 'join' : 'answer'
    return this.#job(this.#own(), { kind, address: this.#address(), name, version: this.#version, timeoutMs })
  }

  async journey(): Promise<void> {
    try {
      if (await this.#begin()) await this.#middle()
    } finally {
      await this.#trash()
      this.phase = this.failed ? 'failed' : 'done'
    }
  }

  /** Signed up, on its plan, its server made and running. */
  async #begin(): Promise<boolean> {
    this.#email = `load-${this.run.id}-${this.index}@${this.run.domain}`
    const signedUp = await this.#step('sign up', async () => {
      this.#api = (await this.run.signUp(this.#email)).api
      this.accountMade = true
      return { note: this.#email }
    })
    if (!signedUp) return false
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
    if (!onPlan) return false
    this.phase = 'making'
    return this.#step('make a server, until it is running', async () => {
      const options = await this.#api('servers.createOptions', {}, 'GET')
      const allowed = new Set<string>(
        (options.templates as { key: string; fits: { allowed: boolean } }[])
          .filter((t) => t.fits.allowed)
          .map((t) => t.key),
      )
      this.#template = pickTemplate(this.index, allowed)
      const gameVersion = await this.#spokenVersion(this.#template)
      const name = `Load ${this.index}`
      const created = await this.#api('servers.create', {
        idempotencyKey: this.run.key(),
        name,
        from: { kind: 'template', key: this.#template, ...(gameVersion ? { gameVersion } : {}) },
        partySize: this.#plan === 'free' ? '5' : this.probes.length > 10 ? '20' : '10',
        regionKey: 'eu',
      })
      this.#servers.push({ id: created.id, name, slug: created.slug })
      const up = await this.#ready(created.id)
      this.#version = up.gameVersion
      this.phase = 'ready'
      return {
        template: this.#template,
        server: created.id,
        note: `${up.memoryTier}, ${up.gameVersion} ${up.loader}`,
      }
    })
  }

  /**
   * Where its players play, the newest release of the template the headless player speaks, chosen
   * as the create page's version picker offers it; the template's own newest otherwise.
   */
  async #spokenVersion(template: string): Promise<string | undefined> {
    if (!this.#plays()) return undefined
    const spoken = new Set(await this.#own().versions())
    const releases = (await this.#api('servers.setupReleases', { key: template }, 'GET')) as {
      gameVersion: string
      runs: boolean
    }[]
    return releases.find((r) => r.runs && spoken.has(r.gameVersion))?.gameVersion
  }

  async #middle(): Promise<void> {
    const server = this.#servers[0]
    if (server === undefined) return
    // Its owner first, then the friends it plays with: only a server that lets them in has any.
    const names = (this.#plays() ? this.probes : this.probes.slice(0, 1)).map((_, j) =>
      j === 0 ? `Load${this.index}` : `Load${this.index}x${j}`,
    )
    if (this.#plays()) {
      const open = await this.#step('open it to its players (account checks off, whitelist)', async () => {
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
        return { note: access.whitelistEnabled ? 'whitelisted its players' : 'no whitelist' }
      })
      if (!open) return
    }
    if (!(await this.#playing(names))) return
    if (!(await this.#sleepsAndWakes(server.id))) return
    if (!(await this.#stopsAndStarts(server.id))) return
    await this.#second()
  }

  /** Its players' minutes on the server; a server that checks accounts is answered a while instead. */
  async #playing(names: string[]): Promise<boolean> {
    this.phase = 'playing'
    this.hasPlayers = true
    try {
      if (!this.#plays())
        return await this.#step('a player reaches it (account checks on, so no play)', async () => {
          const { result, retries } = await this.#join(names[0] ?? '', 300_000)
          return { retries, note: `answered in ${(result.ms / 1000).toFixed(1)}s` }
        })
      const sessions = names.map((name, i) =>
        this.#step(i === 0 ? 'play' : 'a friend plays', async () => {
          const probe = this.probes[i] ?? this.#own()
          const job = {
            kind: 'play',
            address: this.#address(),
            name,
            version: this.#version,
            minutes: this.run.playMinutes,
            timeoutMs: 300_000,
          }
          const { result, retries } = await this.#job(probe, job)
          if (result.dropped !== null)
            throw Object.assign(new Error(`dropped mid-play: ${result.dropped}`), { retries })
          const misses = [...new Set(result.misses as string[])].slice(0, 3).join('; ')
          return {
            retries,
            note: `in after ${(result.ms / 1000).toFixed(1)}s; walked ${result.walked}, ${result.chats} chats, ${result.dug} broken, ${result.placed} placed${misses ? `; game misses: ${misses}` : ''}`,
          }
        }),
      )
      return (await Promise.all(sessions))[0] ?? false
    } finally {
      this.hasPlayers = false
    }
  }

  /** Left alone until the product puts it to sleep, then woken by a join, timed. */
  async #sleepsAndWakes(serverId: string): Promise<boolean> {
    const account = `user_id = (select id from users where email = ${sqlText(this.#email)})`
    const asleep = await this.#step('goes to sleep with nobody on', async () => {
      // The control plane's own idle check, on this account's idle time rather than the plan's, as
      // the staging check does; the account goes back to its plan's after.
      await this.run.sql(
        `update account_standing set limit_overrides = limit_overrides || '{"idleShutdownAfterMinutes": ${this.run.idleMinutes}}' where ${account}`,
      )
      try {
        const slept = await this.#waitFor(
          serverId,
          (v) => v.status === 'stopped' && v.activeOperation === null,
          'asleep',
          1500,
        )
        if (slept.stopReason !== 'idle') throw new Error(`it stopped for ${slept.stopReason}`)
        this.phase = 'asleep'
        return { note: `idle after ${this.run.idleMinutes} min on this account` }
      } finally {
        await this.run.sql(
          `update account_standing set limit_overrides = limit_overrides - 'idleShutdownAfterMinutes' where ${account}`,
        )
      }
    })
    if (!asleep) return false
    this.phase = 'waking'
    return this.#step('wakes when a player joins', async () => {
      const { result, retries } = await this.#join(`Load${this.index}`, 300_000)
      await this.#ready(serverId, 300)
      this.phase = 'ready'
      return { retries, note: `the player waited ${(result.ms / 1000).toFixed(1)}s` }
    })
  }

  /** Stopped and started again from the website's actions, then joined. */
  async #stopsAndStarts(serverId: string): Promise<boolean> {
    const stopped = await this.#step('stops from the website', async () => {
      await this.#api('servers.stop', { serverId, requestId: randomUUID() })
      await this.#waitFor(
        serverId,
        (v) => v.status === 'stopped' && v.activeOperation === null,
        'stopped',
        600,
      )
      return undefined
    })
    if (!stopped) return false
    const started = await this.#step('starts from the website', async () => {
      await this.#api('servers.start', { serverId, requestId: randomUUID() })
      await this.#ready(serverId, 600)
      return undefined
    })
    if (!started) return false
    return this.#step('a player joins once more', async () => {
      const { result, retries } = await this.#join(`Load${this.index}`, 300_000)
      return { retries, note: `in after ${(result.ms / 1000).toFixed(1)}s` }
    })
  }

  /** A second server where the plan allows one. */
  async #second(): Promise<void> {
    const { entitlements } = await this.#api('account.overview', {}, 'GET')
    if (entitlements.maxServers < 2) return
    await this.#step('make a second server, until it is running', async () => {
      const name = `Load ${this.index} B`
      const created = await this.#api('servers.create', {
        idempotencyKey: this.run.key(),
        name,
        from: { kind: 'template', key: 'survival' },
        partySize: '5',
        regionKey: 'eu',
      })
      this.#servers.push({ id: created.id, name, slug: created.slug })
      await this.#ready(created.id)
      return { server: created.id, template: 'survival' }
    })
  }

  /** Everything it made, in the trash. */
  async #trash(): Promise<void> {
    for (const server of this.#servers)
      await this.#step('goes to the trash', async () => {
        await this.run.beforeTrash(server.id)
        await this.#api('servers.delete', { serverId: server.id, confirmName: server.name })
        await this.#waitFor(
          server.id,
          (v) => v.status === 'deleted' && v.activeOperation === null,
          'deleted',
          600,
        )
        return { server: server.id }
      })
  }
}
