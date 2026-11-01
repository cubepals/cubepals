// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real browser interactions exercise restart timing through the control plane and Postgres. */
import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { realtimeContract } from '@blockly/contracts/realtime'
import { act, createElement } from 'react'
import { Client } from 'transport-io'
import { fetchRequestHandler } from '../../../../../../../../node_modules/@trpc/server/adapters/fetch'
import { appRouter } from '../../../../../../../control/src/interfaces/trpc/router.ts'
import { Cdn } from '../../../../../../../control/src/testing/cdn.ts'
import { hasDatabase, startHarness } from '../../../../../../../control/src/testing/harness.ts'

const quality = createRequire(new URL('../../../../../../../../tools/quality/package.json', import.meta.url))
function browserScope() {
  const Window = quality('happy-dom').Window
  const browser = new Window({ url: 'http://localhost/servers/test/mods' })
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    history: browser.history,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    SVGElement: browser.SVGElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
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
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  return {
    browser,
    async close() {
      await browser.happyDOM.close()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
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
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function routeApi(h, owner, browser) {
  const original = globalThis.fetch
  const mutations = []
  const local = Object.assign(
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      if (!url.pathname.startsWith('/api/trpc')) return original(input, init)
      const request = new Request(url, init)
      if (request.method === 'POST')
        mutations.push({ path: url.pathname, input: await request.clone().json() })
      return fetchRequestHandler({
        endpoint: '/api/trpc',
        req: request,
        router: appRouter,
        createContext: () => ({ actor: owner, services: h.app }),
      })
    },
    { preconnect: original.preconnect },
  )
  globalThis.fetch = local
  Object.defineProperty(browser, 'fetch', { value: local, writable: true, configurable: true })
  return {
    mutations,
    close: () => {
      globalThis.fetch = original
    },
  }
}
async function draw(id) {
  const { createRoot } = await import('react-dom/client')
  const { TransportProvider } = await import('@transport-io/react')
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime')
  const { PathParamsContext, PathnameContext, SearchParamsContext } = await import(
    'next/dist/shared/lib/hooks-client-context.shared-runtime'
  )
  const { ApiProvider } = await import('../../../../../lib/api')
  const { default: Page } = await import('./page')
  const client = new Client({
    contract: realtimeContract,
    connect: async () => {
      throw new Error('This test does not open a realtime connection')
    },
  })
  const router = {
    bfcacheId: '',
    back() {},
    forward() {},
    refresh() {},
    push() {},
    replace() {},
    prefetch() {},
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(
          PathParamsContext.Provider,
          { value: { id } },
          createElement(
            PathnameContext.Provider,
            { value: `/servers/${id}/mods` },
            createElement(
              SearchParamsContext.Provider,
              { value: new URLSearchParams() },
              createElement(
                ApiProvider,
                null,
                createElement(TransportProvider, { client, autoConnect: false }, createElement(Page)),
              ),
            ),
          ),
        ),
      ),
    ),
  )
  return root
}
async function openMods({ online = true, loader = 'fabric' } = {}) {
  const dom = browserScope()
  const cdn = new Cdn()
  let h
  let root
  let api
  try {
    await cdn.start()
    h = await startHarness()
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner, { loader })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    if (online) {
      h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
      await h.app.schedules.presenceSync()
    }
    h.catalog.publish(
      {
        projectId: 'iris',
        slug: 'iris',
        name: 'Iris Shaders',
        summary: 'Iris, for tests',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'iris-1',
          projectId: 'iris',
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          publishedAt: new Date(),
          file: cdn.file('iris-1'),
          dependencies: [],
        },
      ],
    )
    api = routeApi(h, owner, dom.browser)
    root = await draw(server.id)
    await until(() => document.body.textContent?.includes('Iris Shaders') === true)
    const running = h
    const routed = api
    return {
      h: running,
      owner,
      server,
      mutations: routed.mutations,
      async plan() {
        await act(async () => button('Add').click())
        await until(() => !button('Apply and restart').disabled)
      },
      async close() {
        await act(async () => root?.unmount())
        routed.close()
        await running.close()
        cdn.close()
        await dom.close()
      },
    }
  } catch (error) {
    await act(async () => root?.unmount())
    api?.close()
    await h?.close()
    cdn.close()
    await dom.close()
    throw error
  }
}
async function waitsByDefault() {
  const page = await openMods()
  try {
    await page.plan()
    expect(document.body.textContent).toContain('Alex is online. This change restarts the server.')
    expect(document.querySelector('input[value="empty"]')?.checked).toBe(true)
    await act(async () => button('Apply and restart').click())
    await until(async () => (await page.h.app.queries.get(page.owner, page.server.id)).waiting !== null)
    await until(() => document.querySelector('dialog') === null)
    expect((await page.h.server(page.server.id)).lifecycle.status).toBe('running')
    expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(0)
    expect(page.mutations.some((call) => call.path.endsWith('/mods.change'))).toBe(true)
    expect(JSON.stringify(page.mutations.at(-1)?.input)).toContain('"when":"empty"')
  } finally {
    await page.close()
  }
}

async function cancels() {
  const page = await openMods()
  try {
    const before = await page.h.server(page.server.id)
    await page.plan()
    await act(async () => button('Cancel').click())
    expect(document.querySelector('dialog')).toBeNull()
    expect(page.mutations.filter((call) => call.path.endsWith('/mods.change'))).toHaveLength(0)
    expect((await page.h.server(page.server.id)).desiredRevisionId).toBe(before.desiredRevisionId)
    expect((await page.h.app.queries.get(page.owner, page.server.id)).players?.online).toBe(1)
  } finally {
    await page.close()
  }
}

async function changesItsMind() {
  const page = await openMods()
  try {
    await page.plan()
    await act(async () => document.querySelector('input[value="now"]').click())
    expect(document.querySelector('input[value="now"]').checked).toBe(true)
    expect(document.body.textContent).toContain('10-second countdown')
    await act(async () => document.querySelector('input[value="empty"]').click())
    expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    expect(document.body.textContent).toContain('Nobody is sent away.')
    await act(async () => button('Apply and restart').click())
    await until(async () => (await page.h.app.queries.get(page.owner, page.server.id)).waiting !== null)
    await until(() => document.querySelector('dialog') === null)
    expect(JSON.stringify(page.mutations.at(-1)?.input)).toContain('"when":"empty"')
  } finally {
    await page.close()
  }
}

async function restartsNow() {
  const page = await openMods()
  try {
    await page.plan()
    await act(async () => document.querySelector('input[value="now"]').click())
    await act(async () => button('Apply and restart').click())
    await until(async () => (await page.h.operations(page.server.id)).some((op) => op.kind === 'apply'))
    await act(async () => {
      await page.h.settled(page.server.id)
    })
    await until(() => document.querySelector('dialog') === null)
    expect(JSON.stringify(page.mutations.at(-1)?.input)).toContain('"when":"now"')
    expect((await page.h.app.queries.get(page.owner, page.server.id)).waiting).toBeNull()
    expect((await page.h.server(page.server.id)).lifecycle.status).toBe('running')
    expect(
      (await page.h.app.modQueries.list(page.owner, page.server.id)).mods.map((mod) => mod.name),
    ).toEqual(['Iris Shaders'])
  } finally {
    await page.close()
  }
}

async function nobodyOn() {
  const page = await openMods({ online: false })
  try {
    await page.plan()
    expect(document.querySelector('input[name="restart-when"]')).toBeNull()
    await act(async () => button('Apply and restart').click())
    await until(async () => (await page.h.operations(page.server.id)).some((op) => op.kind === 'apply'))
    await act(async () => {
      await page.h.settled(page.server.id)
    })
    await until(() => document.querySelector('dialog') === null)
    expect((await page.h.app.queries.get(page.owner, page.server.id)).waiting).toBeNull()
    expect(
      (await page.h.app.modQueries.list(page.owner, page.server.id)).mods.map((mod) => mod.name),
    ).toEqual(['Iris Shaders'])
  } finally {
    await page.close()
  }
}

async function movesVanilla() {
  const page = await openMods({ loader: 'vanilla' })
  try {
    await page.plan()
    expect(document.body.textContent).toContain('moves from Vanilla to Fabric')
    expect(document.body.textContent).toContain('Alex is online. This change restarts the server.')
    expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    await act(async () => button('Cancel').click())
    expect((await page.h.app.queries.get(page.owner, page.server.id)).loader).toBe('vanilla')
    expect(page.mutations.filter((call) => call.path.endsWith('/mods.change'))).toHaveLength(0)
  } finally {
    await page.close()
  }
}

describe.skipIf(!hasDatabase)('choosing a restart from the mods page', () => {
  test('adding a mod waits by default and keeps the player online', waitsByDefault, 30 * SECOND_MS)
  test('cancelling leaves the configuration and player alone', cancels, 30 * SECOND_MS)
  test('the last timing choice is submitted after changing it twice', changesItsMind, 30 * SECOND_MS)
  test('restart now applies the mod and finishes without a waiting change', restartsNow, 40 * SECOND_MS)
  test('an empty server applies immediately without asking about timing', nobodyOn, 30 * SECOND_MS)
  test('a vanilla migration offers the same player-safe timing choice', movesVanilla, 30 * SECOND_MS)
})
