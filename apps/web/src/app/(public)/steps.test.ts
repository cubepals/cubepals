// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What a press on a public page reports: only what its marks name, and the page by its address. */
import { describe, expect, test } from 'bun:test'
import { ctaMark, PUBLIC_EVENTS, placeOf, planMark, pressOf } from './steps.ts'

/** A marked element's `dataset`, as the browser reads its `data-` attributes. */
const dataset = (marks: Record<string, string>) =>
  Object.fromEntries(Object.entries(marks).map(([key, value]) => [key.slice('data-'.length), value]))

describe('a press on a public page', () => {
  test('a listed button says which it was and where', () => {
    expect(pressOf(dataset(ctaMark('hero_create')), '/')).toEqual({
      event: PUBLIC_EVENTS.cta,
      properties: { which: 'hero_create', where: 'landing' },
    })
    expect(pressOf(dataset(ctaMark('guide_create')), '/guides/minecraft-server-ram')?.properties).toEqual({
      which: 'guide_create',
      where: 'guide',
    })
  })

  test('a plan says its key and term', () => {
    expect(pressOf(dataset(planMark('plus', 'year')), '/pricing')).toEqual({
      event: PUBLIC_EVENTS.plan,
      properties: { plan: 'plus', term: 'year', where: 'pricing' },
    })
  })

  test('anything not listed here says nothing', () => {
    expect(pressOf({ cta: 'someone typed this' }, '/')).toBeNull()
    expect(pressOf({ plan: 'Plus <script>' }, '/pricing')).toBeNull()
    expect(pressOf({}, '/')).toBeNull()
    expect(placeOf('/servers/abc')).toBe('other')
    expect(placeOf('/constructor')).toBe('other')
  })
})
