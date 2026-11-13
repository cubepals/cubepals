// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings Cubepals gives Paper for how it runs (`minecraft/paper-defaults.ts`): a server with
 * no `config/paper-world-defaults.yml` is given them before Paper starts, one that has the file gets
 * only the lines still holding Paper's own default rewritten, and whatever somebody chose stays.
 * Each test stands a folder in for `/data` and runs the real start's steps in a real shell.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { PROXY_ENV, toRuntimeSpec } from '../../minecraft/runtime-spec.ts'

/** A server made as Paper; `plain` is plain Minecraft run on the same Paper build. */
const paper: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'paper',
  loaderVersion: '132',
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}
const plain: ServerRevision = { ...paper, loader: 'vanilla' }
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
    generatedOnVersion: '1.21.11',
  },
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'https://example.test/a.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

/**
 * Part of the file Paper 1.21.11 writes with every setting at its default, as the image copies it
 * to a new server: its head, and the sections around the settings, whole.
 */
const STOCK = `# This is the world defaults configuration file for Paper.
# File Reference: https://docs.papermc.io/paper/reference/world-configuration/

_version: 31
anticheat:
  anti-xray:
    enabled: false
    engine-mode: 1
    max-block-height: 64
    update-radius: 2
chunks:
  auto-save-interval: default
  delay-chunk-unloads-by: 10s
  entity-per-chunk-save-limit:
    arrow: -1
    ender_pearl: -1
    experience_orb: -1
    fireball: -1
    small_fireball: -1
    snowball: -1
  fixed-chunk-inhabited-time: -1
  flush-regions-on-save: false
  max-auto-save-chunks-per-tick: 24
  prevent-moving-into-unloaded-chunks: false
collisions:
  allow-player-cramming-damage: false
  allow-vehicle-collisions: true
  fix-climbing-bypassing-cramming-rule: false
  max-entity-collisions: 8
  only-players-collide: false
environment:
  disable-explosion-knockback: false
  disable-ice-and-snow: false
  disable-thunder: false
  fire-tick-delay: 30
  frosted-ice:
    delay:
      max: 40
      min: 20
    enabled: true
  generate-flat-bedrock: false
  locate-structures-outside-world-border: false
  max-block-ticks: 65536
  max-fluid-ticks: 65536
  nether-ceiling-void-damage-height: disabled
  optimize-explosions: false
  portal-create-radius: 16
  portal-search-radius: 128
  portal-search-vanilla-dimension-scaling: true
  treasure-maps:
    enabled: true
    find-already-discovered:
      loot-tables: default
      villager-trade: false
  void-damage-amount: 4.0
  void-damage-min-build-height-offset: -64.0
  water-over-lava-flow-speed: 5
hopper:
  cooldown-when-full: true
  disable-move-event: false
  ignore-occluding-blocks: false
`

const SAVES = ['  max-auto-save-chunks-per-tick: 24\n', '  max-auto-save-chunks-per-tick: 8\n'] as const

let data = ''
afterEach(() => {
  if (data !== '') rmSync(data, { recursive: true, force: true })
  data = ''
})

/** A folder standing in for a volume, holding `defaults` as Paper's world defaults where given. */
function volume(defaults?: string): string {
  data = mkdtempSync(join(tmpdir(), 'paper-defaults-'))
  if (defaults !== undefined) {
    mkdirSync(join(data, 'config'))
    writeFileSync(join(data, 'config/paper-world-defaults.yml'), defaults)
  }
  return data
}

/** Runs a revision's own steps, as far as the image's start, on the volume. */
function start(on: ServerRevision): void {
  const script = toRuntimeSpec({ ...input, revision: on }).entrypoint?.[2] ?? ''
  const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
  const env = { VERSION: '1.21.11', LEVEL: 'world', [PROXY_ENV]: 'TRUE' }
  expect(Bun.spawnSync(['/bin/sh', '-c', step], { env }).exitCode).toBe(0)
}

const file = () => join(data, 'config/paper-world-defaults.yml')
const read = () => readFileSync(file(), 'utf8')
/** Paper's two files and nothing else: no file the step worked in is left beside them. */
const configFolder = () => readdirSync(join(data, 'config')).sort()

describe('a server with no world defaults yet', () => {
  test('made as Paper, is given the settings alone before Paper starts', () => {
    volume()
    start(paper)
    expect(read()).toBe(
      'chunks:\n  max-auto-save-chunks-per-tick: 8\nenvironment:\n  optimize-explosions: true\n',
    )
    expect(configFolder()).toEqual(['paper-global.yml', 'paper-world-defaults.yml'])
    expect(statSync(file()).uid).toBe(statSync(data).uid)
  })

  test('plain Minecraft on Paper, has the chunk setting beside its own, and Mojang’s explosions', () => {
    volume()
    start(plain)
    expect(read()).toStartWith(
      'chunks:\n  delay-chunk-unloads-by: 0s\n  max-auto-save-chunks-per-tick: 8\ncollisions:\n',
    )
    // Once each: the file is written by one step, and the other finds nothing to rewrite.
    expect(read().split('max-auto-save-chunks-per-tick')).toHaveLength(2)
    expect(read()).toContain('hopper:\n  cooldown-when-full: false\n')
    expect(read()).not.toContain('optimize-explosions')
    expect(configFolder()).toEqual(['paper-global.yml', 'paper-world-defaults.yml'])
  })
})

describe('a server that ran on Paper before', () => {
  test('keeps its file byte for byte, Paper’s own defaults among its values', () => {
    for (const on of [paper, plain]) {
      volume(STOCK)
      const { ino } = statSync(file())
      start(on)
      expect(read()).toBe(STOCK)
      expect(statSync(file()).ino).toBe(ino)
      expect(configFolder()).toEqual(['paper-global.yml', 'paper-world-defaults.yml'])
      rmSync(data, { recursive: true })
    }
  })

  test('keeps what somebody chose', () => {
    const kept = STOCK.replace(SAVES[0], '  max-auto-save-chunks-per-tick: 48\n')
    volume(kept)
    start(paper)
    expect(read()).toBe(kept)
  })
})

describe('the step and what is around it', () => {
  test('writes inside the volume where the file is a link out of it', () => {
    volume()
    const outside = `${data}-outside`
    writeFileSync(outside, STOCK)
    mkdirSync(join(data, 'config'))
    symlinkSync(outside, file())
    start(paper)
    expect(readFileSync(outside, 'utf8')).toBe(STOCK)
    expect(lstatSync(file()).isSymbolicLink()).toBe(false)
    expect(read()).toContain(SAVES[1])
    rmSync(outside)
  })

  test('runs on Paper alone: another server type’s start leaves the file as it finds it', () => {
    const scriptOf = (on: ServerRevision) => toRuntimeSpec({ ...input, revision: on }).entrypoint?.[2] ?? ''
    expect(scriptOf(paper)).toContain('max-auto-save-chunks-per-tick')
    expect(scriptOf(plain)).toContain('max-auto-save-chunks-per-tick')
    expect(scriptOf(plain)).not.toContain('optimize-explosions')
    const others: ServerRevision[] = [
      { ...plain, loaderVersion: null },
      { ...paper, loader: 'fabric', loaderVersion: null },
    ]
    for (const other of others) {
      expect(scriptOf(other)).not.toContain('max-auto-save-chunks-per-tick')
      expect(scriptOf(other)).not.toContain('optimize-explosions')
      volume(STOCK)
      start(other)
      expect(read()).toBe(STOCK)
      rmSync(data, { recursive: true })
    }
  })
})
