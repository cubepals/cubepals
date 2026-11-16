// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each plan card's details open on their own (plan-card.module.css, "Each card folds and opens on
 * its own"): the stylesheet reads an open state on the details, and the card beside an open one
 * keeps its height only while the markup carries that state. When the details moved from a
 * `<details>` to `Reveal`, the rules read `details[open]`, which nothing set any more, and opening
 * one card stretched the other. This holds the two together: every attribute the stylesheet reads
 * on the details is on them while they are open, and none is while they are closed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicPlan } from '@blockly/contracts'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PlanDetails } from './plan-details'

const css = readFileSync(join(import.meta.dir, 'plan-card.module.css'), 'utf8')

/** The attributes the stylesheet reads on the details, as in `.details[data-open]`. */
const read = [...new Set([...css.matchAll(/\.details\[([\w-]+)[^\]]*\]/g)].map((m) => m[1] ?? ''))]

const core: PublicPlan = {
  key: 'core',
  name: 'Core',
  available: true,
  monthlyPriceCents: 999,
  yearlyPriceCents: null,
  includedHours: 40,
  per: 'month',
  extraHourCents: 25,
  totalHours: null,
  sleepsAfterMinutes: 15,
  maxServers: 1,
  maxPlayers: 5,
  sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
  mods: false,
  datapacks: false,
  downloads: 'history',
  sessionsKept: 14,
  restsAfterDays: 30,
  deletedAfterDays: null,
}

const browser = new Window({ url: 'http://localhost/pricing' })
const globals: Record<string, unknown> = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const before = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
)
let root: Root

beforeAll(() => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
})

afterAll(async () => {
  act(() => root?.unmount())
  await browser.happyDOM.close()
  for (const [key, value] of before) {
    if (value) Object.defineProperty(globalThis, key, value)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('the details carry every state the plan card stylesheet reads, only while open or folding', () => {
  expect(read.length).toBeGreaterThan(0)
  const host = browser.document.createElement('div')
  browser.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => root.render(createElement(PlanDetails, { plan: core, marker: null, className: 'details' })))
  const details = host.querySelector('.details')
  const toggle = host.querySelector('button')
  if (!details || !toggle) throw new Error('PlanDetails drew no details or no control')
  const carried = () => read.filter((name) => details.hasAttribute(name))

  expect(carried()).toEqual([])
  act(() => toggle.click())
  expect(carried()).toEqual(read)
  act(() => toggle.click())
  expect(carried()).toEqual([])
})

test('closing keeps the card its room until the details have folded away', () => {
  const host = browser.document.createElement('div')
  browser.document.body.appendChild(host)
  const folding = createRoot(host as unknown as Element)
  act(() => folding.render(createElement(PlanDetails, { plan: core, marker: null, className: 'details' })))
  const details = host.querySelector('.details')
  const toggle = host.querySelector('button')
  const region = host.querySelector<HTMLElement>('.bk-reveal')
  if (!details || !toggle || !region) throw new Error('PlanDetails drew no details, control or region')
  region.style.transitionDuration = '0.2s'

  act(() => toggle.click())
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(read.filter((name) => details.hasAttribute(name))).toEqual(read)

  const folded = new browser.Event('transitionend', { bubbles: true })
  Object.defineProperty(folded, 'propertyName', { value: 'grid-template-rows' })
  act(() => {
    region.dispatchEvent(folded)
  })
  expect(read.filter((name) => details.hasAttribute(name))).toEqual([])
  act(() => folding.unmount())
})
