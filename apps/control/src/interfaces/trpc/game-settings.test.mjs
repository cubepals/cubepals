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
async function openGame({ online = false, stopped = false, keeps = false } = {}) {
  const dom = browserScope()
  const native = globalThis.fetch
  let h, root
  const mutations = []
  try {
    harness ??= startHarness()
    h = await harness
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner)
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
        await until(() => !document.querySelector('button[aria-busy="true"], button.bk-btn--danger'))
        // A completed save may have replaced its form while its button finishes working.
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

async function keepsItems() {
  const page = await openGame()
  try {
    const current = await page.settings()
    expect([...field('Difficulty').options].map((option) => option.textContent)).toEqual([
      'Peaceful',
      'Easy',
      'Normal',
      'Hard',
    ])
    expect([...field('Game mode').options].map((option) => option.textContent)).toEqual([
      'Survival',
      'Creative',
      'Adventure',
      'Spectator',
    ])
    for (const [label, key] of [
      ['Max players', 'maxPlayers'],
      ['Spawn protection', 'spawnProtection'],
      ['View distance', 'viewDistance'],
      ['Simulation distance', 'simulationDistance'],
    ]) {
      expect(field(label).value).toBe(String(current[key]))
      expect(field(label).inputMode).toBe('numeric')
    }
    expect(field('Difficulty').selectedOptions[0].textContent).toBe('Normal')
    expect(field('Game mode').selectedOptions[0].textContent).toBe('Survival')
    const toggle = document.querySelector('[aria-label="Keep items when you die"]')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle.click())
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    expect(document.body.textContent).toContain('nobody is sent away')
    expect(document.querySelector('dialog input[value="empty"]')).toBeNull()
    await act(async () => button('Save changes', document.querySelector('dialog')).click())
    await until(async () => (await page.settings()).keepInventory === true)
    await page.h.settled(page.server.id)
    expect(page.mutations.some((call) => call.path.endsWith('/servers.changeSettings'))).toBe(true)
  } finally {
    await page.close()
  }
}
async function turnsKeepingOff() {
  const page = await openGame({ keeps: true })
  try {
    const toggle = document.querySelector('[aria-label="Keep items when you die"]')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle.click())
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    await act(async () => button('Save changes', document.querySelector('dialog')).click())
    await until(async () => (await page.settings()).keepInventory === false)
  } finally {
    await page.close()
  }
}
async function cancels() {
  const page = await openGame()
  try {
    await act(async () => document.querySelector('[aria-label="Keep items when you die"]').click())
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    await act(async () => button('Cancel').click())
    await until(() => document.querySelector('dialog')?.open === false)
    expect(document.querySelector('dialog').open).toBe(false)
    expect((await page.settings()).keepInventory ?? false).toBe(false)
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
  }
}
async function undoes() {
  const page = await openGame()
  try {
    await act(async () => document.querySelector('[aria-label="Keep items when you die"]').click())
    await fill(page.browser, 'Spawn protection', '4')
    await act(async () => button('Undo changes').click())
    expect(
      document.querySelector('[aria-label="Keep items when you die"]').getAttribute('aria-checked'),
    ).toBe('false')
    expect(field('Spawn protection').value).toBe('0')
    expect(button('Save changes').disabled).toBe(true)
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
  }
}
async function liveRules() {
  const page = await openGame()
  try {
    await fill(page.browser, 'Difficulty', 'Hard')
    await fill(page.browser, 'Game mode', 'Creative')
    await act(async () => document.querySelector('[aria-label="PvP"]').click())
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    expect(document.body.textContent).toContain('The game takes the change as people play')
    await act(async () => button('Save changes', document.querySelector('dialog')).click())
    await until(async () => (await page.settings()).difficulty === 'hard')
    await page.h.settled(page.server.id)
    expect(page.h.minecraft.playing(page.server.id)).toMatchObject({
      difficulty: 'hard',
      defaultGameMode: 'creative',
      pvp: false,
    })
  } finally {
    await page.close()
  }
}
async function bounds() {
  const page = await openGame()
  try {
    for (const value of ['', '1.5', String(page.options.bounds.maxPlayers + 1)]) {
      await fill(page.browser, 'Max players', value)
      expect(button('Save changes').disabled).toBe(true)
      expect(document.body.textContent).toContain(`Choose 1 to ${page.options.bounds.maxPlayers}.`)
    }
    await fill(page.browser, 'Max players', '1')
    expect(button('Save changes').disabled).toBe(false)
    expect(page.mutations).toHaveLength(0)
  } finally {
    await page.close()
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
async function changesWhileStopped() {
  const page = await openGame({ stopped: true })
  try {
    await fill(page.browser, 'Spawn protection', '4')
    await act(async () => button('Save changes').click())
    await until(() => document.querySelector('dialog')?.open === true)
    expect(document.body.textContent).toContain('The change applies the next time the server starts')
    await act(async () => button('Save changes', document.querySelector('dialog')).click())
    await until(async () => (await page.settings()).spawnProtection === 4)
    expect(page.h.runtime.machine(page.server.id).state).toBe('stopped')
  } finally {
    await page.close()
  }
}

describe.skipIf(!hasDatabase)('editing game settings in the browser', () => {
  test('keeping items is off by default and can be enabled without a restart', keepsItems, 30 * SECOND_MS)
  test('keeping items can be disabled again', turnsKeepingOff, 30 * SECOND_MS)
  test('cancelling keeps the recorded settings', cancels, 30 * SECOND_MS)
  test('undo restores both switches and typed numbers', undoes, 30 * SECOND_MS)
  test('live game rules reach the real running game', liveRules, 30 * SECOND_MS)
  test('blank, fractional and out-of-bounds numbers cannot be saved', bounds, 30 * SECOND_MS)
  test('a startup setting submits the last chosen player-safe timing', waitsForPlayers, 30 * SECOND_MS)
  test('a stopped server keeps startup settings for its next start', changesWhileStopped, 30 * SECOND_MS)
})
