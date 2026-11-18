// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Servers pinned to Cubepals' own image: the pin as configured, what a pinned server and every
 * other one runs, and a pin that isn't one changing nothing.
 */
import { describe, expect, test } from 'bun:test'
import { type ImagePin, imagePinOf, pinnedImage } from './image-pin.ts'
import { imageFor, toRuntimeSpec } from './runtime-spec.ts'

const PINNED = '6f1c1b5e-6a51-4c56-9d2f-0c1f0e9a4b11'
const OTHER = '2b9e4d77-3c8a-4f0e-8b6d-5a2c1e7f9d03'
const digest = (n: string) => `sha256:${n.repeat(64)}`
const IMAGE_25 = `registry.fly.io/bly-prod-control:server-java25-0123456789ab@${digest('a')}`
const IMAGE_21 = `registry.fly.io/bly-prod-control:server-java21-0123456789ab@${digest('b')}`
const pin: ImagePin = { servers: [PINNED], images: { '25': IMAGE_25, '21': IMAGE_21 } }

describe('SERVER_IMAGE_PIN', () => {
  const read = (value: string | undefined) => {
    const said: string[] = []
    return { pin: imagePinOf(value, (line) => said.push(line)), said }
  }

  test('unset or empty pins nothing, and says nothing', () => {
    expect(read(undefined)).toEqual({ pin: null, said: [] })
    expect(read('')).toEqual({ pin: null, said: [] })
  })

  test('a pin is read as given', () => {
    expect(read(JSON.stringify(pin))).toEqual({ pin, said: [] })
  })

  test('one that is not a pin pins nothing, and says so once', () => {
    const notJson = read('{servers')
    expect(notJson.pin).toBeNull()
    expect(notJson.said).toHaveLength(1)
    // A tag without its digest could change under the server; a server named by anything but its id.
    for (const wrong of [
      { servers: [PINNED], images: { '25': 'registry.fly.io/bly-prod-control:server-java25-0123456789ab' } },
      { servers: ['duels'], images: { '25': IMAGE_25 } },
      { servers: [PINNED], images: { '11': IMAGE_25 } },
    ]) {
      const result = read(JSON.stringify(wrong))
      expect(result.pin).toBeNull()
      expect(result.said).toHaveLength(1)
      expect(result.said[0]).toContain('no server is pinned')
    }
  })
})

describe('a pinned image', () => {
  test('is the one for the server’s Java, on a listed server only', () => {
    expect(pinnedImage(pin, PINNED, 25)).toBe(IMAGE_25)
    expect(pinnedImage(pin, PINNED, 21)).toBe(IMAGE_21)
    expect(pinnedImage(pin, PINNED, 17)).toBeNull()
    expect(pinnedImage(pin, OTHER, 25)).toBeNull()
    expect(pinnedImage(null, PINNED, 25)).toBeNull()
  })
})

describe('a runtime spec with a pin', () => {
  const input = (serverId: string) => ({
    serverId,
    world: {
      id: 'w',
      serverId,
      levelName: 'world',
      name: 'World',
      seed: null,
      levelType: 'minecraft:normal',
      hardcore: false,
      generatedOnVersion: '26.3',
    },
    memoryTier: '3g' as const,
    rconPassword: 'secret',
    artifactUrl: () => 'https://example.test/a.jar',
    limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
    iconUrl: null,
    revision: {
      id: 'r',
      serverId,
      number: 1,
      gameVersion: '26.3',
      loader: 'vanilla' as const,
      loaderVersion: null,
      settings: {
        difficulty: 'normal' as const,
        defaultGameMode: 'survival' as const,
        pvp: true,
        viewDistance: 10,
        simulationDistance: 10,
        maxPlayers: 10,
        motd: 'Sunset Valley',
        spawnProtection: 0,
        onlineMode: true,
      },
      mods: [],
      modpack: null,
      files: [],
      acknowledgedRevoked: [],
      reason: 'created' as const,
      basedOnRevisionId: null,
      createdBy: 'u',
    },
  })

  test('moves the listed server to its pinned image, and nothing else of it but the heap flags', () => {
    const before = toRuntimeSpec(input(PINNED))
    const after = toRuntimeSpec({ ...input(PINNED), imagePin: pin })
    // Plain 26.3 runs itzg's Alpine build; pinned, it runs Cubepals' own, which isn't Alpine.
    expect(before.image).toBe(imageFor(input(PINNED).revision))
    expect(before.image).toEndWith('-alpine')
    expect(after.image).toBe(IMAGE_25)
    expect({ ...after, image: before.image, env: before.env }).toEqual(before)
  })

  test('leaves every other server exactly as it was', () => {
    expect(toRuntimeSpec({ ...input(OTHER), imagePin: pin })).toEqual(toRuntimeSpec(input(OTHER)))
  })

  test('leaves a pinned server on a Java the pin names no image for', () => {
    const old = { ...input(PINNED), revision: { ...input(PINNED).revision, gameVersion: '1.20.1' } }
    expect(toRuntimeSpec({ ...old, imagePin: pin })).toEqual(toRuntimeSpec(old))
  })
})
