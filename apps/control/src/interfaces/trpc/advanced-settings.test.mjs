// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Authentication, server software and joining compatibility use their real browser controls and backend. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { ONLINE_MODE_KEPT } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { act, createElement } from 'react'
import { loadRevision } from '../../app/servers/persistence.ts'
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
  if (!done) console.error(document.body.textContent)
  expect(done).toBe(true)
}
function button(text, within = document) {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
async function openSettings({
  kind = 'advanced',
  loader = 'vanilla',
  online = false,
  stopped = false,
  plan = 'plus',
  authentication = true,
  paper = true,
  otherVersions,
  beforeView,
  beforePlaying,
} = {}) {
  const dom = browserScope(),
    native = globalThis.fetch,
    mutations = []
  let h, root
  try {
    harness ??= startHarness()
    h = await harness
    const owner = await h.user('Steve', plan),
      server = await h.create(owner, { loader, gameVersion: '26.2' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    if (!paper) {
      await h.app.mods.changeVersion(
        owner,
        server.id,
        { loader: 'vanilla', gameVersion: '26.2', onPaper: false },
        [],
        crypto.randomUUID(),
      )
      await h.settled(server.id)
    }
    if (!authentication) {
      await h.app.revisions.changeAuthentication(owner, server.id, false, crypto.randomUUID())
      await h.settled(server.id)
    }
    if (otherVersions !== undefined) {
      await h.app.revisions.changeOtherVersions(owner, server.id, otherVersions, crypto.randomUUID())
      await h.settled(server.id)
    }
    if (beforePlaying) await beforePlaying({ h, owner, server })
    if (online) {
      h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
      await h.app.schedules.presenceSync()
    }
    if (stopped) {
      await h.app.servers.stop(owner, server.id, crypto.randomUUID())
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
    }
    if (beforeView) await beforeView({ h, owner, server })
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
    const { createRoot } = await import('react-dom/client'),
      { ApiProvider } = await import('../../../../web/src/lib/api')
    const { Advanced } = await import('../../../../web/src/app/(app)/servers/[id]/settings/advanced')
    const { OtherVersionsSetting } = await import(
      '../../../../web/src/app/(app)/servers/[id]/settings/other-versions'
    )
    const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime')
    const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime')
    const Component = {
      advanced: Advanced,
      other: OtherVersionsSetting,
    }[kind]
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const router = {
      bfcacheId: '',
      back() {},
      forward() {},
      refresh() {},
      push() {},
      replace() {},
      prefetch() {},
    }
    await act(async () =>
      root.render(
        createElement(
          AppRouterContext.Provider,
          { value: router },
          createElement(
            PathnameContext.Provider,
            { value: `/servers/${server.id}/settings` },
            createElement(ApiProvider, null, createElement(Component, { view, options })),
          ),
        ),
      ),
    )
    return {
      h,
      owner,
      server,
      view,
      options,
      mutations,
      browser: dom.browser,
      revision: async () => loadRevision(h.db, (await h.server(server.id)).desiredRevisionId),
      async close() {
        await act(async () => {
          await Bun.sleep(SECOND_MS)
        })
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
function toggle(label) {
  const found = document.querySelector(`[aria-label="${label}"]`)
  if (!found) throw new Error(`Missing switch: ${label}`)
  return found
}
function dialog() {
  return [...document.querySelectorAll('dialog')].find((item) => item.open)
}
async function confirm(label) {
  await until(() => dialog()?.open === true)
  await act(async () => button(label, dialog()).click())
}
async function authentication(onlineMode, occupied = false) {
  const page = await openSettings({ authentication: !onlineMode, online: occupied, stopped: !occupied })
  try {
    await act(async () => toggle('Online authentication').click())
    await until(() => dialog()?.open === true)
    if (occupied) expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    expect(document.body.textContent).toContain(
      onlineMode ? 'Players are verified again' : 'Everyone who has played here starts over',
    )
    await confirm(onlineMode ? 'Turn it on' : 'Turn it off')
    await until(async () => (await page.revision()).settings.onlineMode === onlineMode)
    if (occupied) {
      expect((await page.h.app.queries.get(page.owner, page.server.id)).waiting).not.toBeNull()
      expect(JSON.stringify(page.mutations.at(-1).input)).toContain('"when":"empty"')
    }
  } finally {
    await page.close()
  }
}
async function freeAuthentication() {
  const page = await openSettings({ plan: 'free' })
  try {
    await until(() => document.body.textContent.includes(ONLINE_MODE_KEPT))
    expect(toggle('Online authentication').getAttribute('aria-disabled')).toBe('true')
    await act(async () => toggle('Online authentication').click())
    expect(dialog()).toBeUndefined()
    expect(toggle('Online authentication').getAttribute('aria-checked')).toBe('true')
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
  }
}
async function cancelAuthentication() {
  const page = await openSettings()
  try {
    await act(async () => toggle('Online authentication').click())
    await until(() => dialog()?.open === true)
    await act(async () => button('Keep it on', dialog()).click())
    expect(dialog()).toBeUndefined()
    expect((await page.revision()).settings.onlineMode).toBe(true)
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
  }
}
async function serverSoftware(paper) {
  const page = await openSettings({ paper: !paper, stopped: true })
  try {
    expect(toggle('Run on Paper').getAttribute('aria-checked')).toBe(String(!paper))
    await act(async () => toggle('Run on Paper').click())
    await confirm(paper ? 'Switch to Paper' : 'Switch to Mojang’s server')
    await until(async () => ((await page.revision()).loaderVersion !== null) === paper)
    expect((await page.revision()).loader).toBe('vanilla')
    expect(page.h.runtime.machine(page.server.id).state).toBe('stopped')
  } finally {
    await page.close()
  }
}
async function otherVersions(next, current = 'on') {
  const page = await openSettings({ kind: 'other', otherVersions: current, stopped: true })
  try {
    const label =
      next === 'oldest' || current === 'oldest'
        ? 'Let players on Minecraft 1.8 and 1.7 join'
        : 'Let players on other Minecraft versions join'
    await act(async () => toggle(label).click())
    await confirm(next === 'off' ? 'Only my version' : 'Let them in')
    await until(async () => (await page.revision()).settings.otherVersions === next)
    expect(page.mutations.at(-1).path).toContain('servers.changeOtherVersions')
  } finally {
    await page.close()
  }
}
async function moddedSettings() {
  const page = await openSettings({ kind: 'other', loader: 'fabric' })
  try {
    expect(document.body.textContent).toBe('')
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
  }
}
describe.skipIf(!hasDatabase)('advanced settings in the browser', () => {
  test('Free explains why authentication stays on', freeAuthentication, 30 * SECOND_MS)
  test('authentication can be restored while the server sleeps', () => authentication(true), 30 * SECOND_MS)
  test(
    'turning off authentication waits when someone is playing',
    () => authentication(false, true),
    30 * SECOND_MS,
  )
  test('cancelling leaves authentication on', cancelAuthentication, 30 * SECOND_MS)
  test('plain Minecraft can return to Mojang’s server', () => serverSoftware(false), 30 * SECOND_MS)
  test('plain Minecraft can return to Paper', () => serverSoftware(true), 30 * SECOND_MS)
  test(
    'the owner can restrict joining to the server’s own version',
    () => otherVersions('off'),
    30 * SECOND_MS,
  )
  test('the owner can reopen other versions', () => otherVersions('on', 'off'), 30 * SECOND_MS)
  test('the owner can include Minecraft 1.8 and 1.7', () => otherVersions('oldest'), 30 * SECOND_MS)
  test('the owner can stop allowing the oldest versions', () => otherVersions('on', 'oldest'), 30 * SECOND_MS)
  test('modded servers omit the incompatible joining switches', moddedSettings, 30 * SECOND_MS)
})
