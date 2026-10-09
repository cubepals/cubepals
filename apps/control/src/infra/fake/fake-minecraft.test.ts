import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { RuntimeHandle, RuntimeSpec } from '../../app/ports/runtime.ts'
import { FakeMinecraft } from './fake-minecraft.ts'
import { FakeProfiles } from './fake-profiles.ts'
import type { FakeMachine } from './fake-runtime.ts'

// What the fake game answers and leaves on disk, pinned word for word: the access reconciler, the
// settings and the mods code read it as they would read a real server.

let root: string
let server: ReturnType<typeof Bun.serve>
let base: string
/** The jar served at `/jars/good.jar`, and when it was last published. */
const JAR = zipSync({ 'fabric.mod.json': strToU8('{}') })
let published = new Date('2026-01-01T00:00:00Z')

const pack = (index: unknown, extra: Record<string, Uint8Array> = {}) =>
  zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(index)), ...extra })
let served: Uint8Array = pack({})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'blockly-fake-minecraft-'))
  // Bun's own Response, which Bun.serve sends. A test file that ran the harness first leaves
  // @hono/node-server's in the global's place, which Bun.serve can't send; fetch still makes Bun's.
  const Answer = (await fetch('data:,')).constructor as typeof Response
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/jars/good.jar' || path === '/jars/other%20one.jar' || path.startsWith('/files/'))
        return new Answer(JAR, { headers: { 'last-modified': published.toUTCString() } })
      if (path === '/jars/bad.jar') return new Answer('not a jar')
      if (path === '/pack.mrpack') return new Answer(served)
      return new Answer('missing', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
})

let count = 0
const spec = (env: Record<string, string>): RuntimeSpec => ({
  image: 'image',
  env,
  secrets: { RCON_PASSWORD: 'secret' },
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 3 },
  ports: [],
  stop: { signal: 'SIGTERM', timeoutSeconds: 60 },
  labels: {},
})
async function machine(env: Record<string, string> = {}): Promise<FakeMachine> {
  count++
  const dir = await mkdtemp(join(root, 'server-'))
  return { key: `server-${count}`, dir, spec: spec(env), host: `host-${count}` }
}
const fresh = () => {
  const profiles = new FakeProfiles()
  return { profiles, minecraft: new FakeMinecraft(profiles, (handle) => handle as string) }
}
const target = (m: FakeMachine, password = 'secret') => ({
  endpoint: { host: m.host, port: 25575 },
  passwords: [password],
})
const json = async (minecraft: FakeMinecraft, key: string, name: string) =>
  JSON.parse((await minecraft.file(key, name)) ?? 'null') as Array<Record<string, unknown>>
const lines = async (minecraft: FakeMinecraft, key: string) =>
  (await minecraft.recent(key as RuntimeHandle, 1000)).map((l) => l.text)
const unclocked = (text: string) => text.replace(/^\[\d\d:\d\d:\d\d\] /, '')

describe('a start', () => {
  test('writes the properties, keeps white-list once set, and logs as the image does', async () => {
    const { minecraft } = fresh()
    const m = await machine({
      DIFFICULTY: 'hard',
      MOTD: 'Hi',
      ONLINE_MODE: 'FALSE',
      ENFORCE_WHITELIST: 'TRUE',
    })
    await minecraft.start(m)
    expect(await minecraft.file(m.key, 'server.properties')).toBe(
      [
        'difficulty=hard',
        'gamemode=survival',
        'pvp=true',
        'view-distance=10',
        'simulation-distance=10',
        'max-players=20',
        'motd=Hi',
        'spawn-protection=16',
        'level-name=world',
        'online-mode=false',
        'enforce-whitelist=true',
        'white-list=false',
        '',
      ].join('\n'),
    )
    expect(await minecraft.run(target(m), 'whitelist on')).toBe('Whitelist is now turned on')
    await minecraft.stop(m)
    await minecraft.start(m)
    expect(await minecraft.file(m.key, 'server.properties')).toContain('white-list=true\n')
    const log = await lines(minecraft, m.key)
    expect(log[0]).toBe('[init] Starting the Minecraft server...')
    expect(log.map(unclocked)).toEqual([
      '[init] Starting the Minecraft server...',
      '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
      '[Server thread/INFO]: [Rcon: Whitelist is now turned on]',
      '[Server thread/INFO]: Stopping server',
      '[init] Starting the Minecraft server...',
      '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
    ])
    expect(log[1]).toMatch(/^\[\d\d:\d\d:\d\d\] \[Server thread\/INFO\]: Done/)
    expect(await minecraft.file(m.key, 'world/level.dat')).toBe('opened by unknown\nopened by unknown\n')
  })

  test('creates each missing list empty, and loads the lists and the name cache from their files', async () => {
    const { minecraft } = fresh()
    const m = await machine()
    const steve = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve' }
    await writeFile(join(m.dir, 'ops.json'), JSON.stringify([{ ...steve, level: 4 }]))
    await writeFile(join(m.dir, 'usercache.json'), JSON.stringify([steve]))
    await minecraft.start(m)
    for (const name of ['whitelist.json', 'banned-players.json', 'banned-ips.json'])
      expect(await minecraft.file(m.key, name)).toBe('[]')
    expect(await minecraft.file(m.key, 'ops.json')).toBe(JSON.stringify([{ ...steve, level: 4 }]))
    expect(minecraft.isOperator(m.key, steve.uuid)).toBe(true)
    // The cache names Steve, so no lookup: the cached UUID is the one listed.
    expect(await minecraft.run(target(m), 'whitelist add steve')).toBe('Added Steve to the whitelist')
    expect(await json(minecraft, m.key, 'whitelist.json')).toEqual([steve])
    // A change to a file while it runs is not seen: the server judges by what it loaded.
    await writeFile(join(m.dir, 'ops.json'), '[]')
    expect(minecraft.isOperator(m.key, steve.uuid)).toBe(true)
  })

  test('sets the game from the environment, and PvP from the world from 1.21.9', async () => {
    const { minecraft } = fresh()
    const old = await machine({ VERSION: '1.21.8', PVP: 'false', MODE: 'creative' })
    await minecraft.start(old)
    expect(minecraft.playing(old.key)).toEqual({
      difficulty: 'easy',
      defaultGameMode: 'creative',
      pvp: false,
      modes: {},
    })
    const now = await machine({ VERSION: '1.21.9', PVP: 'false' })
    await minecraft.start(now)
    expect(minecraft.playing(now.key).pvp).toBe(true)
    expect(await minecraft.run(target(now), 'gamerule pvp false')).toBe('Game rule pvp is now set to false')
    expect(await minecraft.file(now.key, 'world/gamerules')).toBe('pvp=false\n')
    await minecraft.stop(now)
    await minecraft.start(now)
    expect(minecraft.playing(now.key).pvp).toBe(false)
  })

  test('installs listed jars, skips one up to date, removes one no longer listed', async () => {
    const { minecraft } = fresh()
    const good = `${base}/jars/good.jar`
    const other = `${base}/jars/other%20one.jar`
    const m = await machine({ TYPE: 'FABRIC', MODS: `${good},${other}` })
    await minecraft.start(m)
    expect(await minecraft.jars(m.key)).toEqual(['good.jar', 'other one.jar'])
    expect(await minecraft.file(m.key, 'mods/.installed.json')).toBe('["good.jar","other one.jar"]')
    await minecraft.stop(m)
    m.spec = spec({ TYPE: 'FABRIC', MODS: good })
    await minecraft.start(m)
    expect(await minecraft.jars(m.key)).toEqual(['good.jar'])
    published = new Date('2099-01-01T00:00:00Z')
    await minecraft.stop(m)
    await minecraft.start(m)
    published = new Date('2026-01-01T00:00:00Z')
    expect(
      (await lines(minecraft, m.key)).map(unclocked).filter((l) => l.startsWith('[mc-image-helper]')),
    ).toEqual([
      `[mc-image-helper] INFO : Downloaded ${join(m.dir, 'mods/good.jar')} from ${good}`,
      `[mc-image-helper] INFO : Downloaded ${join(m.dir, 'mods/other one.jar')} from ${other}`,
      `[mc-image-helper] INFO : The file ${join(m.dir, 'mods/good.jar')} is already up to date`,
      `[mc-image-helper] INFO : Downloaded ${join(m.dir, 'mods/good.jar')} from ${good}`,
    ])
  })

  test('stops on a jar link that does not answer 200', async () => {
    const { minecraft } = fresh()
    const missing = `${base}/jars/missing.jar`
    const m = await machine({ MODS: missing })
    await expect(minecraft.start(m)).rejects.toThrow('Downloading missing.jar answered 404')
    expect((await lines(minecraft, m.key)).map(unclocked)).toEqual([
      '[init] Starting the Minecraft server...',
      `[mc-image-helper] ERROR : Failed to process source: ${missing} failed with 404`,
    ])
    await expect(minecraft.run(target(m), 'list')).rejects.toThrow('The server is not reachable')
    // The properties and the lists come before the jars; the world after them.
    expect(await minecraft.file(m.key, 'server.properties')).toContain('white-list=false')
    expect(await minecraft.file(m.key, 'ops.json')).toBe('[]')
    expect(await minecraft.file(m.key, 'world/level.dat')).toBeNull()
  })

  test('the loader reads what the pack installed, after the pack', async () => {
    const { minecraft } = fresh()
    served = pack(
      { name: 'P', versionId: '3', files: [] },
      { 'overrides/mods/cut.jar': strToU8('cut short') },
    )
    const m = await machine({ MODRINTH_MODPACK: `${base}/pack.mrpack` })
    await expect(minecraft.start(m)).rejects.toThrow('cut.jar is not a readable jar')
    expect(await minecraft.file(m.key, '.modrinth-modpack-manifest.json')).toBe('{"files":["mods/cut.jar"]}')
    expect(await minecraft.file(m.key, 'world/level.dat')).toBeNull()
  })

  test('a mod loader stops on a jar it cannot read; Paper skips the plugin', async () => {
    const { minecraft } = fresh()
    const mods = await machine({ MODS: `${base}/jars/bad.jar` })
    await expect(minecraft.start(mods)).rejects.toThrow('bad.jar is not a readable jar')
    expect((await lines(minecraft, mods.key)).map(unclocked).at(-1)).toBe(
      '[main/ERROR]: Failed to read mods/bad.jar: java.util.zip.ZipException: zip END header not found',
    )
    const paper = await machine({ TYPE: 'PAPER', PLUGINS: `${base}/jars/bad.jar` })
    await minecraft.start(paper)
    expect(await minecraft.jars(paper.key)).toEqual(['bad.jar'])
    expect((await lines(minecraft, paper.key)).map(unclocked).slice(-2)).toEqual([
      "[Server thread/ERROR]: Could not load 'plugins/bad.jar' in folder 'plugins'",
      '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
    ])
  })

  test('installs a pack: its files, its overrides, what it excludes, and removes what it no longer has', async () => {
    const { minecraft } = fresh()
    const file = (path: string, env?: { server?: string }) => ({
      path,
      downloads: [`${base}/files/${path}`],
      ...(env ? { env } : {}),
    })
    served = pack(
      {
        name: 'Pack',
        versionId: '1.0',
        files: [
          file('mods/keep.jar'),
          file('mods/client.jar', { server: 'unsupported' }),
          file('mods/forced.jar', { server: 'unsupported' }),
          file('mods/excluded.jar'),
        ],
      },
      {
        'overrides/config/a.txt': strToU8('a'),
        'overrides/skip.txt': strToU8('skip'),
        'server-overrides/config/a.txt': strToU8('server a'),
        'overrides/config/': new Uint8Array(),
      },
    )
    const env = {
      MODRINTH_MODPACK: `${base}/pack.mrpack`,
      MODRINTH_EXCLUDE_FILES: '/excluded/',
      MODRINTH_FORCE_INCLUDE_FILES: '/forced/',
      MODRINTH_OVERRIDES_EXCLUSIONS: 'skip.txt',
    }
    const m = await machine(env)
    await minecraft.start(m)
    expect(await minecraft.jars(m.key)).toEqual(['forced.jar', 'keep.jar'])
    expect(await minecraft.file(m.key, 'config/a.txt')).toBe('server a')
    expect(await minecraft.file(m.key, 'skip.txt')).toBeNull()
    expect(await minecraft.file(m.key, '.modrinth-modpack-manifest.json')).toBe(
      JSON.stringify({ files: ['mods/keep.jar', 'mods/forced.jar', 'config/a.txt', 'config/a.txt'] }),
    )
    expect(
      (await lines(minecraft, m.key)).map(unclocked).filter((l) => l.startsWith('[mc-image-helper]')),
    ).toEqual(['[mc-image-helper] INFO : Processing modpack files for Pack 1.0'])
    served = pack({ name: 'Pack', versionId: '1.1', files: [file('mods/keep.jar')] })
    await minecraft.stop(m)
    await minecraft.start(m)
    expect(await minecraft.jars(m.key)).toEqual(['keep.jar'])
    expect(await minecraft.file(m.key, 'config/a.txt')).toBeNull()
  })

  test('stops on a pack, or a pack file, that does not download', async () => {
    const { minecraft } = fresh()
    const missing = await machine({ MODRINTH_MODPACK: `${base}/gone.mrpack` })
    await expect(minecraft.start(missing)).rejects.toThrow('Downloading the pack answered 404')
    expect((await lines(minecraft, missing.key)).map(unclocked).at(-1)).toBe(
      `[mc-image-helper] ERROR : 'install-modrinth-modpack' command failed: ${base}/gone.mrpack answered 404`,
    )
    served = pack({ name: 'P', versionId: '2', files: [{ path: 'mods/x.jar', downloads: [`${base}/nope`] }] })
    const broken = await machine({ MODRINTH_MODPACK: `${base}/pack.mrpack` })
    await expect(minecraft.start(broken)).rejects.toThrow('Downloading mods/x.jar answered 404')
    expect((await lines(minecraft, broken.key)).map(unclocked).at(-1)).toBe(
      "[mc-image-helper] ERROR : 'install-modrinth-modpack' command failed: mods/x.jar answered 404",
    )
  })
})

describe('the console', () => {
  test('answers the access commands in vanilla’s words, and saves each list whole', async () => {
    const { minecraft, profiles } = fresh()
    profiles.unknown('Nobody')
    const m = await machine()
    await minecraft.start(m)
    const t = target(m)
    const steve = (await profiles.byName('Steve')) ?? { uuid: '', name: '' }
    const uuid = steve.uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
    const answers: string[] = []
    for (const command of [
      'whitelist add Steve',
      'whitelist add steve',
      'whitelist add Nobody',
      'whitelist remove Steve',
      'whitelist remove Steve',
      'whitelist list',
      'whitelist',
      'op Steve',
      'op Steve',
      'deop Steve',
      'deop Steve',
      'op Nobody',
      'ban Steve',
      'ban Steve',
      'pardon Steve',
      'pardon Steve',
      'ban Steve being rude',
      'pardon Nobody',
      'ban-ip 1.2.3.4',
      'ban-ip 1.2.3.4',
      'pardon-ip 1.2.3.4',
      'pardon-ip 1.2.3.4',
      'ban-ip 5.6.7.8 spam',
    ])
      answers.push(await minecraft.run(t, command))
    expect(answers).toEqual([
      'Added Steve to the whitelist',
      'Player is already whitelisted',
      'That player does not exist',
      'Removed Steve from the whitelist',
      'Player is not whitelisted',
      'That player does not exist',
      'That player does not exist',
      'Made Steve a server operator',
      'Nothing changed. The player already is an operator',
      'Made Steve no longer a server operator',
      'Nothing changed. The player is not an operator',
      'That player does not exist',
      'Banned Steve: Banned by an operator.',
      'Nothing changed. The player is already banned',
      'Unbanned Steve',
      "Nothing changed. The player isn't banned",
      'Banned Steve: being rude',
      "Nothing changed. The player isn't banned",
      'Banned IP 1.2.3.4: Banned by an operator.',
      'Nothing changed. That IP is already banned',
      'Unbanned IP 1.2.3.4',
      "Nothing changed. That IP isn't banned",
      'Banned IP 5.6.7.8: spam',
    ])
    expect(await minecraft.file(m.key, 'whitelist.json')).toBe('[]')
    expect(await minecraft.file(m.key, 'ops.json')).toBe('[]')
    const created = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000$/
    const bans = await json(minecraft, m.key, 'banned-players.json')
    expect(bans).toEqual([
      {
        uuid,
        name: 'Steve',
        created: expect.stringMatching(created),
        source: 'Rcon',
        expires: 'forever',
        reason: 'being rude',
      },
    ])
    expect(await minecraft.file(m.key, 'banned-players.json')).toBe(JSON.stringify(bans, null, 2))
    expect(await json(minecraft, m.key, 'banned-ips.json')).toEqual([
      {
        ip: '5.6.7.8',
        created: expect.stringMatching(created),
        source: 'Rcon',
        expires: 'forever',
        reason: 'spam',
      },
    ])
    expect(await json(minecraft, m.key, 'usercache.json')).toEqual([
      { uuid, name: 'Steve', expiresOn: '2099-01-01 00:00:00 +0000' },
    ])
    expect(await minecraft.file(m.key, 'usercache.json')).toBe(
      JSON.stringify([{ uuid, name: 'Steve', expiresOn: '2099-01-01 00:00:00 +0000' }]),
    )
    expect(await minecraft.inGame(m.key, 'op Steve')).toBe('Made Steve a server operator')
    expect(await minecraft.file(m.key, 'ops.json')).toBe(
      JSON.stringify([{ uuid, name: 'Steve', level: 4, bypassesPlayerLimit: false }], null, 2),
    )
    expect(minecraft.isOperator(m.key, uuid)).toBe(true)
    expect(await minecraft.inGame(m.key, 'pardon Steve')).toBe('Unbanned Steve')
    expect(await minecraft.inGame(m.key, 'ban Steve')).toBe('Banned Steve: Banned by an operator.')
    expect((await json(minecraft, m.key, 'banned-players.json'))[0]?.source).toBe('Server')
    expect((await lines(minecraft, m.key)).map(unclocked).slice(-2)).toEqual([
      '[Server thread/INFO]: [Server: Unbanned Steve]',
      '[Server thread/INFO]: [Server: Banned Steve: Banned by an operator.]',
    ])
  })

  test('names a player as vanilla does where accounts are not checked', async () => {
    const { minecraft, profiles } = fresh()
    profiles.unknown('Nobody')
    const m = await machine({ ONLINE_MODE: 'FALSE' })
    await minecraft.start(m)
    const t = target(m)
    expect(await minecraft.run(t, 'whitelist add Nobody')).toBe('Added nobody to the whitelist')
    expect(await minecraft.run(t, 'whitelist add Way_Too_Long_A_Name')).toBe('That player does not exist')
    const listed = await json(minecraft, m.key, 'whitelist.json')
    expect(listed).toEqual([{ uuid: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'nobody' }])
    // The offline UUID of the exact name, version 3.
    expect(await minecraft.login(m.key, 'nobody')).toBe('joined')
    expect(minecraft.playing(m.key).modes).toEqual({ nobody: 'survival' })
    expect(String(listed[0]?.uuid).charAt(14)).toBe('3')
  })

  test('the whitelist: on and off in the properties, reload from the file, kicks where enforced', async () => {
    const { minecraft, profiles } = fresh()
    const m = await machine({ ENFORCE_WHITELIST: 'TRUE' })
    await minecraft.start(m)
    const t = target(m)
    const alex = (await profiles.byName('Alex')) ?? { uuid: '', name: '' }
    expect(await minecraft.login(m.key, 'Alex')).toBe('joined')
    expect(await minecraft.login(m.key, 'Steve')).toBe('joined')
    expect(await minecraft.run(t, 'whitelist add Alex')).toBe('Added Alex to the whitelist')
    expect(await minecraft.run(t, 'whitelist on')).toBe('Whitelist is now turned on')
    expect(await minecraft.file(m.key, 'server.properties')).toContain('\nwhite-list=true\n')
    expect(Object.keys(minecraft.playing(m.key).modes)).toEqual(['Alex'])
    expect(await minecraft.login(m.key, 'Steve')).toBe('not whitelisted')
    await writeFile(join(m.dir, 'whitelist.json'), '[]')
    expect(await minecraft.login(m.key, 'Alex')).toBe('joined')
    expect(await minecraft.run(t, 'whitelist reload')).toBe('Reloaded the whitelist')
    expect(Object.keys(minecraft.playing(m.key).modes)).toEqual([])
    expect(await minecraft.login(m.key, 'Alex')).toBe('not whitelisted')
    expect(await minecraft.run(t, 'whitelist off')).toBe('Whitelist is now turned off')
    expect(await minecraft.file(m.key, 'server.properties')).toContain('\nwhite-list=false\n')
    expect(await minecraft.login(m.key, 'Alex')).toBe('joined')
    expect(await minecraft.run(t, 'ban Alex')).toBe('Banned Alex: Banned by an operator.')
    expect(minecraft.playing(m.key).modes).toEqual({})
    expect(await minecraft.login(m.key, 'Alex')).toBe('banned')
    profiles.unknown('Ghost')
    expect(await minecraft.login(m.key, 'Ghost')).toBe('no account')
    expect(alex.name).toBe('Alex')
  })

  test('answers the game commands in vanilla’s words', async () => {
    const { minecraft } = fresh()
    const m = await machine({ VERSION: '1.21.8', MAX_PLAYERS: '8' })
    await minecraft.start(m)
    const t = target(m)
    const ask = (command: string) => minecraft.run(t, command)
    expect(await ask('list')).toBe('There are 0 of a max of 8 players online: ')
    expect(await ask('gamemode creative @a')).toBe('No player was found')
    minecraft.join(m.key, { uuid: 'u-1', name: 'Steve' })
    minecraft.join(m.key, { uuid: 'u-2', name: 'Alex' })
    expect(await ask('list')).toBe('There are 2 of a max of 8 players online: Steve, Alex')
    expect(await ask('list uuids')).toBe('There are 2 of a max of 8 players online: Steve (u-1), Alex (u-2)')
    expect(await ask('/difficulty hard')).toBe('The difficulty has been set to Hard')
    expect(await ask('difficulty hard')).toBe('The difficulty did not change; it is already set to hard')
    expect(await ask('difficulty silly')).toBe('Incorrect argument for command')
    expect(await ask('defaultgamemode creative')).toBe('The default game mode is now Creative Mode')
    expect(await ask('defaultgamemode silly')).toBe('Incorrect argument for command')
    expect(await ask('gamemode adventure @a')).toBe(
      "Set Steve's game mode to Adventure ModeSet Alex's game mode to Adventure Mode",
    )
    expect(await ask('gamerule pvp')).toBe('Incorrect argument for commandgamerule pvp<--[HERE]')
    expect(await ask('save-all flush')).toBe('Saving the game (this may take a moment!)Saved the game')
    expect(await ask('save-off')).toBe('Automatic saving is now disabled')
    expect(await ask('save-on')).toBe('Automatic saving is now enabled')
    expect(await ask('SAY  hello   there')).toBe('')
    expect(await ask('stop')).toBe('Unknown or incomplete command, see below for error')
    expect(minecraft.said(m.key)).toEqual(['hello there'])
    minecraft.join(m.key, { uuid: 'u-3', name: 'Zed' })
    expect(minecraft.playing(m.key)).toEqual({
      difficulty: 'hard',
      defaultGameMode: 'creative',
      pvp: true,
      modes: { Steve: 'adventure', Alex: 'adventure', Zed: 'creative' },
    })
    minecraft.leave(m.key, 'u-3')
    expect((await ask('list')).endsWith('Steve, Alex')).toBe(true)
    const log = (await lines(minecraft, m.key)).map(unclocked)
    const saved = log.indexOf('[Server thread/INFO]: [Rcon: Automatic saving is now enabled]')
    expect(log.slice(saved, saved + 4)).toEqual([
      '[Server thread/INFO]: [Rcon: Automatic saving is now enabled]',
      '[Server thread/INFO]: [Server] hello there',
      '[Server thread/INFO]: [Rcon: ]',
      '[Server thread/INFO]: [Rcon: Unknown or incomplete command, see below for error]',
    ])

    const now = await machine({ VERSION: '26.3' })
    await minecraft.start(now)
    const rule = (command: string) => minecraft.run(target(now), command)
    expect(await rule('gamerule pvp')).toBe('Game rule pvp is currently set to true')
    expect(await rule('gamerule pvp maybe')).toBe('Incorrect argument for command')
    expect(await rule('gamerule keepInventory true')).toBe(
      'Incorrect argument for commandgamerule keepInventory<--[HERE]',
    )
  })

  test('runs commands only on a running server that takes the password, and runAll collects failures', async () => {
    const { minecraft } = fresh()
    const m = await machine()
    await expect(minecraft.run(target(m), 'list')).rejects.toThrow('The server is not reachable')
    await minecraft.start(m)
    await expect(minecraft.run(target(m, 'wrong'), 'list')).rejects.toThrow('RCON refused the password')
    minecraft.refuseCommands(/^save-/)
    expect(await minecraft.runAll(target(m), ['save-off', 'list', ' save-on '])).toEqual([
      { ok: false, error: 'The server did not run save-off' },
      { ok: true, output: 'There are 0 of a max of 20 players online: ' },
      { ok: false, error: 'The server did not run save-on' },
    ])
    expect((await lines(minecraft, m.key)).map(unclocked).at(-1)).toBe(
      '[Server thread/INFO]: [Rcon: There are 0 of a max of 20 players online: ]',
    )
    minecraft.refuseCommands(null)
    expect(await minecraft.run(target(m), 'save-on')).toBe('Automatic saving is now enabled')
    await minecraft.stop(m)
    await expect(minecraft.run(target(m), 'list')).rejects.toThrow('The server is not reachable')
    expect(() => minecraft.inGame(m.key, 'list')).toThrow('The server is not running')
    await expect(minecraft.login(m.key, 'Steve')).rejects.toThrow('The server is not running')
    expect(() => minecraft.join('nope', { uuid: 'u', name: 'n' })).toThrow('No fake server nope')
  })
})

describe('gamemode by name', () => {
  test('sets one player, and says nothing for one already in that mode', async () => {
    const { minecraft } = fresh()
    const m = await machine({ VERSION: '1.21.8', MAX_PLAYERS: '8' })
    await minecraft.start(m)
    const ask = (command: string) => minecraft.run(target(m), command)
    minecraft.join(m.key, { uuid: 'u-1', name: 'Steve' })
    expect(await ask('gamemode creative Steve')).toBe("Set Steve's game mode to Creative Mode")
    expect(await ask('gamemode creative Steve')).toBe('')
    expect(await ask('gamemode adventure Steve')).toBe("Set Steve's game mode to Adventure Mode")
    expect(await ask('gamemode creative Nobody')).toBe('No player was found')
    expect(await ask('gamemode silly Steve')).toBe('Incorrect argument for command')
  })
})

describe('the switches tests flip', () => {
  test('breakOn: the world is opened, then the server crashes with the reason as a trace', async () => {
    const { minecraft } = fresh()
    minecraft.breakOn((env) =>
      env.VERSION === '26.3' ? 'java.lang.IllegalStateException: bad\n\tat a.b(C.java:1)' : null,
    )
    const m = await machine({ VERSION: '26.3' })
    await expect(minecraft.start(m)).rejects.toThrow(
      'java.lang.IllegalStateException: bad\n\tat a.b(C.java:1)',
    )
    expect(await minecraft.file(m.key, 'world/level.dat')).toBe('opened by 26.3\n')
    expect((await lines(minecraft, m.key)).map(unclocked)).toEqual([
      '[init] Starting the Minecraft server...',
      '[Server thread/ERROR]: Encountered an unexpected exception: java.lang.IllegalStateException: bad',
      '\tat a.b(C.java:1)',
    ])
    await expect(minecraft.ping({ host: m.host, port: 25565 }, new AbortController().signal)).rejects.toThrow(
      'Connection refused',
    )
    await expect(minecraft.run(target(m), 'list')).rejects.toThrow('The server is not reachable')
  })

  test('stallOn: the server runs, but never says Done and refuses pings', async () => {
    const { minecraft } = fresh()
    minecraft.stallOn((env) => env.VERSION === 'slow')
    const m = await machine({ VERSION: 'slow' })
    await minecraft.start(m)
    expect((await lines(minecraft, m.key)).map(unclocked)).toEqual([
      '[init] Starting the Minecraft server...',
    ])
    await expect(minecraft.ping({ host: m.host, port: 25565 }, new AbortController().signal)).rejects.toThrow(
      'Connection refused',
    )
    expect(await minecraft.run(target(m), 'list')).toBe('There are 0 of a max of 20 players online: ')
  })

  test('hang: a running server stops answering pings; ping otherwise reports its players', async () => {
    const { minecraft } = fresh()
    const m = await machine({ VERSION: '26.3', MAX_PLAYERS: '5' })
    await minecraft.start(m)
    minecraft.join(m.key, { uuid: 'u-1', name: 'Steve' })
    const signal = new AbortController().signal
    expect(await minecraft.ping({ host: m.host, port: 25565 }, signal)).toEqual({
      online: 1,
      max: 5,
      version: '26.3',
    })
    minecraft.hang(m.key)
    await expect(minecraft.ping({ host: m.host, port: 25565 }, signal)).rejects.toThrow('Connection refused')
    await minecraft.stop(m)
    expect(minecraft.playing(m.key).modes).toEqual({})
  })
})

describe('the log', () => {
  test('recent keeps the last lines; tail follows new ones until aborted', async () => {
    const { minecraft } = fresh()
    const m = await machine()
    expect(await minecraft.recent(m.key as RuntimeHandle, 5)).toEqual([])
    await minecraft.start(m)
    expect((await minecraft.recent(m.key as RuntimeHandle, 1)).map((l) => unclocked(l.text))).toEqual([
      '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
    ])
    for (let i = 0; i < 2100; i++) await minecraft.run(target(m), 'save-on')
    const all = await minecraft.recent(m.key as RuntimeHandle, 5000)
    expect(all).toHaveLength(2000)
    const abort = new AbortController()
    const followed: string[] = []
    const following = (async () => {
      for await (const line of minecraft.tail(m.key as RuntimeHandle, abort.signal)) {
        followed.push(unclocked(line.text))
        if (followed.length === 2) abort.abort()
      }
    })()
    await Bun.sleep(5)
    await minecraft.run(target(m), 'save-off')
    await minecraft.stop(m)
    await following
    expect(followed).toEqual([
      '[Server thread/INFO]: [Rcon: Automatic saving is now disabled]',
      '[Server thread/INFO]: Stopping server',
    ])
    const none: string[] = []
    for await (const line of minecraft.tail('nope' as RuntimeHandle, abort.signal)) none.push(line.text)
    expect(none).toEqual([])
  })

  test('file and path name the server’s volume', async () => {
    const { minecraft } = fresh()
    const m = await machine()
    await minecraft.start(m)
    expect(minecraft.path(m.key, 'ops.json')).toBe(join(m.dir, 'ops.json'))
    expect(await readFile(minecraft.path(m.key, 'ops.json'), 'utf8')).toBe('[]')
    expect(await minecraft.file(m.key, 'nothing.txt')).toBeNull()
    expect(await minecraft.jars(m.key)).toEqual([])
  })
})
