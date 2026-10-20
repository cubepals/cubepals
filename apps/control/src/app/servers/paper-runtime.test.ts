// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plain Minecraft on Paper, as a container: the spec of a plain revision with a Paper build, the
 * step that starts a Paper jar already installed with no call to Paper's API, and the one that
 * gives any other server type back the Nether and End a Paper one kept beside the world, and the
 * world's state Paper 26 keeps in each dimension, Bukkit's connection throttle off, since every
 * player came through the edge's one address, and Paper reading a PROXY protocol header, which
 * tells it each player's own. Drift sees none of these steps. Whether a revision runs on Paper is `runsOnPaper`'s.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { installOf, PROXY_ENV, toRuntimeSpec, withoutOwnSteps } from '../../minecraft/runtime-spec.ts'
import { withoutPlanLimits } from './specs.ts'

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
const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'vanilla',
  loaderVersion: null,
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

describe('plain Minecraft on Paper', () => {
  test('plain Minecraft with a Paper build runs on Paper, and seeds no install of Mojang’s', () => {
    const onPaper = { ...revision, gameVersion: '1.21.11', loaderVersion: '132' }
    const spec = toRuntimeSpec({ ...input, revision: onPaper })
    expect(spec.env.TYPE).toBe('PAPER')
    expect(spec.env.PAPER_BUILD).toBe('132')
    expect(spec.env.PLUGINS).toBeUndefined()
    // Paper keeps the world as it lays it out: nothing is moved for it.
    expect(spec.entrypoint?.[2]).not.toContain('DIM-1')
    expect(installOf(onPaper)).toBeNull()
    expect(spec.storage.reconstructible).toBeUndefined()
    const mojang = { ...onPaper, loaderVersion: null }
    expect(toRuntimeSpec({ ...input, revision: mojang }).env.TYPE).toBe('VANILLA')
    expect(toRuntimeSpec({ ...input, revision: mojang }).env.PAPER_BUILD).toBeUndefined()
    expect(installOf(mojang)).not.toBeNull()
  })

  test('a server not on Paper first moves back the Nether and End a Paper one kept beside the world', () => {
    const script = toRuntimeSpec({ ...input, revision }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'dimensions-'))
    const put = (path: string, text: string) => {
      mkdirSync(dirname(`${data}/${path}`), { recursive: true })
      writeFileSync(`${data}/${path}`, text)
    }
    put('world/level.dat', 'level')
    put('world_nether/DIM-1/region/r.0.0.mca', 'paper nether')
    put('world_the_end/DIM1/region/r.0.0.mca', 'paper end')
    // An End the world already has of its own stays, and Paper's copy is left where it is.
    put('world/DIM1/region/r.0.0.mca', 'own end')
    const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
    const run = () => Bun.spawnSync(['/bin/sh', '-c', step], { env: { LEVEL: 'world' } }).exitCode
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/world/DIM-1/region/r.0.0.mca`, 'utf8')).toBe('paper nether')
    expect(existsSync(`${data}/world_nether/DIM-1`)).toBe(false)
    expect(readFileSync(`${data}/world/DIM1/region/r.0.0.mca`, 'utf8')).toBe('own end')
    expect(existsSync(`${data}/world_the_end/DIM1/region/r.0.0.mca`)).toBe(true)
    // Again, and on a world Paper never ran, it does nothing.
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/world/DIM-1/region/r.0.0.mca`, 'utf8')).toBe('paper nether')
    rmSync(data, { recursive: true })
  })

  test('a Paper server whose pinned jar the image installed starts it with no call to Paper’s API', () => {
    const onPaper = { ...revision, loaderVersion: '132' }
    const script = toRuntimeSpec({ ...input, revision: onPaper }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'paper-jar-'))
    const step = script
      .replaceAll('/data', data)
      .replace('exec /image/scripts/start "$@"', 'echo "$PAPER_CUSTOM_JAR"')
    const jar = () =>
      Bun.spawnSync(['/bin/sh', '-c', step], { env: { VERSION: '1.21.11', PAPER_BUILD: '132' } })
        .stdout.toString()
        .trim()
    // A first start: no jar yet, so the image installs it through the API.
    expect(jar()).toBe('')
    // A jar the image never finished installing, its results file naming none, is installed again.
    writeFileSync(`${data}/paper-1.21.11-132.jar`, 'jar')
    expect(jar()).toBe('')
    writeFileSync(`${data}/.paper.env`, `SERVER="${data}/paper-1.21.11-132.jar"\n`)
    expect(jar()).toBe(`${data}/paper-1.21.11-132.jar`)
    // Another build pinned is installed through the API.
    writeFileSync(`${data}/.paper.env`, `SERVER="${data}/paper-1.21.11-131.jar"\n`)
    expect(jar()).toBe('')
    rmSync(data, { recursive: true })
  })

  test('a Paper server lets in every player the edge brings, however close together', () => {
    const onPaper = { ...revision, loaderVersion: '132' }
    const script = toRuntimeSpec({ ...input, revision: onPaper }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'paper-throttle-'))
    const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
    const run = () => Bun.spawnSync(['/bin/sh', '-c', step], { env: { VERSION: '1.21.11' } }).exitCode
    // A first start: the setting alone, which Paper fills out with its defaults.
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/bukkit.yml`, 'utf8')).toBe('settings:\n  connection-throttle: -1\n')
    // A server that has run: Paper's own file, with only the throttle changed.
    writeFileSync(
      `${data}/bukkit.yml`,
      'settings:\n  allow-end: true\n  connection-throttle: 4000\n  query-plugins: true\nspawn-limits:\n  monsters: 70\n',
    )
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/bukkit.yml`, 'utf8')).toBe(
      'settings:\n  allow-end: true\n  connection-throttle: -1\n  query-plugins: true\nspawn-limits:\n  monsters: 70\n',
    )
    rmSync(data, { recursive: true })
  })

  test('drift sees none of Blockly’s own steps, Paper’s among them', () => {
    const icon = 'http://control.test/grass.png'
    const paper = toRuntimeSpec({ ...input, revision: { ...revision, loader: 'paper' }, iconUrl: icon })
    expect(paper.entrypoint?.[2]).toContain('PAPER_CUSTOM_JAR')
    expect(withoutOwnSteps(paper.entrypoint)).toBeUndefined()
    expect(withoutOwnSteps(toRuntimeSpec({ ...input, revision, iconUrl: icon }).entrypoint)).toBeUndefined()
    expect(withoutOwnSteps(toRuntimeSpec({ ...input, revision }).entrypoint)).toBeUndefined()
    // An entrypoint that isn't Blockly's steps before the image's start is compared as it is.
    expect(withoutOwnSteps(['/bin/sh', '-c', 'true'])).toEqual(['/bin/sh', '-c', 'true'])
  })
})

describe('Paper reading a PROXY header', () => {
  test('a Paper server reads a PROXY header, which the image’s health check then sends too', () => {
    const onPaper = { ...revision, loaderVersion: '132' }
    expect(toRuntimeSpec({ ...input, revision: onPaper }).env[PROXY_ENV]).toBe('TRUE')
    expect(toRuntimeSpec({ ...input, revision: { ...revision, loader: 'paper' } }).env[PROXY_ENV]).toBe(
      'TRUE',
    )
    expect(toRuntimeSpec({ ...input, revision }).env[PROXY_ENV]).toBeUndefined()
    expect(
      toRuntimeSpec({ ...input, revision: { ...revision, loader: 'fabric' } }).env[PROXY_ENV],
    ).toBeUndefined()

    const script = toRuntimeSpec({ ...input, revision: onPaper }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'paper-proxy-'))
    const global = `${data}/config/paper-global.yml`
    const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
    const run = (proxied = 'TRUE') =>
      Bun.spawnSync(['/bin/sh', '-c', step], { env: { VERSION: '1.21.11', [PROXY_ENV]: proxied } }).exitCode
    // A first start: the setting alone, which Paper fills out with its defaults.
    expect(run()).toBe(0)
    expect(readFileSync(global, 'utf8')).toBe('proxies:\n  proxy-protocol: true\n')
    // A server that has run: Paper's own file, with the setting first under `proxies:`.
    const papers = (proxyProtocol: string) =>
      `_version: 29\nproxies:\n  bungee-cord:\n    online-mode: true\n${proxyProtocol}  velocity:\n    enabled: false\n`
    writeFileSync(global, papers('  proxy-protocol: false\n'))
    expect(run()).toBe(0)
    const read =
      '_version: 29\nproxies:\n  proxy-protocol: true\n  bungee-cord:\n    online-mode: true\n  velocity:\n    enabled: false\n'
    expect(readFileSync(global, 'utf8')).toBe(read)
    expect(run()).toBe(0)
    expect(readFileSync(global, 'utf8')).toBe(read)
    // A file without it under `proxies:`, or without `proxies:` at all, gets it.
    writeFileSync(global, papers(''))
    expect(run()).toBe(0)
    expect(readFileSync(global, 'utf8')).toBe(read)
    writeFileSync(global, '_version: 29\n')
    expect(run()).toBe(0)
    expect(readFileSync(global, 'utf8')).toBe('_version: 29\nproxies:\n  proxy-protocol: true\n')
    // Without the image's word for it, Paper reads none: as the benches run it, joined directly.
    expect(run('')).toBe(0)
    expect(readFileSync(global, 'utf8')).toBe('_version: 29\nproxies:\n  proxy-protocol: false\n')
    rmSync(data, { recursive: true })
  })

  test('a Paper server running from before it read headers is not restarted for them', () => {
    const paper = toRuntimeSpec({ ...input, revision: { ...revision, loader: 'paper' } })
    const { [PROXY_ENV]: _, ...env } = paper.env
    const before = { ...paper, env, entrypoint: withoutOwnSteps(paper.entrypoint) }
    expect(withoutPlanLimits(paper)).toEqual(withoutPlanLimits(before))
  })
})

describe('a Paper 26 world on another server type', () => {
  test('has the state Paper kept in each dimension put back where Minecraft reads it', () => {
    const script = toRuntimeSpec({ ...input, revision }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'paper-world-'))
    const put = (path: string, text: string) => {
      mkdirSync(dirname(`${data}/${path}`), { recursive: true })
      writeFileSync(`${data}/${path}`, text)
    }
    const dims = 'world/dimensions/minecraft'
    // As Paper 26.2-133 left a world (2026-10-11): the overworld's own state in its folder, a
    // copy in each other dimension's, and Paper's files beside them.
    put('world/level.dat', 'level')
    put('world/data/minecraft/world_clocks.dat', 'clocks')
    for (const dim of ['overworld', 'the_nether', 'the_end']) {
      for (const file of ['game_rules', 'scheduled_events', 'weather', 'world_gen_settings', 'world_clocks'])
        put(`${dims}/${dim}/data/minecraft/${file}.dat`, `${dim} ${file}`)
      put(`${dims}/${dim}/data/minecraft/world_border.dat`, `${dim} border`)
      put(`${dims}/${dim}/data/paper/metadata.dat`, `${dim} paper`)
      put(`${dims}/${dim}/paper-world.yml`, `${dim} config`)
      put(`${dims}/${dim}/region/r.0.0.mca`, `${dim} chunks`)
    }
    // The volume, not a world's own `data` folders.
    const step = script
      .replace(/(["\s])\/data\b/g, `$1${data}`)
      .replace('exec /image/scripts/start "$@"', 'true')
    const run = () => Bun.spawnSync(['/bin/sh', '-c', step], { env: { LEVEL: 'world' } }).exitCode
    const read = (path: string) => readFileSync(`${data}/${path}`, 'utf8')
    expect(run()).toBe(0)
    // Where Minecraft and every loader read them, from the overworld.
    for (const file of ['game_rules', 'scheduled_events', 'weather', 'world_gen_settings'])
      expect(read(`world/data/minecraft/${file}.dat`)).toBe(`overworld ${file}`)
    expect(read('world/data/minecraft/world_clocks.dat')).toBe('clocks')
    // What each dimension keeps in every server type stays; Paper's own goes aside, not away.
    expect(read(`${dims}/the_nether/region/r.0.0.mca`)).toBe('the_nether chunks')
    expect(read(`${dims}/the_end/data/minecraft/world_border.dat`)).toBe('the_end border')
    expect(existsSync(`${dims}/overworld/data/paper`)).toBe(false)
    expect(existsSync(`${dims}/the_nether/data/minecraft/game_rules.dat`)).toBe(false)
    const aside = '.blockly-paper/world/dimensions/minecraft'
    expect(read(`${aside}/the_nether/data/minecraft/game_rules.dat`)).toBe('the_nether game_rules')
    expect(read(`${aside}/the_end/data/paper/metadata.dat`)).toBe('the_end paper')
    expect(read(`${aside}/overworld/paper-world.yml`)).toBe('overworld config')
    // Again, the world now as Minecraft keeps it, it does nothing.
    put('world/data/minecraft/game_rules.dat', 'played since')
    expect(run()).toBe(0)
    expect(read('world/data/minecraft/game_rules.dat')).toBe('played since')
    expect(read(`${aside}/the_nether/data/minecraft/game_rules.dat`)).toBe('the_nether game_rules')
    rmSync(data, { recursive: true })
  })
})
