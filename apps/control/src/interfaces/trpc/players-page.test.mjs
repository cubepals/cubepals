// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Players and moderation changes use the real browser, router, notifications and database. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { realtimeContract } from '@blockly/contracts/realtime'
import { schema } from '@blockly/db'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { eq } from 'drizzle-orm'
import { act, createElement } from 'react'
import { Client } from 'transport-io'
import { upsertEntry } from '../../app/access/persistence.ts'
import { ModerationService } from '../../app/moderation/service.ts'
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
        await until(() => !document.querySelector('button[aria-busy="true"]'))
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
function nameField(label) {
  const found = [...document.querySelectorAll('label')].find((item) => item.textContent.trim() === label)
  if (!found) throw new Error(`Missing field: ${label}`)
  return document.getElementById(found.htmlFor)
}
async function fillName(browser, label, value) {
  const input = nameField(label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new browser.Event('input', { bubbles: true }))
  })
  return input.closest('form')
}
async function emptyPlayers() {
  const page = await openPlayers()
  try {
    expect(document.body.textContent).toContain("Nobody's online right now")
    expect(document.body.textContent).toContain('Invite your friends')
    expect(document.body.textContent).toContain('No operators yet.')
    expect(document.body.textContent).toContain('Nobody is banned.')
    expect(switchButton('Only people I add can join').getAttribute('aria-checked')).toBe('false')
    expect(switchButton('Moderation tools').getAttribute('aria-checked')).toBe('false')
  } finally {
    await page.close()
  }
}
async function playersPresence(away) {
  const page = await openPlayers({ online: !away, away })
  try {
    expect(document.body.textContent).toContain(away ? 'Who has played here' : 'Online now')
    const player = [...document.querySelectorAll('a')].find((item) => item.textContent.includes('Alex'))
    expect(player?.getAttribute('href')).toContain(`/servers/${page.server.id}/players/`)
    if (!away) expect(document.body.textContent).toContain('Playing now')
  } finally {
    await page.close()
  }
}
async function cancelTools() {
  const page = await openPlayers({ online: true })
  try {
    await act(async () => switchButton('Moderation tools').click())
    await until(() => openDialog()?.open === true)
    expect(document.querySelector('input[value="empty"]').checked).toBe(true)
    expect(openDialog().textContent).toContain('Change the moderation tools?')
    await act(async () => insideButton('Cancel', openDialog()).click())
    expect(openDialog()).toBeUndefined()
    expect(page.mutations.some((call) => call.path.endsWith('moderation.setTools'))).toBe(false)
  } finally {
    await page.close()
  }
}
async function toolsTiming(when) {
  const page = await openPlayers({ online: true })
  try {
    await act(async () => switchButton('Moderation tools').click())
    await until(() => openDialog()?.open === true)
    await act(async () => openDialog().querySelector(`input[value="${when}"]`).click())
    await act(async () => insideButton('Save', openDialog()).click())
    await until(async () => (await page.moderation.view(page.owner, page.server.id)).enabled)
    expect(
      JSON.stringify(page.mutations.find((call) => call.path.endsWith('moderation.setTools')).input),
    ).toContain(`"when":"${when}"`)
    if (when === 'empty')
      expect((await page.h.app.queries.get(page.owner, page.server.id)).waiting).not.toBeNull()
  } finally {
    await page.close()
  }
}
async function chatFilter() {
  const page = await openPlayers({ tools: true, stopped: true })
  try {
    expect(switchButton('Filter chat').getAttribute('aria-checked')).toBe('false')
    await act(async () => switchButton('Filter chat').click())
    await until(async () => (await page.moderation.view(page.owner, page.server.id)).chatFilter)
    await until(() => document.body.textContent.includes('Swearing, advertising and spam are blocked.'))
  } finally {
    await page.close()
  }
}
async function listChange(list) {
  const page = await openPlayers({ tools: list === 'helper', stopped: true })
  const label = {
    whitelist: 'Add a player',
    operator: 'Make someone an operator',
    ban: 'Ban a player',
    helper: 'Add a helper',
  }[list]
  try {
    if (list === 'whitelist') {
      await act(async () => switchButton('Only people I add can join').click())
      await until(async () => (await page.access()).pendingWhitelistEnabled === true)
      await page.reload()
    }
    const form = await fillName(page.browser, label, 'Alex')
    await act(async () => insideButton(list === 'ban' ? 'Ban' : 'Add', form).click())
    await until(async () =>
      (await page.access()).entries.some((entry) => entry.list === list && entry.player.name === 'Alex'),
    )
    await page.reload()
    expect(document.body.textContent).toContain('Added when the server starts')
    const row = [...document.querySelectorAll('.bk-player-row')].find((item) =>
      item.textContent.includes('Alex'),
    )
    const remove = row
      ? insideButton(list === 'ban' ? 'Unban' : 'Remove', row)
      : button(list === 'ban' ? 'Unban' : 'Remove')
    await act(async () => remove.click())
    await until(
      async () =>
        !(await page.access()).entries.some((entry) => entry.list === list && entry.player.name === 'Alex'),
    )
  } finally {
    await page.close()
  }
}
async function invitationRetry() {
  const page = await openPlayers({ stopped: true })
  let failed
  try {
    let refusal
    try {
      await page.h.app.sharingQueries.share(page.owner, crypto.randomUUID())
    } catch (error) {
      refusal = error
    }
    if (!refusal) throw new Error('The real sharing service must refuse a missing server')
    failed = spyOn(page.h.app.sharingQueries, 'share').mockImplementation(async () => {
      throw refusal
    })
    await page.reload()
    await until(() => document.body.textContent.includes('Try again'))
    failed.mockRestore()
    await act(async () => button('Try again').click())
    await until(() => document.body.textContent.includes('Copy link'))
    expect(document.body.textContent).not.toContain('Try again')
  } finally {
    failed?.mockRestore()
    await page.close()
  }
}
async function accessMetadata() {
  const page = await openPlayers({ tools: true, stopped: true, away: true, people: ['Alex', 'Steve'] })
  try {
    const alex = await page.h.profiles.byName('Alex'),
      steve = await page.h.profiles.byName('Steve')
    if (!alex || !steve) throw new Error('The real profile service must supply both fixture players')
    await page.h.db
      .update(schema.serverAccess)
      .set({ whitelistEnabled: true })
      .where(eq(schema.serverAccess.serverId, page.server.id))
    const entries = [
      { list: 'whitelist', player: alex, state: 'pending_remove', error: null },
      { list: 'operator', player: alex, state: 'pending_add', error: 'The fixture is unavailable' },
      { list: 'operator', player: steve, state: 'rejected', error: null },
      { list: 'ban', player: alex, state: 'active', error: null, details: { reason: 'Fixture reason' } },
      { list: 'ban', player: steve, state: 'pending_remove', error: 'The fixture is unavailable' },
      { list: 'helper', player: alex, state: 'active', origin: 'game', error: null },
      { list: 'helper', player: steve, state: 'rejected', error: 'The fixture is unavailable' },
    ]
    for (const entry of entries)
      await upsertEntry(page.h.db, page.server.id, { origin: 'blockly', details: {}, ...entry }, null)
    await page.reload()
    for (const message of [
      'Removed when the server starts',
      'Not applied yet — The fixture is unavailable',
      'The server did not accept this',
      'Fixture reason',
      'Added in game',
    ])
      expect(document.body.textContent).toContain(message)
    expect(document.querySelectorAll('input').length).toBeGreaterThan(1)
    await page.h.db.insert(schema.auditLog).values({
      actor: 'system',
      action: 'access.ip_ban_lifted',
      subjectType: 'server',
      subjectId: page.server.id,
      data: { ip: '192.0.2.1' },
    })
    await page.reload()
    expect(document.body.textContent).toContain('Someone banned the address 192.0.2.1 in game')
    await page.h.db.insert(schema.auditLog).values({
      actor: 'system',
      action: 'access.ip_ban_lifted',
      subjectType: 'server',
      subjectId: page.server.id,
      data: { ip: '192.0.2.2' },
    })
    await page.reload()
    expect(document.body.textContent).toContain('Someone banned 2 addresses in game')
  } finally {
    await page.close()
  }
}
async function moddedPlayers() {
  const page = await openPlayers({ loader: 'fabric' })
  try {
    expect(document.body.textContent).toContain('Mods change how players move')
    expect(
      [...document.querySelectorAll('[role="switch"]')].some(
        (item) => item.textContent === 'Moderation tools',
      ),
    ).toBe(false)
  } finally {
    await page.close()
  }
}
describe.skipIf(!hasDatabase)('players in the browser', () => {
  test('a failed invitation can be retried through the real sharing service', invitationRetry, 30 * SECOND_MS)
  test('an empty server shows its invitation and empty access lists', emptyPlayers, 30 * SECOND_MS)
  test('people currently playing link to their player page', () => playersPresence(false), 30 * SECOND_MS)
  test('people who left remain under their playing history', () => playersPresence(true), 30 * SECOND_MS)
  test('cancelling the moderation restart leaves the tools off', cancelTools, 30 * SECOND_MS)
  test('moderation tools can wait for everyone to leave', () => toolsTiming('empty'), 30 * SECOND_MS)
  test('moderation tools can restart an occupied server now', () => toolsTiming('now'), 30 * SECOND_MS)
  test('the chat filter can be enabled on a sleeping server', chatFilter, 30 * SECOND_MS)
  test(
    'a player can be added to and removed from the whitelist',
    () => listChange('whitelist'),
    30 * SECOND_MS,
  )
  test('an operator can be added and removed', () => listChange('operator'), 30 * SECOND_MS)
  test('a ban can be added and lifted', () => listChange('ban'), 30 * SECOND_MS)
  test('a moderation helper can be added and removed', () => listChange('helper'), 30 * SECOND_MS)
  test(
    'pending and rejected access changes retain their real record messages',
    accessMetadata,
    30 * SECOND_MS,
  )
  test('modded servers explain why moderation plugins do not run', moddedPlayers, 30 * SECOND_MS)
})
