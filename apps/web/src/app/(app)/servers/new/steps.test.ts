// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the create page reports, with a mock standing in for posthog-js's capture: a choice once
 * its field settles, never the name's text, and where a view stopped when it leaves.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CREATE_EVENTS, choicesOf, createSteps } from './steps.ts'

const sent = mock((_event: string, _properties: Record<string, unknown>, _leaving?: boolean) => {})

const SETTLE = 20
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
      { event: CREATE_EVENTS.left, properties: { last_step: 'size', seconds: 27 } },
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
      { event: CREATE_EVENTS.left, properties: { last_step: 'opened', seconds: 0 } },
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
