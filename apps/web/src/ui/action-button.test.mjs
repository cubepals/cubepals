// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Button feedback belongs to its mounted action; failed or closed dialogs cannot reset a later press. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { SECOND_MS } from '@blockly/contracts/durations'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ActionButton } from './action-button.tsx'

const quality = createRequire(new URL('../../../../tools/quality/package.json', import.meta.url))
const nativeTimeout = globalThis.setTimeout
const nativeClear = globalThis.clearTimeout
let browser, previous, root, host, timers, scheduled, cleared

beforeEach(() => {
  browser = new (quality('happy-dom').Window)({ url: 'http://localhost' })
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  timers = new Set()
  scheduled = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const timer = nativeTimeout(
      (...values) => {
        timers.delete(timer)
        callback(...values)
      },
      delay,
      ...args,
    )
    timers.add(timer)
    return timer
  })
  cleared = spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    timers.delete(timer)
    return nativeClear(timer)
  })
})
afterEach(async () => {
  await act(async () => root?.unmount())
  // Keep failed assertions from leaving a timer behind for the next test.
  for (const timer of timers) nativeClear(timer)
  scheduled.mockRestore()
  cleared.mockRestore()
  await browser.happyDOM.close()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

async function mount(run) {
  await act(async () =>
    root.render(
      createElement(ActionButton, {
        now: 'play',
        phases: {
          play: {
            icon: null,
            label: 'Play',
            working: 'Starting',
            failed: 'Could not start',
            variant: 'primary',
            run,
          },
        },
      }),
    ),
  )
}
async function click() {
  await act(async () => host.querySelector('button').click())
}

test('a failed action releases its feedback timer when its dialog unmounts', async () => {
  await mount(async () => {
    throw new Error('The server refused this action')
  })
  await click()
  expect(host.textContent).toContain('Could not start')
  expect(timers.size).toBeGreaterThan(0)
  await act(async () => {
    root.unmount()
    root = undefined
  })
  expect(timers.size).toBe(0)
})

test(
  'an earlier failure cannot reset a newer action that is still running',
  async () => {
    let release
    let attempts = 0
    await mount(() =>
      ++attempts === 1
        ? Promise.reject(new Error('Try again'))
        : new Promise((resolve) => {
            release = resolve
          }),
    )
    await click()
    expect(host.textContent).toContain('Could not start')
    await click()
    await act(async () => {
      await Bun.sleep(3 * SECOND_MS)
    })
    expect(host.textContent).toContain('Starting')
    await act(async () => {
      release()
      await new Promise((resolve) => nativeTimeout(resolve, 10))
    })
    expect(host.textContent).toContain('Play')
  },
  10 * SECOND_MS,
)

test.each(['resolved', 'rejected'])(
  'an action %s after unmount creates no more feedback timers',
  async (outcome) => {
    let finish
    await mount(
      () =>
        new Promise((resolve, reject) => {
          finish = () => (outcome === 'resolved' ? resolve() : reject(new Error('The action failed')))
        }),
    )
    await click()
    expect(host.textContent).toContain('Starting')
    await act(async () => {
      root.unmount()
      root = undefined
    })
    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(timers.size).toBe(0)
  },
)

test(
  'a failure returns to the ready label after its feedback has been shown',
  async () => {
    await mount(async () => {
      throw new Error('The action failed')
    })
    await click()
    expect(host.textContent).toContain('Could not start')
    await act(async () => {
      await Bun.sleep(3 * SECOND_MS)
    })
    expect(host.textContent).toContain('Play')
    expect(host.textContent).not.toContain('Could not start')
    expect(timers.size).toBe(0)
  },
  10 * SECOND_MS,
)

test('finishing the minimum busy display after unmount never asks React to schedule another update', async () => {
  await mount(async () => undefined)
  await click()
  expect(host.textContent).toContain('Starting')
  expect(timers.size).toBeGreaterThan(0)
  await act(async () => {
    root.unmount()
    root = undefined
  })
  let lateBrowserReads = 0
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get: () => {
      lateBrowserReads++
      return browser
    },
  })
  try {
    await Bun.sleep(SECOND_MS)
    expect(lateBrowserReads).toBe(0)
    expect(timers.size).toBe(0)
  } finally {
    Object.defineProperty(globalThis, 'window', descriptor)
  }
})
