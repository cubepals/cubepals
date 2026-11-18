// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a server's Java holds its memory, as its runtime spec gives it (`heap-flags.ts`).
 */
import { describe, expect, test } from 'bun:test'
import { toRuntimeSpec } from './runtime-spec.ts'
import { javaFor } from './versions.ts'

/** The server every toRuntimeSpec test starts from. */
const input = {
  serverId: 's-1',
  world: {
    id: 'w',
    serverId: 's-1',
    levelName: 'world',
    name: 'World',
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    generatedOnVersion: '26.3',
  },
  memoryTier: '4g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'https://example.test/a.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}
const revision = {
  id: 'r',
  serverId: 's-1',
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
}

describe('heap flags', () => {
  test("a server's heap starts small, is never pre-touched, and grows from a start that covers an idle server", () => {
    // Pre-touched with -Xms at -Xmx, a 3 GB server held 2.3 GiB awake, idle or asleep, for a
    // live heap under 300 MiB (heap-flags.ts).
    const spec = toRuntimeSpec({ ...input, revision, memoryTier: '3g' })
    expect(spec.env.USE_AIKAR_FLAGS).toBeUndefined()
    expect(spec.env.MEMORY).toBeUndefined()
    expect(spec.env.INIT_MEMORY).toBe('1024M')
    expect(spec.env.MAX_MEMORY).toBe('2048M')
    const flags = (spec.env.JVM_XX_OPTS ?? '').split(' ')
    expect(flags).not.toContain('-XX:+AlwaysPreTouch')
    expect(flags).toContain('-XX:+UseG1GC')
    expect(flags).toContain('-XX:G1HeapRegionSize=8M')
    // A 256 MB start doubled G1's young collections and raised the worst ticks (heap-flags.ts).
    expect(flags.some((flag) => flag.includes('HeapFreeRatio'))).toBe(false)
    expect(flags).toContain('-XX:+UseCompactObjectHeaders')
    expect(flags.some((flag) => flag.includes('PeriodicGC'))).toBe(false)
    // Plain Minecraft runs on Alpine's musl, where glibc's arenas mean nothing.
    expect(spec.image).toEndWith('-alpine')
    expect(spec.env.MALLOC_ARENA_MAX).toBeUndefined()
  })

  test("Java's memory flags follow the image's C library, Java's release and the heap's size", () => {
    const paper = toRuntimeSpec({ ...input, revision: { ...revision, loader: 'paper' as const } })
    expect(paper.env.MALLOC_ARENA_MAX).toBe('2')
    // Java before 25 refuses compact headers and wouldn't start.
    const old = toRuntimeSpec({ ...input, revision: { ...revision, gameVersion: '1.20.1' } })
    expect(javaFor('1.20.1')).toBeLessThan(25)
    expect(old.env.JVM_XX_OPTS).not.toContain('UseCompactObjectHeaders')
    // Aikar's larger young generation and regions from a 12 GB heap, as the image chose them.
    const large = toRuntimeSpec({ ...input, revision, memoryTier: '16g' })
    expect(large.env.MAX_MEMORY).toBe('12288M')
    expect(large.env.JVM_XX_OPTS).toContain('-XX:G1HeapRegionSize=16M')
    expect(large.env.JVM_XX_OPTS).toContain('-XX:G1NewSizePercent=40')
  })
})
