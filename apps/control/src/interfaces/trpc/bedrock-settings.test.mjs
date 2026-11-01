// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Bedrock membership uses real browser controls, catalog capabilities, router and revisions. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { eq } from 'drizzle-orm'
import { act, createElement } from 'react'
import { BedrockSetting } from '../../../../web/src/app/(app)/servers/[id]/settings/bedrock'
import { ApiProvider } from '../../../../web/src/lib/api'
import { loadRevision } from '../../app/servers/persistence.ts'
import { runsOnPaper } from '../../domain/revision/revision.ts'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
const cdn = new Cdn()
let capable, basic
async function membershipHarness() {
  await cdn.start()
  const geyser = new FakeGeyserMc()
  const h = await startHarness({
    capabilities: {
      archives: null,
      billing: null,
      bedrock: { floodgateKey: Buffer.alloc(16, 7).toString('base64'), geyser },
    },
  })
  for (const projectId of [VIAVERSION, VIABACKWARDS])
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name: projectId,
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '5.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper', 'spigot'],
          gameVersions: offeredVersions().map((v) => v.id),
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file(`${projectId}-1`),
          dependencies: [],
        },
      ],
    )
  geyser.floodgate = { version: '2.2.5', build: 141, ...cdn.file('floodgate-spigot') }
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
  return h
}
afterAll(async () => {
  for (const pending of [capable, basic]) await pending?.then((h) => h.close())
  cdn.close()
})
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

async function openBedrock({
  loader = 'paper',
  supported = true,
  online = false,
  enabled,
  blocked = false,
  legacy = false,
  closed = false,
} = {}) {
  const dom = browserScope(),
    native = globalThis.fetch,
    calls = []
  let root
  try {
    if (supported) capable ??= membershipHarness()
    else basic ??= startHarness()
    const h = await (supported ? capable : basic)
    const owner = await h.user('Bedrock owner', 'plus')
    const server = await h.create(owner, { loader, gameVersion: '26.2' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    if (legacy) {
      await h.app.mods.changeVersion(
        owner,
        server.id,
        { loader: 'vanilla', gameVersion: '26.2', onPaper: false },
        [],
        crypto.randomUUID(),
      )
      await h.settled(server.id)
    }
    if (!online) {
      await h.app.servers.stop(owner, server.id, crypto.randomUUID())
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
    }
    if (legacy) {
      const revision = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
      const { bedrock: _b, otherVersions: _o, ...settings } = revision.settings
      await h.db
        .update(schema.serverRevisions)
        .set({ settings, loaderVersion: null })
        .where(eq(schema.serverRevisions.id, revision.id))
    }
    if (enabled !== undefined)
      await h.app.revisions.changeBedrock(owner, server.id, enabled, crypto.randomUUID())
    if (blocked) await h.app.revisions.changeOtherVersions(owner, server.id, 'off', crypto.randomUUID())
    if (online) {
      h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
      await h.app.schedules.presenceSync()
    }
    if (closed)
      await h.db
        .update(schema.accountStanding)
        .set({ status: 'terminated' })
        .where(eq(schema.accountStanding.userId, owner.userId))
    const view = await h.app.queries.get(owner, server.id)
    const routed = Object.assign(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
        if (!url.pathname.startsWith('/api/trpc')) return native(input, init)
        const request = new Request(url, init)
        if (request.method === 'POST') calls.push({ path: url.pathname, input: await request.clone().json() })
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
    Object.defineProperty(dom.browser, 'fetch', { value: routed, configurable: true, writable: true })
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root.render(createElement(ApiProvider, null, createElement(BedrockSetting, { view }))),
    )
    return {
      h,
      owner,
      server,
      host,
      calls,
      view,
      async refresh() {
        const next = await h.app.queries.get(owner, server.id)
        await act(async () =>
          root.render(createElement(ApiProvider, null, createElement(BedrockSetting, { view: next }))),
        )
      },
      async close() {
        // Let the real action button finish its minimum busy display before removing browser globals.
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
const toggle = () => document.querySelector('[role="switch"]')
const opened = () => document.querySelector('dialog')?.open === true

describe.skipIf(!hasDatabase)('Bedrock settings in the browser', () => {
  test(
    'a deployment without Bedrock shows no controls',
    async () => {
      const page = await openBedrock({ supported: false })
      try {
        expect(page.host.textContent).toBe('')
        expect(page.calls).toHaveLength(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a modded server explains where Bedrock friends can play',
    async () => {
      const page = await openBedrock({ loader: 'fabric' })
      try {
        expect(page.host.textContent).toContain('can’t join a server with mods yet')
        expect(page.host.querySelector('a')?.getAttribute('href')).toBe('/servers/new')
        expect(toggle() === null).toBe(true)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'an enabled server gives its real address, and cancelling preserves membership',
    async () => {
      const page = await openBedrock()
      try {
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        expect(page.host.textContent).not.toContain('Didn’t change.')
        expect(page.host.textContent).not.toContain('Saved.')
        expect(page.host.textContent).toContain(
          'Friends on phones, tablets and Windows join the same server.',
        )
        expect(page.host.textContent).toContain('Play, Servers, Add Server')
        expect(page.host.textContent).toContain(page.view.joinAddress)
        await act(async () => toggle().click())
        expect(opened()).toBe(true)
        expect(document.querySelector('dialog h2').textContent).toBe('Stop Bedrock players joining?')
        expect(page.host.textContent).toContain(
          'Players on Bedrock won’t be able to join. Java players are not affected.',
        )
        await act(async () => button('Cancel').click())
        expect(opened()).toBe(false)
        expect(page.calls).toHaveLength(0)
        expect((await page.h.app.queries.get(page.owner, page.server.id)).bedrock.on).toBe(true)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'the owner can let friends join and stop them again through the real API',
    async () => {
      const page = await openBedrock({ enabled: false })
      try {
        expect(toggle().getAttribute('aria-checked')).toBe('false')
        expect(page.host.textContent).toContain(
          'Friends on phones, tablets and Windows can’t join this server.',
        )
        expect(page.host.textContent).not.toContain('Didn’t change.')
        await act(async () => toggle().click())
        expect(document.querySelector('dialog h2').textContent).toBe('Let Bedrock players join?')
        expect(page.host.textContent).toContain(
          'Players on phones, tablets and Windows can join with the same address.',
        )
        await act(async () => button('Let them join').click())
        await until(() => !opened())
        expect((await page.h.app.queries.get(page.owner, page.server.id)).bedrock.on).toBe(true)
        expect(page.host.textContent).toContain('Saved.')
        await page.refresh()
        expect(toggle()?.getAttribute('aria-checked')).toBe('true')
        expect(page.host.textContent).toContain('join the same server')
        await act(async () => toggle().click())
        await act(async () => button('Stop them joining').click())
        await until(() => !opened())
        await page.refresh()
        expect(toggle()?.getAttribute('aria-checked')).toBe('false')
        expect((await page.h.app.queries.get(page.owner, page.server.id)).bedrock.on).toBe(false)
        expect(page.calls.filter((call) => call.path.includes('changeBedrock'))).toHaveLength(2)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a version restriction explains why enabled Bedrock friends cannot join',
    async () => {
      const page = await openBedrock({ blocked: true })
      try {
        expect(page.host.textContent).toContain('Turn on Newer and older versions above')
        expect(page.host.textContent).not.toContain('Play, Servers, Add Server')
        expect(toggle().getAttribute('aria-checked')).toBe('true')
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'an occupied server keeps its chosen change pending',
    async () => {
      const page = await openBedrock({ online: true })
      try {
        await act(async () => toggle().click())
        expect(document.querySelector('input[value="empty"]').checked).toBe(true)
        await act(async () => button('Stop them joining').click())
        await until(async () => (await page.h.app.queries.get(page.owner, page.server.id)).waiting !== null)
        expect(JSON.stringify(page.calls.at(-1).input)).toContain('"when":"empty"')
        expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a legacy plain server is offered the Paper migration and can cancel or accept it',
    async () => {
      const page = await openBedrock({ loader: 'vanilla', legacy: true })
      try {
        expect(page.view.bedrock.moves).toBe(true)
        expect(opened()).toBe(false)
        expect(page.host.textContent).toContain(
          'Friends on phones, tablets and Windows can’t join this server yet.',
        )
        expect(page.host.textContent).not.toContain('Didn’t change.')
        await act(async () => button('Let Bedrock friends in').click())
        expect(opened()).toBe(true)
        expect(document.querySelector('dialog h2').textContent).toBe('Let Bedrock friends in?')
        expect(page.host.textContent).toContain('a backup is made first')
        await act(async () => button('Cancel').click())
        expect(opened()).toBe(false)
        expect(page.calls).toHaveLength(0)
        await act(async () => button('Let Bedrock friends in').click())
        await act(async () => button('Let them in').click())
        await until(() => !opened())
        await page.refresh()
        expect(toggle() !== null).toBe(true)
        const revision = await loadRevision(
          page.h.db,
          (await page.h.server(page.server.id)).desiredRevisionId,
        )
        expect(runsOnPaper(revision)).toBe(true)
        expect(revision.settings.bedrock).toBe(true)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a concurrent edit refusal stays in the dialog without changing membership',
    async () => {
      const page = await openBedrock()
      try {
        const current = await loadRevision(page.h.db, (await page.h.server(page.server.id)).desiredRevisionId)
        await page.h.app.revisions.changeSettings(
          page.owner,
          page.server.id,
          { ...current.settings, difficulty: current.settings.difficulty === 'hard' ? 'easy' : 'hard' },
          crypto.randomUUID(),
        )
        const refusal = await page.h.app.revisions
          .changeBedrock(page.owner, page.server.id, false, crypto.randomUUID(), {
            version: page.view.version,
          })
          .catch((error) => error)
        expect(refusal).toBeInstanceOf(Error)
        await act(async () => toggle().click())
        await act(async () => button('Stop them joining').click())
        await until(() => page.host.textContent.includes(refusal.message))
        expect(opened()).toBe(true)
        expect((await page.h.app.queries.get(page.owner, page.server.id)).bedrock.on).toBe(true)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )
})
