// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Players and moderation changes use the real browser, router, notifications and database. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { REMOVAL_MESSAGES, SetLadderInput } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { realtimeContract } from '@blockly/contracts/realtime'
import { schema } from '@blockly/db'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { eq } from 'drizzle-orm'
import { act, createElement } from 'react'
import { Client } from 'transport-io'
import { z } from 'zod'
import { ModerationService } from '../../app/moderation/service.ts'
import { loadStopCheaters, saveStopCheaters } from '../../app/stop-cheaters/persistence.ts'
import { CHATSENTINEL, LIBERTYBANS, LUCKPERMS } from '../../minecraft/moderation.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

let harness
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})
const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
function browserScope(origin = 'http://localhost') {
  const Window = quality('happy-dom').Window
  const browser = new Window({ url: new URL('/servers/test/players', origin).href })
  const NativeRequest = browser.Request
  // Happy DOM's XHR passes an existing Request as RequestInit. Use its standard clone overload
  // so the known body length survives; the real S3 service still verifies the bytes.
  browser.Request = class extends NativeRequest {
    constructor(input, init) {
      if (init instanceof NativeRequest && init.url === String(input)) super(init)
      else super(input, init)
    }
  }
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
    XMLHttpRequest: browser.XMLHttpRequest,
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
async function until(ready, timeout = 5 * SECOND_MS) {
  const deadline = Date.now() + timeout
  let done = false
  while (!done && Date.now() < deadline)
    await act(async () => {
      await Bun.sleep(20)
      done = await ready()
    })
  if (!done) console.error(document.body.textContent?.slice(-2000))
  expect(done).toBe(true)
}
function button(text) {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function routeApi(owner, browser, services) {
  const original = globalThis.fetch
  const mutations = []
  const local = Object.assign(
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), browser.location.origin)
      if (!url.pathname.startsWith('/api/trpc')) return original(input, init)
      const request = new Request(url, init)
      if (request.method === 'POST')
        mutations.push({ path: url.pathname, input: await request.clone().json() })
      const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req: request,
        router: appRouter,
        createContext: () => ({ actor: owner, services }),
      })
      return response
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
  // Resolve the browser provider from the workspace that declares and runs it.
  const web = createRequire(new URL('../../../../web/package.json', import.meta.url))
  const { TransportProvider } = web('@transport-io/react')
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime')
  const { PathParamsContext, PathnameContext, SearchParamsContext } = await import(
    'next/dist/shared/lib/hooks-client-context.shared-runtime'
  )
  const { ApiProvider } = await import('../../../../web/src/lib/api')
  const { default: Page } = await import('../../../../web/src/app/(app)/servers/[id]/players/page')
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
            { value: `/servers/${id}/players` },
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
function publishTools(h, cdn) {
  for (const projectId of [LIBERTYBANS, LUCKPERMS, CHATSENTINEL])
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name: projectId,
        summary: 'Moderation fixture',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: offeredVersions().map((version) => version.id),
          publishedAt: new Date(),
          file: cdn.file(projectId),
          dependencies: [],
        },
      ],
    )
}
async function openPlayers({
  online = false,
  people = ['Alex'],
  away = false,
  stopped = false,
  loader = 'paper',
  tools = false,
  filter = false,
  cheaters,
} = {}) {
  const dom = browserScope(),
    cdn = new Cdn()
  let h, root, api
  try {
    harness ??= startHarness()
    h = await harness
    await cdn.start()
    publishTools(h, cdn)
    const owner = await h.user('Steve', 'plus'),
      server = await h.create(owner, { loader, gameVersion: '26.2' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const moderation = new ModerationService({
      db: h.db,
      events: h.events,
      policy: h.app.policy,
      transitions: h.app.transitions,
      mods: h.app.mods,
    })
    if (tools) {
      await moderation.setTools(owner, server.id, { enabled: true, chatFilter: filter }, crypto.randomUUID())
      await h.settled(server.id)
    }
    if (cheaters !== undefined) {
      await h.app.stopCheaters.set(owner, server.id, cheaters, crypto.randomUUID())
      await h.settled(server.id)
    }
    if (online || away) {
      const profiles = []
      for (const name of people) {
        const profile = await h.profiles.byName(name)
        if (!profile) throw new Error('A fixture player must exist in the local profile service')
        profiles.push(profile)
        h.minecraft.join(server.id, profile)
      }
      await h.app.schedules.presenceSync()
      if (away) {
        for (const profile of profiles) h.minecraft.leave(server.id, profile.uuid)
        await h.app.schedules.presenceSync()
      }
    }
    if (stopped) {
      await h.app.servers.stop(owner, server.id, crypto.randomUUID())
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
    }
    api = routeApi(owner, dom.browser, { ...h.app, moderation })
    const reload = async () => {
      if (root) await act(async () => root.unmount())
      document.body.replaceChildren()
      root = await draw(server.id)
      await until(
        () =>
          document.body.textContent.includes('Operators') &&
          document.body.textContent.includes('Banned players'),
      )
      await until(() =>
        loader === 'fabric'
          ? document.body.textContent.includes('Mods change how players move')
          : [...document.querySelectorAll('[role="switch"]')].some((item) =>
              item.textContent.includes('Moderation tools'),
            ),
      )
    }
    await reload()
    return {
      h,
      owner,
      server,
      moderation,
      mutations: api.mutations,
      browser: dom.browser,
      reload,
      access: () => h.app.queries.access(owner, server.id),
      async close() {
        await until(() => !document.querySelector('button[aria-busy="true"], button.bk-btn--danger'))
        await act(async () => {
          await Bun.sleep(SECOND_MS)
        })
        await act(async () => root.unmount())
        api.close()
        cdn.close()
        await dom.close()
      },
    }
  } catch (error) {
    await act(async () => root?.unmount())
    api?.close()
    cdn.close()
    await dom.close()
    throw error
  }
}
function switchButton(label) {
  const found = [...document.querySelectorAll('[role="switch"]')].find(
    (item) => item.textContent.trim() === label || item.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`Missing switch: ${label}`)
  return found
}
function openDialog() {
  return [...document.querySelectorAll('dialog')].find((item) => item.open)
}
function insideButton(label, scope) {
  const found = [...scope.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function choose(browser, select, label) {
  const option = [...select.options].find((item) => item.textContent === label)
  if (!option) throw new Error(`Missing visible option: ${label}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, 'value').set.call(
      select,
      option.value,
    )
    select.dispatchEvent(new browser.Event('change', { bubbles: true }))
  })
}
function escalation() {
  return [...document.querySelectorAll('details')].find((item) =>
    item.querySelector('summary')?.textContent.includes('What each offence gets'),
  )
}
async function changeEscalation(reset = false) {
  const page = await openPlayers({ tools: true, stopped: true })
  try {
    const original = (await page.moderation.view(page.owner, page.server.id)).ladder
    const first = escalation().querySelector('select')
    await choose(page.browser, first, 'Mute')
    await choose(page.browser, first, 'Ban')
    await choose(page.browser, first, 'Warning')
    await choose(page.browser, first, 'Mute')
    const duration = first.closest('.bk-row').querySelectorAll('select')[1]
    await choose(page.browser, duration, 'For good')
    await act(async () => insideButton('Save', escalation()).click())
    await until(async () => (await page.moderation.view(page.owner, page.server.id)).ownLadder)
    expect((await page.moderation.view(page.owner, page.server.id)).ladder).toEqual([
      { kind: 'mute', minutes: null },
      ...original.slice(1),
    ])
    if (reset) {
      await until(() => escalation().textContent.includes('Use Cubepals’ steps'))
      await act(async () => insideButton('Use Cubepals’ steps', escalation()).click())
      await until(async () => !(await page.moderation.view(page.owner, page.server.id)).ownLadder)
      expect((await page.moderation.view(page.owner, page.server.id)).ladder).toEqual(original)
    }
  } finally {
    await page.close()
  }
}
async function escalationLimits() {
  const page = await openPlayers({ tools: true, stopped: true })
  try {
    const original = (await page.moderation.view(page.owner, page.server.id)).ladder
    const maximum = z
      .toJSONSchema(SetLadderInput, { io: 'input' })
      .properties.ladder.anyOf.find((item) => item.type === 'array').maxItems
    for (let index = original.length; index < maximum; index++)
      await act(async () => insideButton('Add a step', escalation()).click())
    expect(escalation().textContent).not.toContain('Add a step')
    for (let index = maximum; index > 1; index--)
      await act(async () => insideButton('Remove', escalation()).click())
    expect(escalation().textContent).not.toContain('Remove')
    await act(async () => insideButton('Cancel', escalation()).click())
    expect((await page.moderation.view(page.owner, page.server.id)).ladder).toEqual(original)
    expect(escalation().querySelectorAll('select').length).toBeGreaterThan(1)
  } finally {
    await page.close()
  }
}
async function refusedTools(online) {
  const page = await openPlayers({ online })
  try {
    expect(document.body.textContent).toContain('Turning these on or off restarts the server.')
    page.h.catalog.outage(true)
    await act(async () => switchButton('Moderation tools').click())
    if (online) {
      await until(() => openDialog()?.open)
      expect(openDialog().querySelector('h2').textContent).toBe('Change the moderation tools?')
      expect(document.body.textContent).toContain(
        'Someone is playing, so you choose whether it waits for everyone to leave.',
      )
      await act(async () => insideButton('Save', openDialog()).click())
    }
    await until(() => document.querySelector('.bk-note--danger') !== null)
    expect((await page.moderation.view(page.owner, page.server.id)).enabled).toBe(false)
    page.h.catalog.outage(false)
    if (online) {
      await until(() =>
        [...openDialog().querySelectorAll('button')].some((item) => item.textContent.trim() === 'Save'),
      )
      await act(async () => insideButton('Save', openDialog()).click())
    } else await act(async () => switchButton('Moderation tools').click())
    await until(async () => (await page.moderation.view(page.owner, page.server.id)).enabled)
  } finally {
    page.h.catalog.outage(false)
    await page.close()
  }
}
async function stopCheaters(on, online = false) {
  const page = await openPlayers({ stopped: !online, online, cheaters: !on })
  try {
    await page.h.app.stopCheaters.set(page.owner, page.server.id, !on, crypto.randomUUID())
    await page.reload()
    expect(switchButton('Stop cheaters').getAttribute('aria-checked')).toBe(String(!on))
    if (!online) expect(document.body.textContent).toContain('They arrive when the server next starts.')
    await act(async () => switchButton('Stop cheaters').click())
    if (online) {
      expect(openDialog()?.open).toBe(true)
      expect(openDialog().querySelector('h2').textContent).toBe(
        on ? 'Turn on Stop cheaters?' : 'Turn off Stop cheaters?',
      )
      expect(document.querySelector('input[value="empty"]').checked).toBe(true)
      await act(async () => insideButton('Cancel', openDialog()).click())
      expect((await loadStopCheaters(page.h.db, page.server.id)).setting).toBe(on ? 'off' : 'on')
      await act(async () => switchButton('Stop cheaters').click())
      await act(async () => insideButton(on ? 'Turn it on' : 'Turn it off', openDialog()).click())
      await until(() => page.mutations.some((call) => call.path.includes('moderation.setStopCheaters')))
      const submitted = page.mutations.findLast((call) => call.path.includes('moderation.setStopCheaters'))
      expect(Object.values(submitted.input)[0]).toMatchObject({ on, when: 'empty' })
    }
    await until(
      async () => (await loadStopCheaters(page.h.db, page.server.id)).setting === (on ? 'on' : 'off'),
    )
    await until(() => switchButton('Stop cheaters').getAttribute('aria-checked') === String(on))
  } finally {
    await page.close()
  }
}
async function ownCheaters(refused = false, online = false) {
  const page = await openPlayers({ stopped: !online, online })
  try {
    await saveStopCheaters(page.h.db, page.server.id, { setting: 'on' })
    const [row] = await page.h.db
      .select()
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, page.server.id))
    if (!row?.applied) throw new Error('The fixture must retain its applied configuration')
    await page.h.db
      .update(schema.serverRuntimes)
      .set({ applied: { ...row.applied, stopCheaters: 'own' } })
      .where(eq(schema.serverRuntimes.serverId, page.server.id))
    await page.reload()
    expect(document.body.textContent).toContain('On, with your own Grim settings.')
    if (refused)
      await page.h.db
        .update(schema.accountStanding)
        .set({ status: 'terminated' })
        .where(eq(schema.accountStanding.userId, page.owner.userId))
    await act(async () => button('Use Cubepals’ settings').click())
    if (online) {
      expect(openDialog()?.open).toBe(true)
      expect(openDialog().querySelector('h2').textContent).toBe('Use Cubepals’ Stop cheaters settings?')
      expect((await loadStopCheaters(page.h.db, page.server.id)).takeOver).toBe(false)
      await act(async () => insideButton('Use Cubepals’ settings', openDialog()).click())
      await until(() => page.mutations.some((call) => call.path.includes('moderation.useOurStopCheaters')))
      const submitted = page.mutations.findLast((call) => call.path.includes('moderation.useOurStopCheaters'))
      expect(Object.values(submitted.input)[0].when).toBe('empty')
    }
    if (refused) {
      await until(() => document.body.textContent.includes('This account is closed.'))
      expect((await loadStopCheaters(page.h.db, page.server.id)).takeOver).toBe(false)
      await page.h.db
        .update(schema.accountStanding)
        .set({ status: 'active' })
        .where(eq(schema.accountStanding.userId, page.owner.userId))
      await until(() =>
        [...document.querySelectorAll('button')].some(
          (item) => item.textContent.trim() === 'Use Cubepals’ settings',
        ),
      )
      await act(async () => button('Use Cubepals’ settings').click())
    }
    await until(async () => (await loadStopCheaters(page.h.db, page.server.id)).takeOver)
  } finally {
    await page.close()
  }
}
async function closedAccountChange(kind) {
  const page = await openPlayers({ tools: true, stopped: true })
  try {
    const before = await page.moderation.view(page.owner, page.server.id)
    const cheatersBefore = await loadStopCheaters(page.h.db, page.server.id)
    await page.h.db
      .update(schema.accountStanding)
      .set({ status: 'terminated' })
      .where(eq(schema.accountStanding.userId, page.owner.userId))
    if (kind === 'ladder') {
      await choose(page.browser, escalation().querySelector('select'), 'Mute')
      await act(async () => insideButton('Save', escalation()).click())
    } else {
      await act(async () => switchButton('Stop cheaters').click())
    }
    await until(() => document.body.textContent.includes('This account is closed.'))
    expect(openDialog()).toBeUndefined()
    const after = await page.moderation.view(page.owner, page.server.id)
    expect(after.ladder).toEqual(before.ladder)
    expect(await loadStopCheaters(page.h.db, page.server.id)).toEqual(cheatersBefore)
  } finally {
    await page.h.db
      .update(schema.accountStanding)
      .set({ status: 'active' })
      .where(eq(schema.accountStanding.userId, page.owner.userId))
    await page.close()
  }
}
async function removals(count) {
  const page = await openPlayers({ stopped: true })
  try {
    const alex = await page.h.profiles.byName('Alex'),
      reasons = Object.keys(REMOVAL_MESSAGES)
    if (!alex) throw new Error('Alex must have a profile')
    await saveStopCheaters(page.h.db, page.server.id, { setting: 'on', reason: 'browse' })
    for (let index = 0; index < count; index++)
      await page.h.db.insert(schema.serverRemovals).values({
        serverId: page.server.id,
        playerUuid: alex.uuid,
        playerName: index === 0 ? 'Alex' : '',
        reason: reasons[index % reasons.length],
        at: new Date(Date.now() - MINUTE_MS - index * SECOND_MS),
      })
    await page.reload()
    expect(document.body.textContent).toContain('Cubepals turned this on when your server joined Browse.')
    expect(document.body.textContent).toContain('Removed by Stop cheaters')
    expect(document.body.textContent).toContain(`${count} today.`)
    if (count > 1) expect(document.body.textContent).toContain('A player')
    expect(document.body.textContent).not.toContain('You can rejoin.')
    expect(
      [...document.querySelectorAll('a')].some((item) =>
        item.getAttribute('href')?.includes(`/servers/${page.server.id}/players/`),
      ),
    ).toBe(true)
  } finally {
    await page.close()
  }
}
async function occupiedChatFilter() {
  const page = await openPlayers({ online: true, tools: true })
  const appliesBefore = (await page.h.operations(page.server.id)).filter(
    (operation) => operation.kind === 'apply',
  ).length
  try {
    await act(async () => switchButton('Filter chat').click())
    expect(openDialog()?.open).toBe(true)
    expect(openDialog().querySelector('h2').textContent).toBe('Change the chat filter?')
    expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    await act(async () => insideButton('Cancel', openDialog()).click())
    expect((await page.moderation.view(page.owner, page.server.id)).chatFilter).toBe(false)
    expect(page.mutations.filter((call) => call.path.includes('moderation.setTools'))).toHaveLength(0)
    await act(async () => switchButton('Filter chat').click())
    await act(async () => insideButton('Save', openDialog()).click())
    await until(() => page.mutations.some((call) => call.path.includes('moderation.setTools')))
    const submitted = page.mutations.findLast((call) => call.path.includes('moderation.setTools'))
    expect(Object.values(submitted.input)[0]).toMatchObject({
      enabled: true,
      chatFilter: true,
      when: 'empty',
    })
    await until(async () => (await page.moderation.view(page.owner, page.server.id)).chatFilter)
    expect(
      (await page.h.operations(page.server.id)).filter((operation) => operation.kind === 'apply'),
    ).toHaveLength(appliesBefore)
  } finally {
    await page.close()
  }
}
describe.skipIf(!hasDatabase)('moderation controls in the browser', () => {
  test(
    'an occupied server confirms a chat filter change and retains the choice after cancel',
    occupiedChatFilter,
    30 * SECOND_MS,
  )
  test(
    'an occupied server can choose when Stop cheaters turns on',
    () => stopCheaters(true, true),
    30 * SECOND_MS,
  )
  test(
    'an occupied server can choose when Stop cheaters turns off',
    () => stopCheaters(false, true),
    30 * SECOND_MS,
  )
  test(
    'an occupied server confirms replacing its own Grim configuration',
    () => ownCheaters(false, true),
    30 * SECOND_MS,
  )
  test('a refused Grim settings replacement can be retried', () => ownCheaters(true), 30 * SECOND_MS)
  test('the escalation edits kinds and permanent durations', () => changeEscalation(false), 30 * SECOND_MS)
  test('the owner can return to Cubepals’ escalation', () => changeEscalation(true), 30 * SECOND_MS)
  test(
    'escalation stays within its limits and cancelling restores its steps',
    escalationLimits,
    30 * SECOND_MS,
  )
  test('an empty server shows a real catalog outage and can retry', () => refusedTools(false), 30 * SECOND_MS)
  test(
    'an occupied server keeps its dialog open after a refused change',
    () => refusedTools(true),
    30 * SECOND_MS,
  )
  test('Stop cheaters can be enabled for the next start', () => stopCheaters(true), 30 * SECOND_MS)
  test('Stop cheaters can be disabled again', () => stopCheaters(false), 30 * SECOND_MS)
  test('the owner can replace their own Grim configuration', () => ownCheaters(false), 30 * SECOND_MS)
  test(
    'a refused escalation displays the real policy error',
    () => closedAccountChange('ladder'),
    30 * SECOND_MS,
  )
  test(
    'a refused Stop cheaters change displays the real policy error',
    () => closedAccountChange('cheaters'),
    30 * SECOND_MS,
  )
  test('a single removal names the player and its reason', () => removals(1), 30 * SECOND_MS)
  test('multiple removals retain the unnamed-player fallback', () => removals(2), 30 * SECOND_MS)
})
