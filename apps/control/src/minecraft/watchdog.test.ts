// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every server starts with the game's watchdog off, Paper's own as well, since a server frozen
 * asleep past it shuts itself down as it thaws (`watchdog.ts`).
 */
import { describe, expect, test } from 'bun:test'
import { defaultSettings, type ServerRevision } from '../domain/revision/revision.ts'
import { toRuntimeSpec } from './runtime-spec.ts'

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.3',
  loader: 'vanilla',
  loaderVersion: null,
  settings: defaultSettings({ name: 'Friends', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

const input = {
  serverId: 's-1',
  revision,
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
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'http://x/x.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

const envOf = (changes: Partial<ServerRevision>) =>
  toRuntimeSpec({ ...input, revision: { ...revision, ...changes } }).env

const pack = (javaProperties: Record<string, string>) => ({
  catalog: 'modrinth' as const,
  projectId: 'pack',
  versionId: 'v1',
  name: 'A Pack',
  versionLabel: '1.0',
  artifact: {
    ref: { kind: 'remote' as const, url: 'https://cdn.test/pack.mrpack' },
    sha512: 'a'.repeat(128),
    sizeBytes: 1024,
    fileName: 'pack.mrpack',
  },
  page: 'https://modrinth.com/modpack/pack',
  environment: 'both' as const,
  icon: null,
  javaProperties,
})

// A 26.3 server frozen 75 s took its first tick after the thaw for one that long, and shut itself
// down: "A single server tick took 74.98 seconds".
describe('the game’s watchdog', () => {
  test('never starts on Mojang’s server, Fabric or NeoForge', () => {
    for (const changes of [
      {},
      { loader: 'fabric' as const, loaderVersion: '0.17.2' },
      { loader: 'neoforge' as const, loaderVersion: '21.1.200' },
    ]) {
      const env = envOf(changes)
      expect(env.MAX_TICK_TIME).toBe('-1')
      expect(env.JVM_DD_OPTS).toBeUndefined()
    }
  })

  test('is off on Paper, Paper’s own as well', () => {
    for (const changes of [{ loader: 'paper' as const, loaderVersion: '254' }, { loaderVersion: '254' }]) {
      const env = envOf(changes)
      expect(env.TYPE).toBe('PAPER')
      expect(env.MAX_TICK_TIME).toBe('-1')
      expect(env.JVM_DD_OPTS).toBe('disable.watchdog=true')
    }
  })

  test('leaves a pack’s own Java properties as they are', () => {
    const env = envOf({
      loader: 'fabric',
      loaderVersion: '0.17.2',
      modpack: pack({ 'fml.queryResult': 'confirm' }),
    })
    expect(env.MAX_TICK_TIME).toBe('-1')
    expect(env.JVM_DD_OPTS).toBe('fml.queryResult=confirm')
  })
})
