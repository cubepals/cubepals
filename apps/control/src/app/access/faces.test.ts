// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { MemoryLimits } from '../../infra/limits/memory-limits.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { PlayerFaces } from './faces.ts'
import { offlineUuid } from './identity.ts'

/** A skin whose head is one colour. */
function plainSkin([r, g, b]: [number, number, number]) {
  const rgba = new Uint8Array(64 * 64 * 4)
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) rgba.set([r, g, b, 255], (y * 64 + x) * 4)
  return { width: 64, height: 64, rgba }
}

async function accountOf(profiles: FakeProfiles, name: string): Promise<string> {
  return (await profiles.byName(name))?.uuid ?? ''
}

describe('player faces', () => {
  test('a player wearing a skin has its face, asked for once and kept', async () => {
    const profiles = new FakeProfiles()
    profiles.wear('Steve', plainSkin([10, 200, 30]))
    const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })
    const uuid = await accountOf(profiles, 'Steve')

    const face = await faces.face(uuid)
    expect(face).toBeInstanceOf(Uint8Array)
    expect([...(face as Uint8Array).slice(0, 4)]).toEqual([10, 200, 30, 255])
    // Dashed or not, it is the same player, and Mojang is not asked twice.
    const dashed = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`
    expect(await faces.face(dashed)).toEqual(face)
    expect(profiles.skinLookups).toBe(1)
  })

  test('a player without a skin of their own has none, and that is kept too', async () => {
    const profiles = new FakeProfiles()
    const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })
    const uuid = await accountOf(profiles, 'Alex')
    expect(await faces.face(uuid)).toBeNull()
    expect(await faces.face(uuid)).toBeNull()
    expect(profiles.skinLookups).toBe(1)
  })

  test('a UUID a server made up from a name is never looked up as an account', async () => {
    const profiles = new FakeProfiles()
    const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })
    expect(await faces.face(offlineUuid('Steve'))).toBeNull()
    expect(await faces.face('../../etc/passwd')).toBeNull()
    expect(profiles.skinLookups).toBe(0)
  })

  test('where the server doesn’t verify accounts, the name finds the face of the account that has it', async () => {
    const profiles = new FakeProfiles()
    profiles.wear('Steve', plainSkin([10, 200, 30]))
    profiles.unknown('NoAccountHere')
    const faces = new PlayerFaces({ profiles, limits: new MemoryLimits() })

    const face = await faces.named('Steve')
    expect([...(face as Uint8Array).slice(0, 4)]).toEqual([10, 200, 30, 255])
    // The same account as its UUID: one lookup of its skin, whichever way it was asked for.
    expect(await faces.face(await accountOf(profiles, 'Steve'))).toEqual(face)
    expect(await faces.named('steve')).toEqual(face)
    expect(profiles.skinLookups).toBe(1)

    expect(await faces.named('NoAccountHere')).toBeNull()
    expect(await faces.named('not a name!')).toBeNull()
    expect(profiles.skinLookups).toBe(1)
  })

  test('when Mojang cannot answer, the face is unavailable for now, not missing', async () => {
    const profiles = new FakeProfiles()
    const uuid = await accountOf(profiles, 'Steve')
    let asked = 0
    const failing: PlayerProfiles = {
      byName: (name) => profiles.byName(name),
      byUuid: (id) => profiles.byUuid(id),
      skinOf: async () => {
        asked++
        throw new Error('Mojang answered 429')
      },
    }
    const faces = new PlayerFaces({ profiles: failing, limits: new MemoryLimits() })
    expect(await faces.face(uuid)).toBe('unavailable')
    // Tried again later, not on every row that shows the player.
    expect(await faces.face(uuid)).toBe('unavailable')
    expect(asked).toBe(1)
  })

  test('lookups are counted, so a flood of faces cannot get Blockly refused by Mojang', async () => {
    const profiles = new FakeProfiles()
    const faces = new PlayerFaces({ profiles, limits: { allow: async () => false } })
    expect(await faces.face(await accountOf(profiles, 'Steve'))).toBe('unavailable')
    expect(profiles.skinLookups).toBe(0)
  })
})
