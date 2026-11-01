// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Confirmation explains the real restart timing and blocks a change until its prerequisites are ready. */
import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { RestartWhen, ServerView } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { act, createElement } from 'react'
import { ConfirmChange, whatHappens } from './shared'

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

const view = (online: number, status: ServerView['status'] = 'running') =>
  ({ status, players: { online, people: [{ uuid: 'alex', name: 'Alex' }] } }) as ServerView

test('an occupied server explains the rollback without promising an immediate restart', () => {
  expect(whatHappens(view(1))).toBe('If the change doesn’t start, the server goes back to how it was.')
})
test('an empty running server explains saving, restarting and returning if the change fails', () => {
  expect(whatHappens(view(0))).toBe(
    'The server saves the world and restarts with the change. Anyone online is back in about half a minute. If the change doesn’t start, the server goes back to how it was.',
  )
})
test('a sleeping server applies the change when it next starts', () => {
  expect(whatHappens(view(0, 'stopped'))).toBe('The change applies the next time the server starts.')
})
test('confirmation waits for prerequisites and submits the chosen restart timing once ready', async () => {
  const dom = browserScope()
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const calls: { requestId: string; when: RestartWhen }[] = []
  const props = {
    open: true,
    onClose: () => {},
    title: 'Save these settings?',
    confirmLabel: 'Save',
    working: 'Saving the settings',
    error: null,
    view: view(1),
    onConfirm: async (requestId: string, when: RestartWhen) => {
      calls.push({ requestId, when })
    },
  }
  const save = () => {
    const button = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    )
    if (!button) throw new Error('The confirmation must offer a Save button')
    return button
  }
  try {
    await act(async () => root.render(createElement(ConfirmChange, { ...props, disabled: true })))
    expect(save().disabled).toBe(true)
    await act(async () => save().click())
    expect(calls).toEqual([])
    await act(async () => root.render(createElement(ConfirmChange, { ...props, disabled: false })))
    expect(save().disabled).toBe(false)
    const now = document.querySelector<HTMLInputElement>('input[value="now"]')
    if (!now) throw new Error('An occupied server must offer restarting now')
    await act(async () => now.click())
    expect(now.checked).toBe(true)
    await act(async () => save().click())
    expect(calls).toEqual([{ requestId: expect.any(String), when: 'now' }])
  } finally {
    await act(async () => {
      await Bun.sleep(SECOND_MS)
    })
    await act(async () => root.unmount())
    await dom.close()
  }
})
