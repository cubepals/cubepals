// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What a press on a public page reports: only what its marks name, and the page by its address. */
import { describe, expect, test } from 'bun:test'
import { ctaMark, detailOf, PUBLIC_EVENTS, placeOf, planMark, pressOf, seenOf } from './steps.ts'

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
    expect(placeOf('/constructor')).toBe('other')
    expect(placeOf('/servers/abc/toString')).toBe('server')
  })

  test('a signed-in page says which it is: the list, the create page, a server and its tab', () => {
    expect(placeOf('/servers')).toBe('servers')
    expect(placeOf('/servers/trash')).toBe('servers')
    expect(placeOf('/servers/new')).toBe('create')
    expect(placeOf('/servers/abc')).toBe('server')
    expect(placeOf('/servers/abc/settings')).toBe('server_settings')
    expect(placeOf('/servers/abc/players/some-uuid')).toBe('server_players')
    expect(placeOf('/account')).toBe('account')
    expect(placeOf('/sign-up')).toBe('sign_up')
    expect(pressOf(dataset(ctaMark('copy_address')), '/servers/abc')?.properties).toEqual({
      which: 'copy_address',
      where: 'server',
    })
  })
})

describe('a section seen, a question opened', () => {
  test('by its code, with an id’s hyphens as underscores', () => {
    expect(seenOf('what-it-asks', '/')).toEqual({
      event: PUBLIC_EVENTS.seen,
      properties: { section: 'what_it_asks', where: 'landing' },
    })
    expect(detailOf('everyone_pays', '/pricing')).toEqual({
      event: PUBLIC_EVENTS.detail,
      properties: { which: 'everyone_pays', where: 'pricing' },
    })
    expect(seenOf('locked_plus', '/servers/new')?.properties).toEqual({
      section: 'locked_plus',
      where: 'create',
    })
  })

  test('a mark that isn’t a code says nothing', () => {
    expect(seenOf('Sunset Valley', '/')).toBeNull()
    expect(seenOf('', '/')).toBeNull()
    expect(seenOf(undefined, '/')).toBeNull()
    expect(detailOf('a'.repeat(41), '/pricing')).toBeNull()
  })
})
