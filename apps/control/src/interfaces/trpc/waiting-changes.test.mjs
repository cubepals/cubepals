// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pending changes settle through the real browser, router and database, including stale requests. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { act, createElement, useState } from 'react'
import { loadRevision } from '../../app/servers/persistence.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

const quality = createRequire(new URL('../../../../../tools/quality/package.json', import.meta.url))
let harness
afterAll(async () => {
  await harness?.then((h) => h.close())
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

async function openWaiting({ pending = true, resize = false, pause = false } = {}) {
  const dom = browserScope()
  const native = globalThis.fetch
  let root, queued, release
  const requests = [],
    changed = []
  const gate = new Promise((resolve) => {
    release = resolve
  })
  if (!pause) release()
  try {
    harness ??= startHarness()
    const h = await harness
    const owner = await h.user('Waiting owner', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const before = await h.server(server.id)
    const revision = await loadRevision(h.db, before.desiredRevisionId)
    h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    if (pending)
      await h.app.revisions.changeSettings(
        owner,
        server.id,
        { ...revision.settings, viewDistance: revision.settings.viewDistance + 1 },
        crypto.randomUUID(),
        { when: 'empty' },
      )
    if (resize) await h.app.revisions.resize(owner, server.id, '4g', crypto.randomUUID(), { when: 'empty' })
    // Hold delivery only after boot: assert the router's persisted intent before a worker executes it.
    queued = spyOn(h.jobs, 'enqueue').mockResolvedValue()
    const view = await h.app.queries.get(owner, server.id)
    const routed = Object.assign(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
        if (!url.pathname.startsWith('/api/trpc')) return native(input, init)
        const request = new Request(url, init)
        requests.push({ path: url.pathname, input: (await request.clone().json())[0] })
        await gate
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
    const { WaitingChanges } = await import(
      '../../../../web/src/app/(app)/servers/[id]/settings/waiting-changes'
    )
    function Panel() {
      const [current, setCurrent] = useState(view)
      return createElement(WaitingChanges, {
        view: current,
        changed(next) {
          changed.push(next)
          setCurrent(next)
        },
      })
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(createElement(ApiProvider, null, createElement(Panel))))
    return {
      h,
      owner,
      server,
      before,
      view,
      held: await h.server(server.id),
      host,
      requests,
      changed,
      release,
      queued,
      async close() {
        release()
        await act(async () => root.unmount())
        queued.mockRestore()
        globalThis.fetch = native
        await dom.close()
      },
    }
  } catch (error) {
    release()
    if (root) await act(async () => root.unmount())
    queued?.mockRestore()
    globalThis.fetch = native
    await dom.close()
    throw error
  }
}

describe.skipIf(!hasDatabase)('settling pending changes in the browser', () => {
  test(
    'nothing waiting shows no banner or controls',
    async () => {
      const page = await openWaiting({ pending: false })
      try {
        expect(page.host.textContent).toBe('')
        expect(page.host.querySelector('button')).toBeNull()
        expect(page.requests).toHaveLength(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'cancel restores the running revision and size, and disables both controls during delivery',
    async () => {
      const page = await openWaiting({ resize: true, pause: true })
      try {
        expect(page.host.textContent).toContain('These changes wait until everyone has left')
        expect(page.host.querySelectorAll('li').length).toBe(2)
        await act(async () => button('Cancel these changes').click())
        await until(() => page.requests.length === 1)
        expect(button('Restart now').disabled).toBe(true)
        expect(button('Cancel these changes').disabled).toBe(true)
        page.release()
        await until(() => page.changed.length === 1)
        expect(page.host.textContent).toBe('')
        expect(await page.h.server(page.server.id)).toMatchObject({
          desiredRevisionId: page.before.desiredRevisionId,
          memoryTier: page.before.memoryTier,
        })
        expect((await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')).toHaveLength(0)
        expect(page.queued).not.toHaveBeenCalled()
        expect(page.requests[0].path).toContain('servers.settleWaiting')
        expect(page.requests[0].input).toMatchObject({ serverId: page.server.id, settle: 'cancel' })
        expect(page.requests[0].input.requestId.length).toBeGreaterThan(0)
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'restart now submits the held revision and replaces the banner with the returned server',
    async () => {
      const page = await openWaiting()
      try {
        expect(page.host.textContent).toContain('This change waits until everyone has left')
        expect(button('Cancel this change').disabled).toBe(false)
        expect(page.host.querySelector('[role="alert"]')).toBeNull()
        await act(async () => button('Restart now').click())
        await until(() => page.changed.length === 1)
        expect(page.host.textContent).toBe('')
        const [operation] = (await page.h.operations(page.server.id)).filter((op) => op.kind === 'apply')
        expect(operation).toMatchObject({
          status: 'queued',
          requestedBy: `user:${page.owner.userId}`,
          input: { revisionId: page.held.desiredRevisionId },
        })
        expect(page.queued).toHaveBeenCalledTimes(1)
        expect(page.requests[0].input).toMatchObject({ serverId: page.server.id, settle: 'now' })
        expect(operation.idempotencyKey).toBe(`apply:${page.requests[0].input.requestId}`)
        expect(page.changed[0]).toEqual(await page.h.app.queries.get(page.owner, page.server.id))
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'a stale banner keeps the router refusal visible and makes the controls usable again',
    async () => {
      const page = await openWaiting()
      try {
        await page.h.app.stopCheaters.waiting.settle(
          page.owner,
          page.server.id,
          'cancel',
          crypto.randomUUID(),
        )
        const refusal = await page.h.app.stopCheaters.waiting
          .settle(page.owner, page.server.id, 'cancel', crypto.randomUUID())
          .catch((error) => error)
        expect(refusal).toBeInstanceOf(Error)
        await act(async () => button('Cancel this change').click())
        await until(() => page.host.textContent.includes(refusal.message))
        expect(page.host.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
        expect(page.host.textContent).toContain('This change waits until everyone has left')
        expect(button('Restart now').disabled).toBe(false)
        expect(button('Cancel this change').disabled).toBe(false)
        expect(page.changed).toHaveLength(0)
        expect(page.queued).not.toHaveBeenCalled()
      } finally {
        await page.close()
      }
    },
    30 * SECOND_MS,
  )
})
