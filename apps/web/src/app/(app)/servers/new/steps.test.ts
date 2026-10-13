// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the create page reports, with a mock standing in for posthog-js's capture: a choice once
 * its field settles, never the name's text, where a view stopped when it leaves, and what it did
 * on the page besides choosing.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CREATE_EVENTS, choicesOf, createSteps, missingOf } from './steps.ts'

const sent = mock((_event: string, _properties: Record<string, unknown>, _leaving?: boolean) => {})

const SETTLE = 20
/** What `create_left` adds for a view that pressed, typed and scrolled nothing. */
const NOTHING_ELSE = { presses: 0, typed: false, ready: false, furthest_seen: 'play' }
const settled = () => Bun.sleep(SETTLE * 3)
const events = () => sent.mock.calls.map(([event, properties]) => ({ event, properties }))

/** A view's reporter on a clock the test moves. */
function view() {
  let at = 0
  const steps = createSteps(sent, () => at, SETTLE)
  const after = (ms: number) => {
    at += ms
  }
  return { steps, after }
}

describe('the create page reports', () => {
  beforeEach(() => sent.mockClear())

  test('a field once it settles: a pass through the releases is one choice', async () => {
    const { steps } = view()
    for (const value of ['1.21.4', '1.21.1', '1.20.6', '1.21.1']) steps.chose({ field: 'version', value })
    steps.chose({ field: 'size', value: '10' })
    expect(events()).toEqual([])
    await settled()
    expect(events()).toEqual([
      { event: CREATE_EVENTS.chose, properties: { field: 'version', value: '1.21.1' } },
      { event: CREATE_EVENTS.chose, properties: { field: 'size', value: '10' } },
    ])
    // Back to the same answer: nothing new to say.
    steps.chose({ field: 'size', value: '20' })
    steps.chose({ field: 'size', value: '10' })
    await settled()
    expect(events()).toHaveLength(2)
  })

  test('the name only as filled or not, never what it says', async () => {
    const { steps } = view()
    for (const name of ['S', 'Sunset', 'Sunset Valley']) {
      const choices = choicesOf({ from: null, partySize: null, region: null, name, temporary: null })
      for (const chosen of choices) steps.chose(chosen)
    }
    await settled()
    expect(events()).toEqual([{ event: CREATE_EVENTS.chose, properties: { field: 'name', filled: true } }])
    expect(JSON.stringify(sent.mock.calls)).not.toContain('Sunset')
  })

  test('a choice the page opened with is not one made here', async () => {
    const { steps } = view()
    steps.known({ field: 'play', kind: 'template', key: 'skyblock' })
    steps.chose({ field: 'play', kind: 'template', key: 'skyblock' })
    await settled()
    expect(events()).toEqual([])
  })

  test('leaving says the furthest step and the time, by beacon, and only once', () => {
    const { steps, after } = view()
    steps.chose({ field: 'play', kind: 'template', key: 'survival' })
    steps.chose({ field: 'size', value: '5' })
    steps.chose({ field: 'region', value: 'eu' })
    after(27_400)
    steps.left()
    steps.left()
    expect(events()).toEqual([
      { event: CREATE_EVENTS.chose, properties: { field: 'play', kind: 'template', key: 'survival' } },
      { event: CREATE_EVENTS.chose, properties: { field: 'size', value: '5' } },
      { event: CREATE_EVENTS.chose, properties: { field: 'region', value: 'eu' } },
      { event: CREATE_EVENTS.left, properties: { last_step: 'size', seconds: 27, ...NOTHING_ELSE } },
    ])
    // Sent as the page goes, by the transport that outlives it (lib/insight.tsx).
    expect(sent.mock.calls.at(-1)?.[2]).toBe(true)
  })

  test('a view that only looked left at the start', () => {
    const { steps } = view()
    steps.opened({ first_server: true, source: undefined })
    steps.left()
    expect(events()).toEqual([
      { event: CREATE_EVENTS.opened, properties: { first_server: true } },
      { event: CREATE_EVENTS.left, properties: { last_step: 'opened', seconds: 0, ...NOTHING_ELSE } },
    ])
  })

  test('a press, its refusal, then a server: nothing left behind', () => {
    const { steps } = view()
    steps.blocked(['limit_reached'])
    steps.blocked(['limit_reached'])
    steps.blocked([])
    steps.pressed()
    steps.refused('Not A Code!')
    steps.done()
    steps.left()
    expect(events().map(({ event, properties }) => [event, properties])).toEqual([
      [CREATE_EVENTS.blocked, { reason: 'limit_reached' }],
      [CREATE_EVENTS.pressed, {}],
      [CREATE_EVENTS.refused, { code: 'other' }],
      [CREATE_EVENTS.done, { seconds: 0 }],
    ])
  })
})

describe('what a view does besides choosing', () => {
  beforeEach(() => sent.mockClear())

  test('a view that only read: how far it saw, that it pressed and typed nothing, and for how long', () => {
    const { steps, after } = view()
    steps.seen('button', false)
    after(4_000)
    steps.seen('size', false)
    steps.seen('size', false)
    after(8_000)
    steps.left()
    expect(events()).toEqual([
      { event: CREATE_EVENTS.seen, properties: { what: 'button', seconds: 0, ready: false } },
      { event: CREATE_EVENTS.seen, properties: { what: 'size', seconds: 4 } },
      {
        event: CREATE_EVENTS.left,
        properties: {
          last_step: 'opened',
          seconds: 12,
          presses: 0,
          typed: false,
          ready: false,
          furthest_seen: 'size',
        },
      },
    ])
  })

  test('presses that choose nothing: only the listed ones are named, every one is counted', () => {
    const { steps } = view()
    steps.touched()
    steps.acted('more_opened')
    steps.touched()
    steps.acted('packs_opened')
    steps.acted('someone typed this')
    steps.acted(undefined)
    steps.typed()
    steps.left()
    expect(events()).toEqual([
      { event: CREATE_EVENTS.acted, properties: { action: 'more_opened' } },
      { event: CREATE_EVENTS.acted, properties: { action: 'packs_opened' } },
      {
        event: CREATE_EVENTS.left,
        properties: {
          last_step: 'opened',
          seconds: 0,
          presses: 2,
          typed: true,
          ready: false,
          furthest_seen: 'play',
        },
      },
    ])
  })

  test('the button: pressed before it could be, with what was missing, then ready once', () => {
    const { steps, after } = view()
    steps.unready(['play', 'name'])
    steps.unready([])
    after(30_000)
    steps.ready(true)
    steps.ready(false)
    steps.ready(true)
    steps.left()
    expect(events().map(({ event, properties }) => [event, properties])).toEqual([
      [CREATE_EVENTS.unready, { missing: 'play,name' }],
      [CREATE_EVENTS.ready, { seconds: 30 }],
      [
        CREATE_EVENTS.left,
        { last_step: 'opened', seconds: 30, presses: 0, typed: false, ready: true, furthest_seen: 'play' },
      ],
    ])
  })

  test('nothing more once the server is made', () => {
    const { steps } = view()
    steps.done()
    sent.mockClear()
    steps.acted('more_opened')
    steps.seen('name', true)
    steps.ready(true)
    steps.unready(['name'])
    expect(events()).toEqual([])
  })

  test('what stands in the way of the button, by the page’s own rule', () => {
    const none = { from: null, name: '', preview: { error: null } }
    expect(missingOf(none, false)).toEqual(['play', 'size', 'name'])
    expect(missingOf(none, true)).toEqual(['play', 'name'])
    const survival = { kind: 'template', key: 'survival' } as const
    const needsPlus = { data: { size: { allowed: false } }, error: null } as unknown as Parameters<
      typeof missingOf
    >[0]['preview']
    expect(missingOf({ from: survival, name: 'Sunset', preview: needsPlus }, true)).toEqual(['plan'])
    expect(missingOf({ from: survival, name: ' ', preview: { error: new Error('x') } }, true)).toEqual([
      'name',
      'check',
    ])
    expect(missingOf({ from: survival, name: 'Sunset', preview: { error: null } }, true)).toEqual([])
  })
})
