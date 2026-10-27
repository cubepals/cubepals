// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds as real servers left them, captured into `world-fixtures/` from `itzg/minecraft-server`:
 * Minecraft 26.3 and 1.21.11, and Paper 26.3-226 and 1.21.11, each started once on a new world and
 * stopped. `files.txt` is each server folder's listing; the files a world is read by are kept
 * beside it as the servers wrote them.
 */
import { describe, expect, test } from 'bun:test'
import { LibraryFileFormats } from '../infra/formats/file-formats.ts'
import { moddedBrands, worldFacts } from './world-facts.ts'
import {
  chosenWorld,
  leftOutOf,
  modsBeside,
  placeInLevel,
  placeOnServer,
  playerFilePath,
  uploadHolds,
  worldGenSettingsPaths,
} from './world-layout.ts'

const FIXTURES = `${import.meta.dir}/world-fixtures`
const formats = new LibraryFileFormats()
const SERVERS = ['vanilla-26.3', 'vanilla-1.21.11', 'paper-26.3', 'paper-1.21.11'] as const
const LISTINGS = new Map(
  await Promise.all(
    SERVERS.map(
      async (server) =>
        [server, (await Bun.file(`${FIXTURES}/${server}/files.txt`).text()).trim().split('\n')] as const,
    ),
  ),
)
const listing = (server: (typeof SERVERS)[number]): string[] => [...(LISTINGS.get(server) ?? [])]
const read = async (server: string, path: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(`${FIXTURES}/${server}/${path}`).arrayBuffer())
const under = (folder: string, paths: readonly string[]) => paths.map((path) => `${folder}${path}`)

/** A world's facts as the import reads them, from the files a real server wrote. */
async function factsOf(server: string, levelDat: string, genSettings: string | null) {
  const decode = async (path: string) => formats.decodeNbt(await read(server, path))
  const properties = formats.decode(
    'properties',
    await Bun.file(`${FIXTURES}/${server}/server.properties`).text(),
  )
  return worldFacts(
    await decode(levelDat),
    genSettings === null ? undefined : await decode(genSettings),
    properties as Record<string, string>,
  )
}

describe('a server folder', () => {
  test.each(['vanilla-26.3', 'vanilla-1.21.11', 'paper-26.3', 'paper-1.21.11'])(
    '%s holds its one world',
    (server) => {
      const holds = uploadHolds(listing(server))
      expect(holds).toMatchObject({ kind: 'java', properties: 'server.properties' })
      if (holds.kind !== 'java') return
      expect(holds.worlds.map((world) => world.folder)).toEqual(['world/'])
      expect(chosenWorld(holds, 'world')?.folder).toBe('world/')
    },
  )

  test('Paper before 26.1 keeps the Nether and End beside the world, and they come with it', () => {
    const holds = uploadHolds(listing('paper-1.21.11'))
    if (holds.kind !== 'java') throw new Error('no world')
    const [world] = holds.worlds
    expect(world?.beside.sort()).toEqual(['world_nether/', 'world_the_end/'])
    const place = placeOnServer(world as NonNullable<typeof world>, 'world-2')
    expect(place('world_nether/DIM-1/region/r.0.0.mca')).toBe('world-2_nether/DIM-1/region/r.0.0.mca')
    expect(place('world_the_end/level.dat')).toBe('world-2_the_end/level.dat')
    expect(place('world/region/r.0.0.mca')).toBe('world-2/region/r.0.0.mca')
  })

  test('a world a new server starts on has its Nether and End inside, where other types read them', () => {
    const holds = uploadHolds(listing('paper-1.21.11'))
    if (holds.kind !== 'java') throw new Error('no world')
    const place = placeInLevel(holds.worlds[0] as NonNullable<(typeof holds.worlds)[0]>)
    expect(place('world/level.dat')).toBe('level.dat')
    expect(place('world/region/r.0.0.mca')).toBe('region/r.0.0.mca')
    expect(place('world_nether/DIM-1/region/r.0.0.mca')).toBe('DIM-1/region/r.0.0.mca')
    expect(place('world_the_end/DIM1/region/r.0.0.mca')).toBe('DIM1/region/r.0.0.mca')
    // The folders' own level.dat would stand where the world's goes; Paper makes them again.
    expect(place('world_the_end/level.dat')).toBeNull()
    expect(place('world_nether/DIM1/region/r.0.0.mca')).toBeNull()
    expect(place('server.properties')).toBeNull()
  })

  test('only the world goes on the server: the lock a game held and the rest of the folder stay out', () => {
    const files = listing('paper-26.3')
    const holds = uploadHolds(files)
    if (holds.kind !== 'java') throw new Error('no world')
    const world = chosenWorld(holds, 'world')
    if (world === null) throw new Error('no world chosen')
    const place = placeOnServer(world, 'world')
    expect(place('world/session.lock')).toBeNull()
    expect(place('plugins/spark/config.json')).toBeNull()
    expect(place('server.properties')).toBeNull()
    expect(place('world/dimensions/minecraft/the_nether/region/r.0.0.mca')).toBe(
      'world/dimensions/minecraft/the_nether/region/r.0.0.mca',
    )
    expect(leftOutOf(files, world, 100)).toEqual(
      expect.arrayContaining(['.paper/', 'config/', 'paper-26.3-226.jar', 'plugins/', 'server.properties']),
    )
    expect(leftOutOf(files, world, 100)).not.toContain('world/')
    expect(modsBeside(files, world)).toEqual([])
  })

  test('wrapped in a folder of its own, as a zip of the folder is', () => {
    const holds = uploadHolds(under('My Server/', listing('vanilla-1.21.11')))
    expect(holds).toMatchObject({ kind: 'java', properties: 'My Server/server.properties' })
    if (holds.kind !== 'java') return
    const world = chosenWorld(holds, 'world')
    expect(world?.folder).toBe('My Server/world/')
    expect(placeOnServer(world as NonNullable<typeof world>, 'world')('My Server/world/level.dat')).toBe(
      'world/level.dat',
    )
  })

  test('another level-name is the world it names, where the folder holds it', () => {
    const files = [...listing('vanilla-1.21.11'), 'survival/level.dat', 'survival/region/r.0.0.mca']
    const holds = uploadHolds(files)
    if (holds.kind !== 'java') throw new Error('no world')
    expect(chosenWorld(holds, 'survival')?.folder).toBe('survival/')
    expect(chosenWorld(holds, 'creative')).toBeNull()
  })
})

describe('a world on its own', () => {
  const save = listing('vanilla-1.21.11')
    .filter((path) => path.startsWith('world/'))
    .map((path) => path.slice('world/'.length))

  test('at the root of the upload, as a save folder dragged in is', () => {
    const holds = uploadHolds(save)
    expect(holds).toMatchObject({ kind: 'java', properties: null, worlds: [{ folder: '', folderName: '' }] })
    if (holds.kind !== 'java') return
    const world = chosenWorld(holds, null)
    expect(placeOnServer(world as NonNullable<typeof world>, 'world')('region/r.0.0.mca')).toBe(
      'world/region/r.0.0.mca',
    )
  })

  test('in its folder, whatever its player named it, with what macOS adds left out', () => {
    const files = [
      ...under('My World 🌲/', save),
      '__MACOSX/My World 🌲/._level.dat',
      'My World 🌲/.DS_Store',
    ]
    const holds = uploadHolds(files)
    if (holds.kind !== 'java') throw new Error('no world')
    expect(holds.worlds).toEqual([
      { folder: 'My World 🌲/', folderName: 'My World 🌲', beside: [], levelDat: 'My World 🌲/level.dat' },
    ])
    const place = placeOnServer(holds.worlds[0] as NonNullable<(typeof holds.worlds)[0]>, 'world')
    expect(place('My World 🌲/.DS_Store')).toBeNull()
  })

  test('a saves folder of several leaves the choice to the player', () => {
    const holds = uploadHolds([...under('saves/One/', save), ...under('saves/Two/', save)])
    if (holds.kind !== 'java') throw new Error('no world')
    expect(holds.worlds.map((world) => world.folderName)).toEqual(['One', 'Two'])
    expect(chosenWorld(holds, null)).toBeNull()
  })

  test('one with only its level.dat_old is still a world', () => {
    const holds = uploadHolds(save.filter((path) => path !== 'level.dat'))
    expect(holds).toMatchObject({ kind: 'java', worlds: [{ levelDat: 'level.dat_old' }] })
  })

  test('the host player goes where the world keeps players', () => {
    const holds = uploadHolds(save)
    if (holds.kind !== 'java') throw new Error('no world')
    const world = holds.worlds[0] as NonNullable<(typeof holds.worlds)[0]>
    const uuid = '6f1c1c3c-5b0e-4f6b-9d55-3b7a5b8f0e11'
    expect(playerFilePath(save, world, 'world', '1.21.11', uuid)).toBe(`world/playerdata/${uuid}.dat`)
    expect(playerFilePath(['level.dat'], world, 'world', '26.3', uuid)).toBe(`world/players/data/${uuid}.dat`)
  })
})

describe('what is not a Java world', () => {
  test('a Bedrock save is told apart, its own level.dat and all', () => {
    expect(uploadHolds(['My World/levelname.txt', 'My World/level.dat', 'My World/db/CURRENT'])).toEqual({
      kind: 'bedrock',
    })
    expect(uploadHolds(['levelname.txt', 'db/000005.ldb', 'world_icon.jpeg'])).toEqual({ kind: 'bedrock' })
  })

  test('nothing with a level.dat holds no world', () => {
    expect(uploadHolds(['mods/sodium.jar', 'options.txt'])).toEqual({ kind: 'nothing' })
  })
})

describe('a hostile upload’s names', () => {
  test('are looked at once each, however many level.dat files they hold', () => {
    // Half a million worlds in folders a few deep: every check a scan of the rest would take hours.
    const paths = Array.from({ length: 500_000 }, (_, i) =>
      i % 2 ? `w/${'d/'.repeat(i % 8)}${i}/level.dat` : `w/${'d/'.repeat(i % 8)}${i}/server.properties`,
    )
    const started = performance.now()
    const holds = uploadHolds(paths)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(holds.kind).toBe('java')
  })

  test('the jars a world ran with are its mods; its plugins add nothing of their own', () => {
    const holds = uploadHolds([
      'world/level.dat',
      'server.properties',
      'plugins/spark.jar',
      'mods/create.jar',
    ])
    if (holds.kind !== 'java') throw new Error('no world')
    expect(
      modsBeside(['world/level.dat', 'plugins/spark.jar', 'mods/create.jar'], holds.worlds[0] as never),
    ).toEqual(['mods/create.jar'])
  })
})

describe('what a world says of itself', () => {
  // The seed its own server gave for `/seed`.
  test('26.3 keeps its seed in a file of its own', async () => {
    const holds = uploadHolds(listing('vanilla-26.3'))
    if (holds.kind !== 'java') throw new Error('no world')
    const world = holds.worlds[0] as NonNullable<(typeof holds.worlds)[0]>
    const [own] = worldGenSettingsPaths(world)
    expect(await factsOf('vanilla-26.3', 'world/level.dat', own as string)).toEqual({
      name: 'world',
      gameVersion: '26.3',
      seed: '-2620341798662206206',
      levelType: 'minecraft:normal',
      hardcore: false,
      brands: ['vanilla'],
      hostPlayer: false,
      // As 26.1 and later write it: by name, in `difficulty_settings`.
      gameMode: 'survival',
      difficulty: 'easy',
    })
  })

  test('Paper 26.3 keeps it in its overworld', async () => {
    const holds = uploadHolds(listing('paper-26.3'))
    if (holds.kind !== 'java') throw new Error('no world')
    const world = holds.worlds[0] as NonNullable<(typeof holds.worlds)[0]>
    const [, overworld] = worldGenSettingsPaths(world)
    const facts = await factsOf('paper-26.3', 'world/level.dat', overworld as string)
    expect(facts).toMatchObject({ gameVersion: '26.3', brands: ['paper'], hostPlayer: false })
    expect('seed' in facts && facts.seed).toMatch(/^-?\d+$/)
    expect(moddedBrands(facts as { brands: string[] })).toEqual([])
  })

  test('1.21.11 keeps it in its level.dat', async () => {
    const facts = await factsOf('vanilla-1.21.11', 'world/level.dat', null)
    // Its difficulty by number, as releases before 26.1 write it: 1 is easy.
    expect(facts).toMatchObject({
      gameVersion: '1.21.11',
      levelType: 'minecraft:normal',
      hardcore: false,
      gameMode: 'survival',
      difficulty: 'easy',
    })
    expect('seed' in facts && facts.seed).toMatch(/^-?\d+$/)
  })

  test('a world opened with Fabric says so', async () => {
    const level = await formats.decodeNbt(
      new Uint8Array(await Bun.file(`${import.meta.dir}/player-fixtures/26.3/level.dat`).arrayBuffer()),
    )
    const facts = worldFacts(level, undefined, null)
    if ('refused' in facts) throw new Error(facts.refused)
    expect(moddedBrands(facts)).toEqual(['fabric'])
  })

  test('a world from before 1.9 names no release, and is refused', () => {
    expect(worldFacts({ Data: { LevelName: 'Old' } }, undefined, null)).toEqual({
      refused: 'This world is from before Minecraft 1.9, too old to open here.',
    })
  })
})
