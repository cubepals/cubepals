// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plain Minecraft on Paper plays as Minecraft does: its first start on Paper writes the settings
 * that turn Paper's changes to the game back, before Paper's own step adds the PROXY header to them,
 * and a later start, or a Paper server made as one, leaves Paper's files as they are.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { PROXY_ENV, toRuntimeSpec } from '../../minecraft/runtime-spec.ts'

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.2',
  loader: 'vanilla',
  loaderVersion: '60',
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 10 }),
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
  world: {
    id: 'w',
    serverId: 's-1',
    levelName: 'world',
    name: 'World',
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    generatedOnVersion: '26.2',
  },
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'https://example.test/a.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

/** Runs a revision's own steps on a folder standing in for its volume; the folder. */
const started = (on: ServerRevision, data = mkdtempSync(join(tmpdir(), 'vanilla-paper-'))) => {
  const script = toRuntimeSpec({ ...input, revision: on }).entrypoint?.[2] ?? ''
  const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
  const run = Bun.spawnSync(['/bin/sh', '-c', step], { env: { VERSION: '26.2', [PROXY_ENV]: 'TRUE' } })
  expect(run.exitCode).toBe(0)
  return data
}

describe('plain Minecraft on Paper', () => {
  test('its first start writes the settings that play as Minecraft does, and the PROXY header joins them', () => {
    const data = started(revision)
    const global = readFileSync(`${data}/config/paper-global.yml`, 'utf8')
    expect(global).toContain('unsupported-settings:\n  allow-headless-pistons: true\n')
    expect(global).toContain('  allow-piston-duplication: true\n')
    expect(global).toEndWith('proxies:\n  proxy-protocol: true\n')
    const world = readFileSync(`${data}/config/paper-world-defaults.yml`, 'utf8')
    expect(world).toContain('hopper:\n  cooldown-when-full: false\n')
    expect(readFileSync(`${data}/spigot.yml`, 'utf8')).toContain('world-settings:\n  default:\n')
    rmSync(data, { recursive: true })
  })

  test('a server that ran on Paper before keeps the files it has', () => {
    const data = mkdtempSync(join(tmpdir(), 'vanilla-paper-'))
    writeFileSync(`${data}/spigot.yml`, 'config-version: 12\n')
    started(revision, data)
    expect(readFileSync(`${data}/spigot.yml`, 'utf8')).toBe('config-version: 12\n')
    // And a second start writes nothing again.
    const global = readFileSync(`${data}/config/paper-global.yml`, 'utf8')
    started(revision, data)
    expect(readFileSync(`${data}/config/paper-global.yml`, 'utf8')).toBe(global)
    rmSync(data, { recursive: true })
  })

  test('a Paper server made as one keeps Paper’s own defaults', () => {
    const data = started({ ...revision, loader: 'paper', loaderVersion: '60' })
    expect(readFileSync(`${data}/config/paper-global.yml`, 'utf8')).toBe('proxies:\n  proxy-protocol: true\n')
    expect(() => readFileSync(`${data}/spigot.yml`, 'utf8')).toThrow()
    rmSync(data, { recursive: true })
  })
})
