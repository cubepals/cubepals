// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Restart dialogs retain the owner's choice, close on success, and clear a previous refusal. */
import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { RestartWhen, ServerView } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { refusing } from '@blockly/control/testing/refusing'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import { failedWith } from '../../../../../lib/failed-call'
import { useRestartAsk } from './restart-ask'

const quality = createRequire(new URL('../../../../../../../../tools/quality/package.json', import.meta.url))
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

async function until(ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5 * SECOND_MS
  let done = false
  while (!done && Date.now() < deadline)
    await act(async () => {
      await Bun.sleep(20)
      done = await ready()
    })
  expect(done).toBe(true)
}

function button(text: string) {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

const opened = () => document.querySelector<HTMLDialogElement>('dialog')?.open === true
const runType = (_when: RestartWhen): Promise<unknown> => Promise.resolve()
type Run = typeof runType

function Panel({
  view,
  run,
  second,
}: {
  view: Pick<ServerView, 'status' | 'players'>
  run: Run
  second: Run
}) {
  const change = useRestartAsk(view)
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => change.ask({ title: 'First change', confirmLabel: 'Apply first', run }),
      },
      'Ask first',
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => change.ask({ title: 'Second change', confirmLabel: 'Apply second', run: second }),
      },
      'Ask second',
    ),
    change.dialog,
  )
}

async function openAsk(run: Run, second: Run = runType, online = 1) {
  const dom = browserScope()
  let root: Root | undefined
  const view: Pick<ServerView, 'status' | 'players'> = {
    status: 'running',
    players: { online, people: online ? [{ name: 'Alex', uuid: crypto.randomUUID() }] : [] },
  }
  try {
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(createElement(Panel, { view, run, second })))
    return {
      host,
      async close() {
        await act(async () => root?.unmount())
        await dom.close()
      },
    }
  } catch (error) {
    await act(async () => root?.unmount())
    await dom.close()
    throw error
  }
}

test(
  'cancel keeps the change unsubmitted; a later choice closes only when its operation succeeds',
  async () => {
    const first: RestartWhen[] = [],
      second: RestartWhen[] = []
    const gate = Promise.withResolvers<void>()
    const page = await openAsk(
      async (when) => {
        first.push(when)
      },
      async (when) => {
        second.push(when)
        await gate.promise
      },
    )
    try {
      expect(opened()).toBe(false)
      await act(async () => button('Ask first').click())
      expect(opened()).toBe(true)
      expect(document.querySelector('dialog h2')?.textContent).toBe('First change')
      await act(async () => button('Cancel').click())
      expect(opened()).toBe(false)
      expect(first).toEqual([])
      await act(async () => button('Ask second').click())
      expect(document.querySelector('dialog h2')?.textContent).toBe('Second change')
      expect(document.querySelector<HTMLInputElement>('input[value="empty"]')?.checked).toBe(true)
      await act(async () => document.querySelector<HTMLInputElement>('input[value="now"]')?.click())
      await act(async () => button('Apply second').click())
      await until(() => second.length === 1)
      expect(second).toEqual(['now'])
      expect(opened()).toBe(true)
      gate.resolve()
      await until(() => !opened())
      expect(first).toEqual([])
    } finally {
      gate.resolve()
      await page.close()
    }
  },
  10 * SECOND_MS,
)

test(
  'a refused change remains open and a new change starts without the old error',
  async () => {
    const refusal = await failedWith(refusing('invalid_choice', 'This change was refused.'))
    const calls: RestartWhen[] = []
    const page = await openAsk(async (when) => {
      calls.push(when)
      throw refusal
    })
    try {
      await act(async () => button('Ask first').click())
      expect(page.host.querySelector('[role="alert"]') === null).toBe(true)
      await act(async () => button('Apply first').click())
      await until(() => page.host.textContent?.includes(refusal.message) === true)
      expect(opened()).toBe(true)
      expect(page.host.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
      expect(page.host.textContent).toContain('Didn’t go through')
      expect(calls).toEqual(['empty'])
      await act(async () => button('Cancel').click())
      expect(opened()).toBe(false)
      await act(async () => button('Ask second').click())
      expect(opened()).toBe(true)
      expect(document.querySelector('dialog h2')?.textContent).toBe('Second change')
      expect(page.host.querySelector('[role="alert"]') === null).toBe(true)
      expect(page.host.textContent).not.toContain(refusal.message)
    } finally {
      await page.close()
    }
  },
  10 * SECOND_MS,
)

test('with nobody on, the change runs now and a refused promise does not open a dialog', async () => {
  const refusal = await failedWith(refusing('invalid_choice', 'The immediate change was refused.'))
  const calls: RestartWhen[] = []
  const page = await openAsk(
    async (when) => {
      calls.push(when)
      throw refusal
    },
    runType,
    0,
  )
  try {
    expect(opened()).toBe(false)
    await act(async () => button('Ask first').click())
    expect(calls).toEqual(['now'])
    expect(opened()).toBe(false)
    expect(page.host.querySelector('[role="alert"]') === null).toBe(true)
  } finally {
    await page.close()
  }
})
