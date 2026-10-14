// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The careless and impatient things people do, which the load test mixes into about a third of
 * its people's lives: pressing Create twice, Start, Stop and Start again within seconds, joining
 * again and again while a world wakes, trashing a server while it is still being made, editing it
 * while it wakes, two tabs at once, a friend giving up mid-join, names the product should refuse,
 * wrong passwords, a reset asked for twice. Each act says what the product did, and a verdict
 * from the person's side: whether they lost something, were stuck, saw a wrong state, were only
 * interrupted, or were fine.
 *
 * Not for: a person's ordinary life (`load-player.ts`), or the platform-wide chaos the run does
 * once each (`load-test.ts`).
 */
import { randomUUID } from 'node:crypto'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { JobAnswer } from './load-probe-fleet.ts'
import type { Api } from './people.ts'

/** From the person's side, worst first. */
export const VERDICTS = ['lost something', 'stuck', 'wrong state', 'interrupted', 'fine'] as const
type Verdict = (typeof VERDICTS)[number]

export interface ChaosFinding {
  act: string
  player: number | null
  server?: string
  /** What the product did, in a line. */
  did: string
  verdict: Verdict
  at: number
}

/** What an act needs of the person doing it. */
export interface Hands {
  index: number
  plan: 'free' | 'plus'
  email: string
  password: string
  api: Api
  key: () => string
  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the staging check reads it
  view: (serverId: string) => Promise<any>
  machineState: (serverId: string) => Promise<string>
  job: (job: Record<string, unknown>) => Promise<JobAnswer & { retries: number }>
  /** Sign-in and its mail, as the website's own pages call them. */
  auth: (path: string, body: unknown) => Promise<Response>
  mailpit: string
}

/** A server as an act gets it: the person's own, running or asleep. */
interface Target {
  id: string
  name: string
  slug: string
  version: string
}

type Act = (h: Hands, server: Target) => Promise<Omit<ChaosFinding, 'act' | 'player' | 'at'>>

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const address = (server: Target) => `${server.slug}.play.staging.cubepals.com`

/** Until nothing is under way on it, or `limitS` passes: the view then, or null if it never settled. */
// biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely
async function settle(h: Hands, serverId: string, limitS = 600): Promise<any> {
  const deadline = Date.now() + limitS * SECOND_MS
  while (Date.now() < deadline) {
    const view = await h.view(serverId)
    if (view.activeOperation === null) return view
    await Bun.sleep(3 * SECOND_MS)
  }
  return null
}

/** Whether what the website says agrees with Fly's machine. */
async function agrees(h: Hands, serverId: string, status: string): Promise<string | null> {
  const fly = await h.machineState(serverId).catch(() => 'unread')
  const running = status === 'running'
  const flyRunning = fly === 'started'
  return running === flyRunning ? null : `the website says ${status}, Fly says ${fly}`
}

/** A throwaway server of this person's, made and put in the trash by an act. */
async function made(h: Hands, name: string, key = h.key(), template = 'survival') {
  return h.api('servers.create', {
    idempotencyKey: key,
    name,
    from: { kind: 'template', key: template },
    partySize: '5',
    regionKey: 'eu',
  })
}
async function trashed(h: Hands, id: string, name: string): Promise<void> {
  await h.api('servers.delete', { serverId: id, confirmName: name }).catch(() => undefined)
  await settle(h, id, 600).catch(() => null)
}

/** Acts on making a server: each makes its own and trashes it, so the person's own goes on. */
export const MAKING: Record<string, Act> = {
  'Create pressed twice': async (h) => {
    const key = h.key()
    const name = `Load ${h.index} twice`
    const answers = await Promise.allSettled([made(h, name, key), made(h, name, key)])
    const ids = [...new Set(answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value.id as string] : [])))]
    for (const id of ids) await trashed(h, id, name)
    const refused = answers.flatMap((a) => (a.status === 'rejected' ? [messageOf(a.reason)] : []))
    if (ids.length > 1) return { did: `made ${ids.length} servers from one click`, verdict: 'wrong state' }
    if (ids.length === 0) return { did: `made none: ${refused.join(' | ')}`, verdict: 'stuck' }
    return {
      server: ids[0],
      did: `made one server${refused.length ? `; the second click was told: ${refused[0]}` : ''}`,
      verdict: 'fine',
    }
  },
  'trashed while it was being made': async (h) => {
    const name = `Load ${h.index} gone`
    const created = await made(h, name)
    await Bun.sleep(5 * SECOND_MS)
    await h.api('servers.delete', { serverId: created.id, confirmName: name })
    const view = await settle(h, created.id, 900)
    if (view === null) return { server: created.id, did: 'never settled after the trash', verdict: 'stuck' }
    const fly = await h.machineState(created.id).catch(() => 'none')
    if (view.status !== 'deleted')
      return { server: created.id, did: `ended ${view.status}, not in the trash`, verdict: 'wrong state' }
    if (fly === 'started')
      return {
        server: created.id,
        did: 'in the trash, its machine still running on Fly',
        verdict: 'wrong state',
      }
    return { server: created.id, did: `in the trash, its machine ${fly}`, verdict: 'fine' }
  },
  'two creates at once on one account': async (h) => {
    const names = [`Load ${h.index} C1`, `Load ${h.index} C2`]
    const answers = await Promise.allSettled(names.map((name) => made(h, name)))
    const { entitlements } = await h.api('account.overview', {}, 'GET')
    const ids = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value.id as string] : []))
    const refused = answers.flatMap((a) => (a.status === 'rejected' ? [messageOf(a.reason)] : []))
    for (const [i, a] of answers.entries())
      if (a.status === 'fulfilled') await trashed(h, a.value.id, names[i] ?? '')
    if (ids.length > entitlements.maxServers)
      return { did: `made ${ids.length}, past the plan's ${entitlements.maxServers}`, verdict: 'wrong state' }
    return {
      did: `made ${ids.length}${refused.length ? `; refused: ${refused.join(' | ')}` : ''}`,
      verdict: 'fine',
    }
  },
  'switched template right after creating': async (h) => {
    const first = `Load ${h.index} S1`
    const a = await made(h, first, h.key(), 'survival')
    await Bun.sleep(2 * SECOND_MS)
    await h.api('servers.delete', { serverId: a.id, confirmName: first })
    const second = `Load ${h.index} S2`
    const b = await made(h, second, h.key(), 'creative')
    const up = await settle(h, b.id, 900)
    await trashed(h, b.id, second)
    await settle(h, a.id, 300)
    if (up === null) return { server: b.id, did: 'the second server never settled', verdict: 'stuck' }
    if (up.status !== 'running')
      return { server: b.id, did: `the second ended ${up.status}`, verdict: 'wrong state' }
    return { server: b.id, did: 'the first went to the trash and the second came up', verdict: 'fine' }
  },
  'names it should refuse, or keep as typed': async (h) => {
    const tries: Array<[string, string, string | undefined]> = [
      ['empty', '', undefined],
      ['too long', 'L'.repeat(80), undefined],
      ['emoji', `🎮 Load ${h.index} ✨`, undefined],
      ['a held address', 'Admin', 'admin'],
    ]
    const said: string[] = []
    let verdict: Verdict = 'fine'
    for (const [what, name, slug] of tries) {
      try {
        const created = await h.api('servers.create', {
          idempotencyKey: h.key(),
          name,
          ...(slug ? { slug } : {}),
          from: { kind: 'template', key: 'survival' },
          partySize: '5',
          regionKey: 'eu',
        })
        const view = await h.view(created.id)
        said.push(`${what}: made as "${view.name}" at ${created.slug}`)
        if (what === 'empty' || what === 'too long' || created.slug === slug) verdict = 'wrong state'
        if (what === 'emoji' && view.name !== name.trim()) verdict = 'lost something'
        await trashed(h, created.id, view.name)
      } catch (error) {
        const message = messageOf(error)
        said.push(`${what}: ${message.slice(0, 120)}`)
        // A refusal people read is a sentence; a validator's dump or a server error is not.
        if (what === 'emoji' || /internal|\[\{|"code"/i.test(message)) verdict = 'stuck'
      }
    }
    return { did: said.join('; '), verdict }
  },
}

/** Acts on a person's own server, once it sleeps. */
export const ASLEEP: Record<string, Act> = {
  'Start, Stop and Start again within seconds': async (h, server) => {
    for (const action of ['start', 'stop', 'start'] as const) {
      await h
        .api(`servers.${action}`, { serverId: server.id, requestId: randomUUID() })
        .catch(() => undefined)
      await Bun.sleep(2 * SECOND_MS)
    }
    const view = await settle(h, server.id, 900)
    if (view === null) return { server: server.id, did: 'never settled', verdict: 'stuck' }
    const wrong = await agrees(h, server.id, view.status)
    if (wrong !== null) return { server: server.id, did: wrong, verdict: 'wrong state' }
    if (view.status !== 'running')
      return {
        server: server.id,
        did: `ended ${view.status}: the last click, Start, was lost`,
        verdict: 'wrong state',
      }
    return { server: server.id, did: 'ended running, as the last click asked', verdict: 'fine' }
  },
  'stopped while it starts': async (h, server) => {
    await h.api('servers.start', { serverId: server.id, requestId: randomUUID() })
    await Bun.sleep(3 * SECOND_MS)
    const stop = await h.api('servers.stop', { serverId: server.id, requestId: randomUUID() }).then(
      () => 'taken',
      (error: unknown) => `refused: ${messageOf(error)}`,
    )
    const view = await settle(h, server.id, 900)
    if (view === null) return { server: server.id, did: `stop ${stop}; never settled`, verdict: 'stuck' }
    const wrong = await agrees(h, server.id, view.status)
    if (wrong !== null) return { server: server.id, did: wrong, verdict: 'wrong state' }
    const verdict = view.status === 'stopped' || stop !== 'taken' ? 'fine' : 'wrong state'
    return { server: server.id, did: `stop ${stop}; ended ${view.status}`, verdict }
  },
  'joins spammed while it wakes': async (h, server) => {
    const kind = h.plan === 'plus' ? 'join' : 'answer'
    await Promise.all(
      [0, 1, 2].map(() =>
        h.api('servers.start', { serverId: server.id, requestId: randomUUID() }).catch(() => undefined),
      ),
    )
    const joins = await Promise.allSettled(
      [0, 1, 2].map((j) =>
        h.job({
          kind,
          address: address(server),
          name: `Load${h.index}s${j}`,
          version: server.version,
          timeoutMs: 5 * MINUTE_MS,
          againMs: SECOND_MS,
        }),
      ),
    )
    const inside = joins.filter((j) => j.status === 'fulfilled').length
    const tries = joins.reduce((sum, j) => sum + (j.status === 'fulfilled' ? j.value.retries + 1 : 0), 0)
    const view = await settle(h, server.id, 300)
    if (inside < joins.length)
      return { server: server.id, did: `${inside} of ${joins.length} got in`, verdict: 'stuck' }
    const wrong = view === null ? 'never settled' : await agrees(h, server.id, view.status)
    if (wrong !== null) return { server: server.id, did: wrong, verdict: 'wrong state' }
    return { server: server.id, did: `all got in, after ${tries} tries between them`, verdict: 'fine' }
  },
  'renamed and edited while it wakes': async (h, server) => {
    await h.api('servers.start', { serverId: server.id, requestId: randomUUID() })
    await Bun.sleep(2 * SECOND_MS)
    const name = `Load ${h.index} renamed`
    const description = `Edited while waking ${h.index}`
    const motd = `Edited motd ${h.index}`
    const said: string[] = []
    await h
      .api('servers.saveIdentity', { serverId: server.id, name, description, icon: 'stone' })
      .catch((error: unknown) => said.push(`identity refused: ${messageOf(error)}`))
    const before = await h.view(server.id)
    await h
      .api('servers.changeSettings', {
        serverId: server.id,
        requestId: randomUUID(),
        version: before.version,
        settings: { ...before.settings, motd, difficulty: 'hard', onlineMode: undefined },
      })
      .catch((error: unknown) => said.push(`settings refused: ${messageOf(error)}`))
    const view = await settle(h, server.id, 900)
    if (view === null)
      return { server: server.id, did: `never settled; ${said.join('; ')}`, verdict: 'stuck' }
    server.name = view.name
    const lost = [
      ...(view.name === name || said.some((s) => s.startsWith('identity')) ? [] : ['the name']),
      ...(view.settings.motd === motd || said.some((s) => s.startsWith('settings')) ? [] : ['the message']),
    ]
    if (lost.length > 0)
      return {
        server: server.id,
        did: `taken, then ${lost.join(' and ')} went back`,
        verdict: 'lost something',
      }
    return {
      server: server.id,
      did: `ended ${view.status}; ${said.join('; ') || 'both kept'}`,
      verdict: 'fine',
    }
  },
  'the same account in two tabs': async (h, server) => {
    const before = await h.view(server.id)
    const tabs = await Promise.allSettled([
      h.api('servers.start', { serverId: server.id, requestId: randomUUID() }),
      h.api('servers.changeSettings', {
        serverId: server.id,
        requestId: randomUUID(),
        version: before.version,
        settings: { ...before.settings, pvp: !before.settings.pvp, onlineMode: undefined },
      }),
    ])
    const said = tabs.map(
      (t, i) =>
        `${i === 0 ? 'start' : 'settings'} ${t.status === 'fulfilled' ? 'taken' : `refused: ${messageOf(t.reason)}`}`,
    )
    const view = await settle(h, server.id, 900)
    if (view === null)
      return { server: server.id, did: `never settled; ${said.join('; ')}`, verdict: 'stuck' }
    const wrong = await agrees(h, server.id, view.status)
    if (wrong !== null) return { server: server.id, did: wrong, verdict: 'wrong state' }
    const kept = tabs[1]?.status !== 'fulfilled' || view.settings.pvp !== before.settings.pvp
    return {
      server: server.id,
      did: `${said.join('; ')}; ended ${view.status}`,
      verdict: kept ? 'fine' : 'lost something',
    }
  },
}

/** Acts while friends play on a running server. */
export const PLAYING: Record<string, Act> = {
  'a friend gives up mid-join': async (h, server) => {
    const name = `Load${h.index}q`
    const gave = await h.job({
      kind: 'abandon',
      address: address(server),
      name,
      version: server.version,
      afterMs: 300 + Math.random() * 2700,
    })
    await Bun.sleep(30 * SECOND_MS)
    const view = await h.view(server.id)
    const ghost = (view.players?.people ?? []).some((p: { name: string }) => p.name === name)
    if (ghost)
      return {
        server: server.id,
        did: `left ${gave.result.left}, still listed as on`,
        verdict: 'wrong state',
      }
    const again = await h.job({
      kind: 'join',
      address: address(server),
      name,
      version: server.version,
      timeoutMs: 2 * MINUTE_MS,
    })
    return {
      server: server.id,
      did: `left ${gave.result.left}; joined again after ${again.retries + 1} tries`,
      verdict: 'fine',
    }
  },
}

/** Acts on the account, at the end of a life: they change its password. */
export const ACCOUNT: Record<string, Act> = {
  'wrong password several times': async (h) => {
    const said: number[] = []
    for (let i = 0; i < 6; i++)
      said.push((await h.auth('sign-in/email', { email: h.email, password: `wrong-${i}` })).status)
    const right = await h.auth('sign-in/email', { email: h.email, password: h.password })
    const retry = right.headers.get('x-retry-after') ?? right.headers.get('retry-after')
    if (!right.ok)
      return {
        did: `wrong ones answered ${said.join(', ')}; the right one then ${right.status}${retry ? `, wait ${retry}s` : ''}`,
        verdict: right.status === 429 ? 'stuck' : 'wrong state',
      }
    return { did: `wrong ones answered ${said.join(', ')}; the right one let them in`, verdict: 'fine' }
  },
  'a reset asked for twice': async (h) => {
    for (let i = 0; i < 2; i++)
      await h.auth('request-password-reset', { email: h.email, redirectTo: '/reset-password' })
    await Bun.sleep(3 * SECOND_MS)
    const found = (await (
      await fetch(`${h.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${h.email}" subject:reset`)}`)
    ).json()) as { messages: { ID: string }[] }
    const tokens: string[] = []
    for (const { ID } of found.messages.slice(0, 2)) {
      const { Text } = (await (await fetch(`${h.mailpit}/api/v1/message/${ID}`)).json()) as { Text: string }
      const token = /reset-password\/([^?/\s]+)/.exec(Text)?.[1]
      if (token) tokens.push(token)
    }
    if (tokens.length === 0) return { did: 'no reset mail came', verdict: 'stuck' }
    // The older mail first, as someone opening their inbox from the top of the thread would.
    const password = `reset-${randomUUID()}`
    const answers: number[] = []
    for (const token of [...tokens].reverse())
      answers.push((await h.auth('reset-password', { newPassword: password, token })).status)
    const signIn = await h.auth('sign-in/email', { email: h.email, password })
    const did = `${tokens.length} mails; the links answered ${answers.join(', ')} (older first); signing in with the new password ${signIn.status}`
    return { did, verdict: signIn.ok ? 'fine' : 'stuck' }
  },
}
