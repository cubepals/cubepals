// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Cached faces expire at their boundary, retain identities and preserve real limiter refusals. */
import { expect, spyOn, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { MemoryLimits } from '../../infra/limits/memory-limits.ts'
import { PlayerFaces } from './faces.ts'

test('a cached absence expires exactly when its hour ends', async () => {
  let clock = Date.now()
  const now = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const profiles = new FakeProfiles()
    const steve = await profiles.byName('Steve')
    if (!steve) throw new Error('The profile fixture must supply Steve')
    const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })
    expect(await faces.face(steve.uuid)).toBeNull()
    expect(profiles.skinLookups).toBe(1)
    clock += HOUR_MS - 1
    expect(await faces.face(steve.uuid)).toBeNull()
    expect(profiles.skinLookups).toBe(1)
    clock++
    expect(await faces.face(steve.uuid)).toBeNull()
    expect(profiles.skinLookups).toBe(2)
  } finally {
    now.mockRestore()
  }
})

test('two account identities retain separate cached answers', async () => {
  const profiles = new FakeProfiles()
  const steve = await profiles.byName('Steve'),
    alex = await profiles.byName('Alex')
  if (!steve || !alex) throw new Error('The profile service must supply two distinct identities')
  const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })
  expect(await faces.face(steve.uuid)).toBeNull()
  expect(await faces.face(alex.uuid)).toBeNull()
  expect(profiles.skinLookups).toBe(2)
  expect(await faces.face(steve.uuid)).toBeNull()
  expect(await faces.face(alex.uuid)).toBeNull()
  expect(profiles.skinLookups).toBe(2)
})

test('a name lookup preserves the real limiter refusal instead of treating it as a UUID', async () => {
  const profiles = new FakeProfiles(),
    limits = new MemoryLimits()
  const allowed = spyOn(limits, 'allow')
  try {
    const faces = new PlayerFaces({ profiles, limits })
    expect(await faces.named('Alex')).toBeNull()
    const request = allowed.mock.calls[0]
    if (!request) throw new Error('A real lookup must reserve its rate budget')
    const [key, limit] = request
    for (let index = 0; index <= limit; index++) await limits.allow(key, limit)
    expect(await faces.named('Steve')).toBe('unavailable')
    expect(profiles.skinLookups).toBe(1)
  } finally {
    allowed.mockRestore()
  }
})
