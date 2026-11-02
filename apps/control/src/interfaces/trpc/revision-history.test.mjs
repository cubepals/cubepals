// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Revision history reads real revisions, confirms rollbacks and retains artifact consent and timing. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { realtimeContract } from '@blockly/contracts/realtime'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { act, createElement, Fragment } from 'react'
import { Client } from 'transport-io'
import { History } from '../../../../web/src/app/(app)/servers/[id]/settings/history'
import { ChangeState } from '../../../../web/src/app/(app)/servers/[id]/settings/shared'
import { ApiProvider } from '../../../../web/src/lib/api'
import { loadRevision, setDesired } from '../../app/servers/persistence.ts'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { MEMORY_TIERS } from '../../domain/server/size.ts'
import { Cdn } from '../../testing/cdn.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { pluginJar } from '../../testing/uploads.ts'
import { appRouter } from './router.ts'

const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
const web = createRequire(new URL('../../../../web/package.json', import.meta.url))
const { TransportProvider } = web('@transport-io/react')
let harness,
  startedCdn = false
const cdn = new Cdn()
afterAll(async () => {
  await harness?.then((h) => h.close())
  cdn.close()
})

async function revisionsFixture({ count = 10, mode = 'stopped', artifacts = false } = {}) {
  harness ??= startHarness()
  const h = await harness,
    owner = await h.user('History owner', 'plus')
  const server = await h.create(owner, { loader: 'paper', gameVersion: '26.2' })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID())
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  const current = async () => loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
  let artifactTarget
  if (artifacts) {
    if (!startedCdn) {
      await cdn.start()
      startedCdn = true
    }
    h.catalog.publish(
      {
        projectId: 'history-iris',
        slug: 'history-iris',
        name: 'History Iris',
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'history-iris-1',
          projectId: 'history-iris',
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: ['26.2'],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file('history-iris', pluginJar('HistoryIris', 25)),
          dependencies: [],
        },
      ],
    )
    const change = { add: [{ projectId: 'history-iris' }] }
    const plan = await h.app.mods.plan(owner, server.id, change)
    if (plan.kind !== 'ok') throw new Error('The fixture plugin must fit')
    await h.app.mods.apply(
      owner,
      server.id,
      change,
      plan.mods.map((m) => m.artifact.sha512),
      crypto.randomUUID(),
    )
    artifactTarget = await current()
    await h.app.revisions.changeMods(
      owner,
      server.id,
      { basedOn: artifactTarget.id, mods: [] },
      crypto.randomUUID(),
    )
  }
  for (let index = 0; index < count; index++) {
    const revision = await current()
    await h.app.revisions.changeSettings(
      index === 0 ? { kind: 'admin', userId: owner.userId } : owner,
      server.id,
      {
        ...revision.settings,
        motd: index % 2 ? '&bOther world' : '&aSame world',
        difficulty: index % 2 ? 'hard' : 'easy',
      },
      crypto.randomUUID(),
    )
  }
  let queued, deliver
  if (mode !== 'stopped') {
    if (mode === 'failed') h.minecraft.breakOn(() => 'The fixture world did not start')
    await h.app.servers.start(owner, server.id, crypto.randomUUID())
    await h.until(server.id, mode === 'failed' ? 'failed' : 'running')
    await h.settled(server.id)
    if (mode === 'failed') h.minecraft.breakOn(() => null)
    if (mode === 'updating') {
      const enqueue = h.jobs.enqueue.bind(h.jobs)
      queued = spyOn(h.jobs, 'enqueue').mockResolvedValue()
      deliver = async () => {
        const pending = [...queued.mock.calls]
        queued.mockRestore()
        for (const args of pending) await enqueue(...args)
      }
      const revision = await current()
      await h.app.revisions.changeSettings(
        owner,
        server.id,
        { ...revision.settings, viewDistance: revision.settings.viewDistance + 1 },
        crypto.randomUUID(),
      )
    }
  }
  return { h, owner, server, artifactTarget, queued, current, deliver }
}
function browserScope() {
  const browser = new (quality('happy-dom').Window)({ url: 'http://localhost/settings' })
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    SVGElement: browser.SVGElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  return {
    browser,
    async close() {
      await browser.happyDOM.close()
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

async function until(ready) {
  const deadline = Date.now() + 5 * SECOND_MS
  let done = false
  while (!done && Date.now() < deadline)
    await act(async () => {
      await Bun.sleep(20)
      done = await ready()
    })
  expect(done).toBe(true)
}

function button(text) {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

const opened = () => document.querySelector('dialog')?.open === true
const backs = () =>
  [...document.querySelectorAll('button')].filter((item) => item.textContent.trim() === 'Go back to this')

async function openHistory(options = {}) {
  const dom = browserScope(),
    native = globalThis.fetch,
    calls = []
  let root, fixture, refused
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  if (!options.pause && !options.pauseWake) release()
  try {
    fixture = await revisionsFixture(options)
    const { h, owner, server } = fixture
    const view = await h.app.queries.get(owner, server.id)
    const actor = options.stranger ? await h.user('A different account', 'plus') : owner
    if (options.stranger) fixture.refusal = await h.app.queries.get(actor, server.id).catch((error) => error)
    if (options.refused) {
      const stranger = await h.user('Other owner', 'plus')
      const error = await h.app.queries.revisions(stranger, server.id).catch((error) => error)
      refused = spyOn(h.app.queries, 'revisions').mockRejectedValue(error)
      fixture.refusal = error
    }
    const routed = Object.assign(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
        if (!url.pathname.startsWith('/api/trpc')) return native(input, init)
        const request = new Request(url, init)
        if (request.method === 'POST') calls.push({ path: url.pathname, input: await request.clone().json() })
        if (
          url.pathname.includes('servers.revisions') ||
          (options.pauseWake && url.pathname.includes('servers.start'))
        )
          await gate
        return fetchRequestHandler({
          endpoint: '/api/trpc',
          req: request,
          router: appRouter,
          createContext: () => ({ actor, services: h.app }),
        })
      },
      { preconnect: native.preconnect },
    )
    globalThis.fetch = routed
    Object.defineProperty(dom.browser, 'fetch', { value: routed, configurable: true, writable: true })
    const client = new Client({
      contract: realtimeContract,
      connect: async () => {
        throw new Error('This fixture does not open realtime')
      },
    })
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const draw = (next) =>
      root.render(
        createElement(
          ApiProvider,
          null,
          createElement(
            TransportProvider,
            { client, autoConnect: false },
            createElement(
              Fragment,
              null,
              options.stateOnly ? null : createElement(History, { view: next }),
              options.withState || options.stateOnly ? createElement(ChangeState, { view: next }) : null,
            ),
          ),
        ),
      )
    await act(async () => draw(view))
    return {
      ...fixture,
      view,
      calls,
      host,
      release,
      async refresh(next) {
        await act(async () => draw(next ?? (await h.app.queries.get(owner, server.id))))
      },
      async close() {
        release()
        refused?.mockRestore()
        fixture.queued?.mockRestore()
        await act(async () => root.unmount())
        globalThis.fetch = native
        await dom.close()
      },
    }
  } catch (error) {
    release()
    refused?.mockRestore()
    fixture?.queued?.mockRestore()
    await act(async () => root?.unmount())
    globalThis.fetch = native
    await dom.close()
    throw error
  }
}
async function chooseTarget(page, predicate = (revision) => revision.fromCurrent.length > 0) {
  const revisions = await page.h.app.queries.revisions(page.owner, page.server.id)
  await until(() => backs().length > 0)
  const others = revisions.filter((r) => !r.desired)
  const index = others.findIndex(predicate)
  if (index < 0) throw new Error('The fixture must contain the requested earlier revision')
  if (index >= backs().length) await act(async () => button(`Show all ${revisions.length}`).click())
  await act(async () => backs()[index].click())
  return loadRevision(page.h.db, others[index].id)
}

describe.skipIf(!hasDatabase)('revision history in the browser', () => {
  test(
    'history loads the real list, expands it and renders messages without their formatting codes',
    async () => {
      const page = await openHistory({ pause: true })
      try {
        expect(page.host.textContent).toContain('History')
        expect(backs()).toHaveLength(0)
        page.release()
        const revisions = await page.h.app.queries.revisions(page.owner, page.server.id)
        await until(() => backs().length > 0)
        expect(backs().length).toBeLessThan(revisions.filter((r) => !r.desired).length)
        expect(page.host.textContent).toContain('Next start')
        expect(page.host.textContent).toContain('Same world')
        expect(page.host.textContent).not.toContain('&aSame world')
        await act(async () => button(`Show all ${revisions.length}`).click())
        expect(backs()).toHaveLength(revisions.filter((r) => !r.desired).length)
        expect(page.host.textContent).toContain('Last run')
        expect(page.host.textContent).toContain('by Cubepals')
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'cancel makes no request and accepting an older configuration persists its actual settings',
    async () => {
      const page = await openHistory()
      try {
        const before = await page.current()
        const target = await chooseTarget(page)
        expect(opened()).toBe(true)
        expect(page.host.textContent).toContain('Go back to this configuration?')
        await act(async () => button('Cancel').click())
        expect(opened()).toBe(false)
        expect(page.calls).toHaveLength(0)
        expect((await page.current()).id).toBe(before.id)
        await chooseTarget(page, (r) => r.id === target.id)
        await act(async () => button('Go back').click())
        await until(() => !opened())
        expect((await page.current()).settings).toEqual(target.settings)
        expect((await page.current()).id).not.toBe(target.id)
        expect(page.host.textContent).toContain('Went back')
        expect(JSON.stringify(page.calls.at(-1).input)).toContain('"when":"empty"')
        await page.refresh()
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a matching older configuration says so and does not manufacture a new revision',
    async () => {
      const page = await openHistory()
      try {
        const before = await page.current()
        await chooseTarget(page, (r) => r.fromCurrent.length === 0)
        expect(page.host.textContent).toContain('It’s the same configuration the server has now.')
        await act(async () => button('Go back').click())
        await until(() => !opened())
        expect((await page.current()).id).toBe(before.id)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a real read refusal is shown in the history section',
    async () => {
      const page = await openHistory({ count: 1, refused: true })
      try {
        await until(() => page.host.textContent.includes(page.refusal.message))
        expect(page.host.querySelector('[role="alert"]')?.textContent).toBe(page.refusal.message)
        expect(backs()).toHaveLength(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a running server identifies its applied revision',
    async () => {
      const page = await openHistory({ count: 1, mode: 'running' })
      try {
        await until(() => page.host.textContent.includes('Running now'))
        expect(backs().every((b) => !b.disabled)).toBe(true)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'work in progress shows applying and disables competing rollback requests',
    async () => {
      const page = await openHistory({ count: 1, mode: 'updating', withState: true })
      try {
        await until(() => page.host.textContent.includes('Applying'))
        expect(backs().length).toBeGreaterThan(0)
        expect(backs().every((b) => b.disabled)).toBe(true)
        expect(page.view.activeOperation?.kind).toBe('apply')
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a failed server offers rollback as recovery and preserves the choice on cancel',
    async () => {
      const page = await openHistory({ count: 2, mode: 'failed', withState: true })
      try {
        await chooseTarget(page)
        expect(page.host.textContent).toContain('The server starts again with this configuration.')
        await act(async () => button('Cancel').click())
        expect(opened()).toBe(false)
        expect(page.calls).toHaveLength(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'an older pinned artifact needs explicit consent before the real rollback can proceed',
    async () => {
      const page = await openHistory({ count: 0, artifacts: true })
      try {
        await chooseTarget(page, (r) => r.id === page.artifactTarget.id)
        page.h.catalog.setProjectState('history-iris', 'withheld')
        await page.h.app.catalog.refresh()
        await act(async () => button('Go back').click())
        await until(() =>
          [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Run it anyway'),
        )
        expect((await page.current()).mods).toHaveLength(0)
        await act(async () => button('Run it anyway').click())
        await until(() => !opened())
        const revision = await page.current()
        expect(revision.mods.map((mod) => mod.artifact.sha512)).toEqual(
          page.artifactTarget.mods.map((mod) => mod.artifact.sha512),
        )
        expect(revision.acknowledgedRevoked).toContain(page.artifactTarget.mods[0].artifact.sha512)
        expect(page.calls.filter((call) => call.path.includes('rollback'))).toHaveLength(2)
        expect(JSON.stringify(page.calls.at(-1).input)).toContain('"acknowledgeRevoked":true')
        expect(JSON.stringify(page.calls.at(-1).input)).toContain('"when":"empty"')
      } finally {
        page.h.catalog.setProjectState('history-iris', 'approved')
        await page.h.app.catalog.refresh()
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  describe('feedback for a saved server change', () => {
    test(
      'a change watched in progress announces completion after the real worker finishes',
      async () => {
        const page = await openHistory({ count: 1, mode: 'updating', stateOnly: true })
        try {
          expect(page.view.activeOperation?.kind).toBe('apply')
          await page.deliver()
          await page.h.until(page.server.id, 'running')
          await page.h.settled(page.server.id)
          await page.refresh()
          await until(() => page.host.textContent.includes('Your changes are in. Your friends see them now.'))
          expect(page.host.querySelector('[role="alert"]') === null).toBe(true)
        } finally {
          await page.close()
        }
      },
      30 * SECOND_MS,
    )

    test(
      'a failed apply that rolls back shows its actual error and no completion message',
      async () => {
        const page = await openHistory({ count: 1, mode: 'updating', stateOnly: true })
        try {
          const desired = await page.current()
          const wanted = String(desired.settings.viewDistance)
          page.h.minecraft.breakOn((env) =>
            env.VIEW_DISTANCE === wanted ? 'The fixture change failed' : null,
          )
          await page.deliver()
          await page.h.until(page.server.id, 'running')
          await page.h.settled(page.server.id)
          const next = await page.h.app.queries.get(page.owner, page.server.id)
          expect(next.lastChange?.status).toBe('failed')
          await page.refresh(next)
          expect(page.host.textContent).toContain(next.lastChange.error)
          expect(page.host.textContent).toContain('Last change')
          expect(page.host.textContent).not.toContain('Your changes are in.')
        } finally {
          page.h.minecraft.breakOn(() => null)
          await page.close()
        }
      },
      30 * SECOND_MS,
    )

    test(
      'a legacy size describes the plan adjustment before an owner accepts a rollback',
      async () => {
        const page = await openHistory({ count: 2, withState: true })
        try {
          const allowed = entitlementsFor('plus').allowedMemoryTiers
          const legacy = MEMORY_TIERS.find((tier) => !allowed.includes(tier))
          if (!legacy) throw new Error('The fixture needs a size outside this plan')
          await page.h.db.transaction(async (tx) =>
            setDesired(tx, await page.h.server(page.server.id), { memoryTier: legacy }),
          )
          const next = await page.h.app.queries.get(page.owner, page.server.id)
          expect(next.movesToSize).not.toBeNull()
          await page.refresh(next)
          await chooseTarget(page)
          expect(page.host.textContent).toContain(
            `Size ${Number.parseInt(legacy, 10)} GB → ${next.movesToSize.label}, the size your plan offers`,
          )
          expect(page.host.textContent).toContain('Your changes apply the next time the server starts.')
          await act(async () => button('Cancel').click())
          expect(opened()).toBe(false)
        } finally {
          await page.close()
        }
      },
      30 * SECOND_MS,
    )

    test(
      'a stale resting view can request a real wake and disables its button during delivery',
      async () => {
        const page = await openHistory({ count: 0, stateOnly: true, pauseWake: true })
        try {
          // The screen can still show a rest state after another request has made the world available.
          await page.refresh({ ...page.view, status: 'stored' })
          expect(page.host.textContent).toContain('Wake it to change this.')
          await act(async () => button('Wake it up').click())
          await until(() => page.calls.length === 1)
          expect(button('Waking it up…').disabled).toBe(true)
          page.release()
          await page.h.until(page.server.id, 'running')
          await page.h.settled(page.server.id)
          await until(() => [...page.host.querySelectorAll('button')].every((item) => !item.disabled))
          await page.refresh()
          expect(page.host.textContent).not.toContain('Wake it to change this.')
          expect(page.calls[0].path).toContain('servers.start')
        } finally {
          await page.close()
        }
      },
      30 * SECOND_MS,
    )

    test(
      'a stale storing view preserves a real authorization refusal instead of pretending it woke',
      async () => {
        const page = await openHistory({ count: 0, stateOnly: true, stranger: true })
        try {
          expect(page.refusal).toBeInstanceOf(Error)
          await page.refresh({ ...page.view, status: 'storing' })
          await act(async () => button('Wake it up').click())
          await until(() => page.host.textContent.includes(page.refusal.message))
          expect(page.host.querySelector('[role="alert"]')?.textContent).toBe(page.refusal.message)
          expect(button('Wake it up').disabled).toBe(false)
          expect((await page.h.server(page.server.id)).lifecycle.status).toBe('stopped')
        } finally {
          await page.close()
        }
      },
      30 * SECOND_MS,
    )
  })
})
