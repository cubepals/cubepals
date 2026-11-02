// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Game settings are edited in a real DOM and submitted through the real router and database. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { act, createElement } from 'react'
import { loadRevision } from '../../app/servers/persistence.ts'
import { Cdn } from '../../testing/cdn.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
// Browser cases have separate servers; the file owns the database and final cleanup.
let harness
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})
function browserScope() {
  const Window = quality('happy-dom').Window
  const browser = new Window({ url: 'http://localhost/settings' })
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
    [...Object.keys(globals), 'setTimeout', 'clearTimeout'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  )
  const nativeTimeout = globalThis.setTimeout
  const nativeClear = globalThis.clearTimeout
  const pending = new Map()
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  return {
    browser,
    trackTimers() {
      // Observe real timers without changing their delays or swallowing callback failures.
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (typeof callback !== 'function') return nativeTimeout(callback, delay, ...args)
        let finish
        const done = new Promise((resolve) => {
          finish = resolve
        })
        const handle = nativeTimeout(
          (...values) => {
            try {
              return callback(...values)
            } finally {
              pending.delete(handle)
              finish()
            }
          },
          delay,
          ...args,
        )
        pending.set(handle, { delay: Math.max(0, Number(delay) || 0), done, finish })
        return handle
      }
      globalThis.clearTimeout = (handle) => {
        nativeClear(handle)
        pending.get(handle)?.finish()
        pending.delete(handle)
      }
      Object.defineProperties(globalThis.setTimeout, Object.getOwnPropertyDescriptors(nativeTimeout))
      Object.defineProperties(globalThis.clearTimeout, Object.getOwnPropertyDescriptors(nativeClear))
    },
    async settledTimers() {
      // Keep browser globals alive for existing feedback callbacks; long cache timers can stay unref'ed.
      await Promise.all(
        [...pending.values()].filter((timer) => timer.delay <= 5 * SECOND_MS).map((timer) => timer.done),
      )
    },
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
  if (!done) console.error(document.body.textContent)
  expect(done).toBe(true)
}
function button(text, within = document) {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function field(label) {
  const found = [...document.querySelectorAll('label')].find((item) => item.textContent.trim() === label)
  if (!found) throw new Error(`Missing field: ${label}`)
  return document.getElementById(found.htmlFor)
}
async function fill(browser, label, value) {
  const target = field(label)
  const prototype =
    target.localName === 'select' ? browser.HTMLSelectElement.prototype : browser.HTMLInputElement.prototype
  await act(async () => {
    if (target.localName === 'select') {
      const option = [...target.options].find((item) => item.textContent === value)
      if (!option) throw new Error(`Missing visible choice: ${value}`)
      value = option.value
    }
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, value)
    target.dispatchEvent(
      new browser.Event(target.localName === 'select' ? 'change' : 'input', { bubbles: true }),
    )
  })
}
async function openGame({
  online = false,
  stopped = false,
  keeps = false,
  loader = 'vanilla',
  beforeView,
} = {}) {
  const dom = browserScope()
  const native = globalThis.fetch
  let h, root
  const mutations = []
  try {
    harness ??= startHarness()
    h = await harness
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner, { loader })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    if (keeps) {
      const revision = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
      await h.app.revisions.changeSettings(
        owner,
        server.id,
        { ...revision.settings, keepInventory: true },
        crypto.randomUUID(),
      )
      await h.settled(server.id)
    }
    if (online) {
      h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
      await h.app.schedules.presenceSync()
    }
    if (stopped) {
      await h.app.servers.stop(owner, server.id, crypto.randomUUID())
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
    }
    await beforeView?.({ h, owner, server })
    const view = await h.app.queries.get(owner, server.id),
      options = await h.app.queries.settingsOptions(owner, server.id)
    const routed = Object.assign(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
        if (!url.pathname.startsWith('/api/trpc')) return native(input, init)
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
      { preconnect: native.preconnect },
    )
    globalThis.fetch = routed
    Object.defineProperty(dom.browser, 'fetch', { value: routed, writable: true, configurable: true })
    const { createRoot } = await import('react-dom/client')
    const { ApiProvider } = await import('../../../../web/src/lib/api')
    const { GameSettings } = await import('../../../../web/src/app/(app)/servers/[id]/settings/game')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    dom.trackTimers()
    await act(async () =>
      root.render(createElement(ApiProvider, null, createElement(GameSettings, { view, options }))),
    )
    return {
      h,
      owner,
      server,
      options,
      mutations,
      browser: dom.browser,
      async settings() {
        return (await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).settings
      },
      async close() {
        await act(async () => dom.settledTimers())
        await act(async () => root.unmount())
        globalThis.fetch = native
        await dom.close()
      },
    }
  } catch (error) {
    await act(async () => root?.unmount())
    globalThis.fetch = native
    await dom.close()
    throw error
  }
}

async function waitsForPlayers() {
  const page = await openGame({ online: true })
  try {
    await fill(page.browser, 'Spawn protection', '4')
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    await act(async () => document.querySelector('input[value="now"]').click())
    await act(async () => document.querySelector('input[value="empty"]').click())
    await act(async () => button('Save and restart', document.querySelector('dialog')).click())
    await until(async () => (await page.h.app.queries.get(page.owner, page.server.id)).waiting !== null)
    expect(JSON.stringify(page.mutations.at(-1).input)).toContain('"when":"empty"')
    expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(0)
  } finally {
    await page.close()
  }
}
async function withdrawnModWhileSaving() {
  const cdn = new Cdn()
  await cdn.start()
  let page
  try {
    page = await openGame({
      loader: 'fabric',
      stopped: true,
      beforeView: async ({ h, owner, server }) => {
        h.catalog.publish(
          {
            projectId: 'version-probe',
            slug: 'version-probe',
            name: 'Version Probe',
            summary: 'An installed mod without a newer release',
            iconUrl: null,
            environments: ['server_only'],
            downloads: 1,
          },
          [
            {
              versionId: 'version-probe-1',
              projectId: 'version-probe',
              versionLabel: '1',
              channel: 'release',
              state: 'listed',
              environment: 'server_only',
              loaders: ['fabric'],
              gameVersions: [
                (await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).gameVersion,
              ],
              publishedAt: new Date(),
              file: cdn.file('version-probe-1'),
              dependencies: [],
            },
          ],
        )
        const requested = { add: [{ projectId: 'version-probe' }] }
        const plan = await h.app.mods.plan(owner, server.id, requested)
        if (plan.kind !== 'ok') throw new Error('The fixture mod must fit the current version')
        await h.app.mods.apply(
          owner,
          server.id,
          requested,
          plan.mods.map((mod) => mod.artifact.sha512),
          crypto.randomUUID(),
        )
        await h.settled(server.id)
      },
    })
    page.h.catalog.setProjectState('version-probe', 'withheld')
    await page.h.app.catalog.refresh()
    const before = await page.settings()
    await fill(page.browser, 'Spawn protection', '4')
    await act(async () => button('Save changes').click())
    await act(async () => button('Save changes', document.querySelector('dialog')).click())
    await until(() =>
      [...document.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Run it anyway'),
    )
    expect(await page.settings()).toEqual(before)
    expect(page.mutations).toHaveLength(1)
    expect(Object.values(page.mutations[0].input)[0].acknowledgeRevoked).not.toBe(true)
    await act(async () => button('Run it anyway').click())
    await until(() => page.mutations.length === 2)
    expect(page.mutations).toHaveLength(2)
    expect(Object.values(page.mutations[1].input)[0]).toMatchObject({
      acknowledgeRevoked: true,
      when: 'empty',
    })
    await until(async () => (await page.settings()).spawnProtection === 4)
    const revision = await loadRevision(page.h.db, (await page.h.server(page.server.id)).desiredRevisionId)
    expect(revision.acknowledgedRevoked).toHaveLength(1)
    expect(page.h.runtime.machine(page.server.id).state).toBe('stopped')
  } finally {
    await page?.close()
    cdn.close()
  }
}
describe.skipIf(!hasDatabase)('game settings with withdrawn artifacts', () => {
  test('a startup setting submits the last chosen player-safe timing', waitsForPlayers, 30 * SECOND_MS)
  test(
    'saving settings asks again before running an installed mod that was withdrawn',
    withdrawnModWhileSaving,
    30 * SECOND_MS,
  )
})
