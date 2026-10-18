// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the owner reads about who came by while their server rested. */

import { expect, test } from 'bun:test'
import { cameByLine } from './came-by-line.ts'

const now = new Date(2026, 9, 17, 12, 0).getTime()
const at = (hours: number, minutes: number, day = 17) => new Date(2026, 9, day, hours, minutes).toISOString()
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const person = (name: string, when: string) => ({ name, uuid: crypto.randomUUID(), at: when })

test('nobody came by: nothing to say', () => {
  expect(cameByLine({ cameBy: [], stopReason: 'daily', name: 'Sunset Valley' }, now)).toBeNull()
})

test('on the server’s page: who, when, and what they were told, not why it rests again', () => {
  const when = at(9, 54)
  expect(
    cameByLine({ cameBy: [person('Alex', when)], stopReason: 'daily', name: 'Sunset Valley' }, now),
  ).toBe(`Alex tried to join at ${time(when)}. Cubepals told them when it’s back.`)
})

test('on the list of servers it names the server, and says yesterday for yesterday', () => {
  const when = at(22, 10, 16)
  expect(
    cameByLine({ cameBy: [person('Alex', when)], stopReason: 'daily', name: 'Sunset Valley' }, now, true),
  ).toBe(
    `Alex tried to join Sunset Valley yesterday at ${time(when)}, after today’s play was used up. Cubepals told them when it’s back.`,
  )
})

test('several came by after the free trial: the first two by name, and the latest try', () => {
  const cameBy = [person('Alex', at(9, 54)), person('Sam', at(9, 40)), person('Noor', at(9, 1))]
  expect(cameByLine({ cameBy, stopReason: 'free_hours', name: 'Sunset Valley' }, now)).toBe(
    `Alex, Sam and 1 other tried to join, the last at ${time(at(9, 54))}. Cubepals told them it’s resting for now.`,
  )
})

test('on the list of servers, after the free trial, it says why', () => {
  const when = at(9, 54)
  expect(
    cameByLine(
      { cameBy: [person('Alex', when)], stopReason: 'free_hours', name: 'Sunset Valley' },
      now,
      true,
    ),
  ).toBe(
    `Alex tried to join Sunset Valley at ${time(when)}, after your free trial’s hours were played. Cubepals told them it’s resting for now.`,
  )
})
