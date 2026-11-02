// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Confirmation callbacks preserve restart timing when the API reports an artifact-policy refusal. */
import { describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { realtimeContract } from '@blockly/contracts/realtime'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { act, createElement } from 'react'
import { Client } from 'transport-io'
import { acknowledged, draftOf } from '../../app/revisions/service.ts'
import { loadRevision } from '../../app/servers/persistence.ts'
import { Cdn } from '../../testing/cdn.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { fabricJar, pluginJar, utf8, zipBytes } from '../../testing/uploads.ts'
import { appRouter } from './router.ts'

const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
function browserScope(origin = 'http://localhost') {
  const Window = quality('happy-dom').Window
  const browser = new Window({ url: new URL('/servers/test/mods', origin).href })
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
function routeApi(h, owner, browser) {
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
        createContext: () => ({ actor: owner, services: h.app }),
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
  const { default: Page } = await import('../../../../web/src/app/(app)/servers/[id]/mods/page')
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
function publishIris(h, cdn, needsNewer = false, loader = 'fabric') {
  if (needsNewer)
    h.catalog.publish(
      {
        projectId: 'foundation',
        slug: 'foundation',
        name: 'Foundation',
        summary: 'Required by Iris',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'foundation-1',
          projectId: 'foundation',
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: [loader],
          gameVersions: ['26.3'],
          publishedAt: new Date(),
          file: cdn.file('foundation-1'),
          dependencies: [],
        },
      ],
    )
  h.catalog.publish(
    {
      projectId: 'iris',
      slug: 'iris',
      name: 'Iris Shaders',
      summary: 'Iris, for tests',
      iconUrl: null,
      environments: ['client_and_server'],
      downloads: loader === 'paper' ? 1200 : 1,
    },
    [
      {
        versionId: 'iris-1',
        projectId: 'iris',
        versionLabel: '1.0',
        channel: 'release',
        state: 'listed',
        environment: 'client_and_server',
        loaders: [loader],
        gameVersions: needsNewer ? ['26.2', '26.3'] : [loader === 'paper' ? '26.2' : '26.3'],
        publishedAt: new Date(),
        file: cdn.file('iris-1', loader === 'paper' ? pluginJar('Iris', 25) : undefined),
        dependencies: needsNewer ? [{ projectId: 'foundation', versionId: null, kind: 'required' }] : [],
      },
    ],
  )
}

function catalogPack(h, cdn, movesWorld, leftOut = 0) {
  const versions = []
  const publish = (number) => {
    const gameVersion = movesWorld && number > 1 ? '26.3' : '1.21.1'
    const bytes = fabricJar(`farm-${number}`, { depends: { minecraft: gameVersion } })
    const mod = cdn.file(`farm-${number}`, bytes)
    const file = cdn.file(
      `pack-${number}`,
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: `${number}.0`,
            name: 'Update Pack',
            files: [
              {
                path: `mods/farm-${number}.jar`,
                hashes: { sha1: createHash('sha1').update(bytes).digest('hex'), sha512: mod.sha512 },
                env: { client: 'required', server: 'required' },
                downloads: [mod.url],
                fileSize: mod.sizeBytes,
              },
            ],
            dependencies: { minecraft: gameVersion, 'fabric-loader': '0.16.14' },
          }),
        ),
        'overrides/config/farm.toml': utf8(`version = ${number}\n`),
        ...Object.fromEntries(
          Array.from({ length: leftOut }, (_, index) => [
            `overrides/mods/client-${String.fromCharCode(97 + index)}.jar`,
            fabricJar(`client-${String.fromCharCode(97 + index)}`, { environment: 'client' }),
          ]),
        ),
      }),
    )
    versions.unshift({
      versionId: `update-${number}`,
      projectId: 'update-pack',
      versionLabel: `${number}.0`,
      channel: 'release',
      state: 'listed',
      environment: 'client_and_server',
      loaders: ['fabric'],
      gameVersions: [gameVersion],
      publishedAt: new Date(Date.UTC(2026, 0, number)),
      file,
      dependencies: [],
    })
    h.catalog.publishModpack(
      {
        projectId: 'update-pack',
        slug: 'update-pack',
        name: 'Update Pack',
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [...versions],
    )
  }
  publish(1)
  return { request: { from: { kind: 'modpack', projectId: 'update-pack' } }, upgrade: () => publish(2) }
}

async function artifactRefusal(h, owner) {
  const { id } = await h.create(owner, { loader: 'fabric', name: 'Refusal fixture' })
  await h.until(id, 'running')
  await h.settled(id)
  const change = { add: [{ projectId: 'iris' }] }
  const plan = await h.app.mods.plan(owner, id, change)
  if (plan.kind !== 'ok') throw new Error('The fixture mod must fit')
  await h.app.mods.apply(
    owner,
    id,
    change,
    plan.mods.map((mod) => mod.artifact.sha512),
    crypto.randomUUID(),
  )
  await h.settled(id)
  h.catalog.setProjectState('iris', 'withheld')
  await h.app.catalog.refresh()
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const refusal = await acknowledged(h.db, draftOf(revision), {}).catch((error) => error)
  expect(refusal).toBeInstanceOf(Error)
  h.catalog.setProjectState('iris', 'approved')
  await h.app.catalog.refresh()
  return refusal
}

async function openRevocation(pack) {
  const dom = browserScope()
  const cdn = new Cdn()
  let h, root, api, refused
  try {
    await cdn.start()
    h = await startHarness()
    const owner = await h.user('Release owner', 'plus')
    publishIris(h, cdn)
    const refusal = await artifactRefusal(h, owner)
    const prepared = pack ? catalogPack(h, cdn, false) : null
    const server = await h.create(owner, prepared?.request ?? { loader: 'fabric' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    prepared?.upgrade()
    api = routeApi(h, owner, dom.browser)
    // The real router serializes a genuine policy refusal at the service boundary. Pack and
    // ordinary-mod callbacks share this API contract; the successful retry uses the real service.
    refused = spyOn(pack ? h.app.packChanges : h.app.mods, pack ? 'change' : 'apply').mockRejectedValueOnce(
      refusal,
    )
    root = await draw(server.id)
    await until(() => document.body.textContent.includes(pack ? 'Update to 2.0' : 'Iris Shaders'))
    return {
      h,
      owner,
      server,
      mutations: api.mutations,
      accept() {
        refused.mockRestore()
      },
      async close() {
        refused.mockRestore()
        await act(async () => root.unmount())
        api.close()
        await h.close()
        cdn.close()
        await dom.close()
      },
    }
  } catch (error) {
    refused?.mockRestore()
    await act(async () => root?.unmount())
    api?.close()
    await h?.close()
    cdn.close()
    await dom.close()
    throw error
  }
}

const inputOf = (call) => Object.values(call.input)[0]

describe.skipIf(!hasDatabase)('acknowledging the artifact refusal at the API boundary', () => {
  for (const pack of [false, true]) {
    test(
      pack
        ? 'a modpack update asks again before using the removed release'
        : 'a mod change asks again before using the removed release',
      async () => {
        const page = await openRevocation(pack)
        const path = pack ? '/mods.changePack' : '/mods.change'
        const confirm = pack ? 'Update and restart' : 'Apply and restart'
        try {
          const before = await page.h.server(page.server.id)
          await act(async () => button(pack ? 'Update to 2.0' : 'Add').click())
          await until(() => !button(confirm).disabled)
          expect(document.querySelector('input[value="empty"]').checked).toBe(true)
          await act(async () => button(confirm).click())
          await until(() =>
            [...document.querySelectorAll('button')].some(
              (item) => item.textContent.trim() === 'Run it anyway',
            ),
          )
          const [first] = page.mutations.filter((call) => call.path.endsWith(path))
          expect(inputOf(first)).toMatchObject({
            serverId: page.server.id,
            when: 'empty',
            acknowledgeRevoked: false,
          })
          expect((await page.h.server(page.server.id)).desiredRevisionId).toBe(before.desiredRevisionId)
          expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(
            0,
          )
          expect(document.querySelector('input[value="empty"]').checked).toBe(true)
          page.accept()
          await act(async () => button('Run it anyway').click())
          await until(async () => (await page.h.app.queries.get(page.owner, page.server.id)).waiting !== null)
          await until(() => document.querySelector('dialog') === null)
          const attempts = page.mutations.filter((call) => call.path.endsWith(path))
          expect(attempts).toHaveLength(2)
          expect(inputOf(attempts[1])).toMatchObject({
            serverId: page.server.id,
            when: 'empty',
            acknowledgeRevoked: true,
          })
          expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(
            0,
          )
          expect((await page.h.app.queries.get(page.owner, page.server.id)).players.online).toBe(1)
        } finally {
          await page.close()
        }
      },
      40 * SECOND_MS,
    )
  }
})
