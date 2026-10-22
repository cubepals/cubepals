// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stand-in for the itzg image running a vanilla server, for the fake runtime. It does what
 * Blockly depends on, the way the real ones do it (docs/architecture.md §15.1, §19a):
 * - the image writes `server.properties` from the environment, keeping `white-list` once set,
 *   and installs the jars listed in `MODS`/`PLUGINS` the way mc-image-helper does;
 * - a mod loader stops on a jar it can't read, where Paper only skips the plugin;
 * - the server keeps whitelist, operators and bans in memory, read from its JSON files as it
 *   starts (the whitelist again on `whitelist reload`); console commands change memory and save
 *   it over the file, and it answers with vanilla's wording;
 * - it names players the way vanilla 26.x does, measured on real servers on 2026-09-23: a login
 *   is the player's account where accounts are checked, and otherwise a UUID derived from the
 *   exact name; a name in a command is looked up in its name cache (`usercache.json`, which logins
 *   and lookups fill), then asked of Mojang — even where accounts aren't checked — and, on such a
 *   server, finally derived from the name in lower case; a Bedrock player is in the cache only
 *   once they have joined, as Floodgate names them, and `kick` refuses a UUID;
 * - RCON wants the secret the spec carries; a status ping answers once the world is loaded;
 * - each player on has a place and may have a last death, which `data get entity`, `tp` and
 *   `spreadplayers` (under `execute in`) read and move, answering in vanilla's words (1.20.1, 26.3);
 *   `spreadplayers` stands them on a column's highest block, never on lava or over the void but
 *   on magma or a cactus all the same, and `execute as … at @s unless block ~ ~-1 ~ …` tests what
 *   they stand on ("Test passed", "Test failed");
 * It knows these as a Minecraft server would, not through Blockly's translation code.
 *
 * The server is its process, its players and its running game, which every command and every
 * player reads, so they stay here with the console's dispatch, the game commands and the switches
 * tests flip. What has state, a file or failures of its own is in its parts.
 *
 * Parts (`fake-minecraft/`):
 * - `access-commands.ts`: what the whitelist, op, ban and pardon commands answer and change.
 * - `image.ts`: the jars and the pack the image installs on the volume before the game starts.
 * - `lists.ts`: the access lists, held in memory and saved whole over their files.
 * - `log.ts`: one server's console output, kept and followed.
 * - `names.ts`: who a name is, as vanilla 26.x decides it.
 * - `plugins.ts`: the moderation plugins' commands, LibertyBans' and LuckPerms'.
 * - `properties.ts`: `server.properties`, written as the server starts and its whitelist line.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ConsoleTarget,
  PlayerProfiles,
  ReadinessProbe,
  ServerConsole,
  ServerStatusPing,
} from '../../app/ports/minecraft.ts'
import { ConsoleUnavailable } from '../../app/ports/minecraft.ts'
import type { LogLine, LogSource } from '../../app/ports/platform.ts'
import type { Endpoint, RuntimeHandle } from '../../app/ports/runtime.ts'
import {
  type AccessServer,
  ban,
  banIp,
  kick,
  op,
  pardon,
  pardonIp,
  whitelist,
} from './fake-minecraft/access-commands.ts'
import {
  installJars,
  installPack,
  jarDir,
  placeBedrock,
  placeCarried,
  placeStopCheaters,
} from './fake-minecraft/image.ts'
import { AccessLists } from './fake-minecraft/lists.ts'
import { ServerLog } from './fake-minecraft/log.ts'
import { checksAccounts, dashed, NameCache, offlineUuid } from './fake-minecraft/names.ts'
import { plugin } from './fake-minecraft/plugins.ts'
import { whitelistOn, writeProperties } from './fake-minecraft/properties.ts'
import type { FakeMachine, FakeWorkload } from './fake-runtime.ts'

interface Server {
  key: string
  host: string
  dir: string
  env: Readonly<Record<string, string>>
  password: string
  running: boolean
  ready: boolean
  online: Map<string, string>
  /** Why each player was last turned out, by UUID: a kick's reason, or the words a ban kicks with. */
  kicks: Map<string, string>
  /** The access lists as the running server holds them. */
  lists: AccessLists
  /** Which name is which player: `usercache.json`. */
  names: NameCache
  /** What `say` and `tellraw` broadcast to the players, in order. */
  said: string[]
  /** Every console command the server was given, in order. */
  heard: string[]
  /** How the running game plays: set from the properties as it starts, and by commands after. */
  game: { difficulty: string; defaultGameMode: string; pvp: boolean }
  /** Each player's game mode, by UUID: the default one as they join, or what a command set. */
  modes: Map<string, string>
  /** Where each player on is, and where each last died, by UUID. */
  places: Map<string, FakePlace>
  deaths: Map<string, FakePlace>
  /** What tops each column (`<dimension> <x> <z>`) tests set; any other stands a player at 64. */
  ground: Map<string, FakeGround>
  /** How many times `spreadplayers` was asked around each point (`<dimension> <x> <z>`). */
  spreads: Map<string, number>
  log: ServerLog
}

export class FakeMinecraft implements FakeWorkload, ServerConsole, ReadinessProbe, LogSource {
  readonly #profiles: PlayerProfiles
  readonly #servers = new Map<string, Server>()
  readonly #keyOf: (handle: RuntimeHandle) => string
  #breaks: (env: Readonly<Record<string, string>>) => string | null = () => null
  #refused: RegExp | null = null
  #stalls: (env: Readonly<Record<string, string>>) => boolean = () => false
  /** How long a world takes to open after the server starts; at once by default. */
  #bootMs = 0

  /** `keyOf` reads the fake runtime's handles; the profiles are the ones the control plane uses. */
  constructor(profiles: PlayerProfiles, keyOf: (handle: RuntimeHandle) => string) {
    this.#profiles = profiles
    this.#keyOf = keyOf
  }

  // ─── The image and the server process ─────────────────────────────────────────────────────

  async start(machine: FakeMachine): Promise<void> {
    const server = this.#server(machine)
    server.env = machine.spec.env
    server.dir = machine.dir
    server.password = machine.spec.secrets.RCON_PASSWORD ?? ''
    server.ready = false
    server.log.say('[init] Starting the Minecraft server...')
    await writeProperties(server.dir, server.env)
    server.modes.clear()
    await server.lists.load(server.dir)
    await server.names.load(server.dir)
    const say = (text: string) => server.log.say(text)
    await placeCarried(server.dir, server.env, say)
    await placeStopCheaters(server.dir, server.env)
    await placeBedrock(server.dir, { ...server.env, ...machine.spec.secrets })
    await installJars(server.dir, server.env, say)
    await installPack(server.dir, server.env, say)
    await this.#loadJars(server)
    const level = join(server.dir, server.env.LEVEL ?? 'world')
    await mkdir(level, { recursive: true })
    // PvP is a property until 1.21.9 and a game rule the world keeps after, which ignores the property.
    const rules = join(level, 'gamerules')
    const kept = (await readFile(rules, 'utf8').catch(() => 'pvp=true')).includes('pvp=true')
    server.game = {
      difficulty: server.env.DIFFICULTY ?? 'easy',
      defaultGameMode: server.env.MODE ?? 'survival',
      pvp: pvpIsGameRule(server.env) ? kept : server.env.PVP !== 'false',
    }
    // Opening a world stamps it with the version, as a real upgrade migrates it.
    await writeFile(join(level, 'level.dat'), `opened by ${server.env.VERSION ?? 'unknown'}\n`, { flag: 'a' })
    const broken = this.#breaks(server.env)
    if (broken !== null) {
      // A reason over several lines prints them as a loader prints its trace.
      const [first, ...rest] = broken.split('\n')
      server.log.say(`[Server thread/ERROR]: Encountered an unexpected exception: ${first}`)
      for (const line of rest) server.log.say(line, { bare: true })
      throw new Error(broken)
    }
    server.running = true
    server.ready = false
    if (this.#stalls(server.env)) return
    const done = () => {
      server.ready = true
      server.log.say('[Server thread/INFO]: Done (0.100s)! For help, type "help"')
    }
    if (this.#bootMs > 0) setTimeout(done, this.#bootMs)
    else done()
  }

  async stop(machine: FakeMachine): Promise<void> {
    const server = this.#servers.get(machine.key)
    if (server === undefined) return
    server.log.say('[Server thread/INFO]: Stopping server')
    server.running = false
    server.ready = false
    server.online.clear()
  }

  /** Frozen as Fly suspends a machine: it answers nothing, prints nothing, and forgets nothing. */
  async suspend(machine: FakeMachine): Promise<void> {
    const server = this.#servers.get(machine.key)
    if (server !== undefined) server.running = false
  }

  /** Running on from where it froze, players, lists and game as they were, with nothing printed. */
  async resume(machine: FakeMachine): Promise<void> {
    const server = this.#servers.get(machine.key)
    if (server !== undefined) server.running = true
  }

  // ─── RCON ─────────────────────────────────────────────────────────────────────────────────

  async run(target: ConsoleTarget, command: string): Promise<string> {
    const server = this.#reachable(target)
    return this.#execute(server, command, 'Rcon')
  }

  async runAll(
    target: ConsoleTarget,
    commands: readonly string[],
  ): Promise<Array<{ ok: true; output: string } | { ok: false; error: string }>> {
    const server = this.#reachable(target)
    const results: Array<{ ok: true; output: string } | { ok: false; error: string }> = []
    for (const command of commands) {
      try {
        results.push({ ok: true, output: await this.#execute(server, command, 'Rcon') })
      } catch (error) {
        results.push({ ok: false, error: (error as Error).message })
      }
    }
    return results
  }

  // ─── Status ping ──────────────────────────────────────────────────────────────────────────

  async ping(endpoint: Endpoint, _signal: AbortSignal): Promise<ServerStatusPing> {
    const server = this.#byHost(endpoint.host)
    if (server === null || !server.running || !server.ready) throw new Error('Connection refused')
    return {
      online: server.online.size,
      max: Number(server.env.MAX_PLAYERS ?? 20),
      version: server.env.VERSION ?? '',
    }
  }

  // ─── Logs ─────────────────────────────────────────────────────────────────────────────────

  async recent(handle: RuntimeHandle, limit: number): Promise<LogLine[]> {
    return this.#servers.get(this.#keyOf(handle))?.log.recent(limit) ?? []
  }

  async *tail(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine> {
    const server = this.#servers.get(this.#keyOf(handle))
    if (server === undefined) return
    yield* server.log.tail(signal)
  }

  // ─── What tests reach for ─────────────────────────────────────────────────────────────────

  /** A player joins (the edge and `list` see them). */
  join(key: string, player: { uuid: string; name: string }): void {
    const server = this.#require(key)
    server.online.set(player.uuid, player.name)
    server.modes.set(player.uuid, server.game.defaultGameMode)
  }

  /**
   * Somebody clicks Join with this name, and the server does what a real one does: names them
   * its way, then turns them away if it holds a ban for them or has its whitelist on without
   * them — judged by what it loaded, not by what its files say now.
   */
  async login(key: string, name: string): Promise<'joined' | 'no account' | 'banned' | 'not whitelisted'> {
    const server = this.#require(key)
    if (!server.running) throw new Error('The server is not running')
    let player: { uuid: string; name: string }
    if (checksAccounts(server.env)) {
      const account = await this.#profiles.byName(name)
      if (account === null) return 'no account'
      player = { uuid: dashed(account.uuid), name: account.name }
    } else {
      player = { uuid: offlineUuid(name), name }
    }
    return this.#admit(server, player)
  }

  /**
   * A Bedrock player joins through the edge: Floodgate hands the server the UUID and name it made
   * for them, which no account lookup is asked about. The server then judges them as any other.
   */
  async bedrockLogin(
    key: string,
    player: { uuid: string; name: string },
  ): Promise<'joined' | 'banned' | 'not whitelisted'> {
    const server = this.#require(key)
    if (!server.running) throw new Error('The server is not running')
    return this.#admit(server, player)
  }

  /** Why the server last turned this player out, if it ever did. */
  kickedWith(key: string, uuid: string): string | undefined {
    return this.#require(key).kicks.get(uuid)
  }

  async #admit(
    server: Server,
    player: { uuid: string; name: string },
  ): Promise<'joined' | 'banned' | 'not whitelisted'> {
    if (server.lists.held('banned-players.json').some((e) => e.uuid === player.uuid)) return 'banned'
    const listed = server.lists.held('whitelist.json').some((e) => e.uuid === player.uuid)
    if ((await whitelistOn(server.dir)) && !listed) return 'not whitelisted'
    server.online.set(player.uuid, player.name)
    server.modes.set(player.uuid, server.game.defaultGameMode)
    await server.names.remember(player)
    return 'joined'
  }

  /** How the running game plays now, and the game mode of each player on it, by name. */
  playing(key: string): {
    difficulty: string
    defaultGameMode: string
    pvp: boolean
    modes: Record<string, string>
  } {
    const server = this.#require(key)
    const modes = [...server.online].map(([uuid, name]) => [name, server.modes.get(uuid) ?? ''])
    return { ...server.game, modes: Object.fromEntries(modes) }
  }

  /** Whether the running server treats this player as an operator: what it loaded, not the file. */
  isOperator(key: string, uuid: string): boolean {
    return this.#require(key)
      .lists.held('ops.json')
      .some((e) => e.uuid === uuid)
  }

  /** A player on dies here, and respawns at the world's spawn, as the game does. */
  die(key: string, uuid: string, at: FakePlace): void {
    const server = this.#require(key)
    server.deaths.set(uuid, at)
    server.places.set(uuid, { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 })
  }

  /** What tops one column of the world: lava, nothing at all, or a block a player stands on at `y`. */
  ground(key: string, at: { dimension: string; x: number; z: number }, top: FakeGround): void {
    this.#require(key).ground.set(`${at.dimension} ${at.x} ${at.z}`, top)
  }

  /** Where a player on is now. */
  placeOf(key: string, uuid: string): FakePlace | undefined {
    return this.#require(key).places.get(uuid)
  }

  leave(key: string, uuid: string): void {
    this.#require(key).online.delete(uuid)
  }

  /** An operator types a command in game: it changes the files, as RCON would, from another source. */
  inGame(key: string, command: string): Promise<string> {
    const server = this.#require(key)
    if (!server.running) throw new Error('The server is not running')
    return this.#execute(server, command, 'Server')
  }

  /** The files as the server keeps them. */
  async file(key: string, name: string): Promise<string | null> {
    return readFile(join(this.#require(key).dir, name), 'utf8').catch(() => null)
  }

  /** Where a file of the server's volume is on this machine, for a test to damage it. */
  path(key: string, name: string): string {
    return join(this.#require(key).dir, name)
  }

  /** The jars installed in the mods or plugins directory. */
  async jars(key: string): Promise<string[]> {
    const server = this.#require(key)
    return (await readdir(join(server.dir, jarDir(server.env))).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.jar'))
      .sort()
  }

  /** Servers started with a matching environment open their world, then crash, as a bad upgrade does. */
  breakOn(reason: (env: Readonly<Record<string, string>>) => string | null): void {
    this.#breaks = reason
  }

  /** Every world takes this long to open after its server starts, as a real boot does; 0, at once. */
  bootTakes(ms: number): void {
    this.#bootMs = ms
  }

  /** Servers started with a matching environment run, but their world never finishes loading. */
  stallOn(matches: (env: Readonly<Record<string, string>>) => boolean): void {
    this.#stalls = matches
  }

  /** What the server broadcast to its players with `say` or `tellraw`, oldest first. */
  said(key: string): readonly string[] {
    return [...this.#require(key).said]
  }

  /** Every console command the server was given, oldest first. */
  heard(key: string): readonly string[] {
    return [...this.#require(key).heard]
  }

  /** Commands matching `pattern` fail, as on a server that can't carry them out, until null. */
  refuseCommands(pattern: RegExp | null): void {
    this.#refused = pattern
  }

  /** The world never finishes loading: the process runs, pings are refused. */
  hang(key: string): void {
    this.#require(key).ready = false
  }

  // ─── Inside ───────────────────────────────────────────────────────────────────────────────

  #server(machine: FakeMachine): Server {
    let server = this.#servers.get(machine.key)
    if (server === undefined) {
      server = {
        key: machine.key,
        host: machine.host,
        dir: machine.dir,
        env: machine.spec.env,
        password: '',
        running: false,
        ready: false,
        online: new Map(),
        kicks: new Map(),
        lists: new AccessLists(),
        names: new NameCache(this.#profiles),
        said: [],
        heard: [],
        game: { difficulty: 'easy', defaultGameMode: 'survival', pvp: true },
        modes: new Map(),
        places: new Map(),
        deaths: new Map(),
        ground: new Map(),
        spreads: new Map(),
        log: new ServerLog(),
      }
      this.#servers.set(machine.key, server)
    }
    return server
  }

  #require(key: string): Server {
    const server = this.#servers.get(key)
    if (server === undefined) throw new Error(`No fake server ${key}`)
    return server
  }

  #byHost(host: string): Server | null {
    for (const server of this.#servers.values()) if (server.host === host) return server
    return null
  }

  #reachable(target: ConsoleTarget): Server {
    const server = this.#byHost(target.endpoint.host)
    if (server === null || !server.running) throw new ConsoleUnavailable('The server is not reachable')
    if (!target.passwords.includes(server.password)) throw new ConsoleUnavailable('RCON refused the password')
    return server
  }

  /**
   * What the server does with its jars: a mod loader stops on one it can't read (a zip without
   * its end record, as a download cut short leaves it); Paper logs the plugin and goes on.
   */
  async #loadJars(server: Server): Promise<void> {
    const dir = join(server.dir, jarDir(server.env))
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jar'))
    for (const name of names) {
      if (isReadableJar(await readFile(join(dir, name)))) continue
      if (jarDir(server.env) === 'plugins') {
        server.log.say(`[Server thread/ERROR]: Could not load 'plugins/${name}' in folder 'plugins'`)
        continue
      }
      server.log.say(
        `[main/ERROR]: Failed to read mods/${name}: java.util.zip.ZipException: zip END header not found`,
      )
      throw new Error(`${name} is not a readable jar`)
    }
  }

  async #execute(server: Server, input: string, source: 'Rcon' | 'Server'): Promise<string> {
    if (this.#refused?.test(input.trim())) throw new Error(`The server did not run ${input.trim()}`)
    server.heard.push(input.trim())
    const [named = '', ...rest] = input.trim().replace(/^\//, '').split(/\s+/)
    // Paper knows the game's own commands by their full name too; vanilla doesn't.
    const verb =
      server.env.TYPE === 'PAPER' ? named.toLowerCase().replace(/^minecraft:/, '') : named.toLowerCase()
    const answer = await this.#answer(server, verb, rest, source)
    server.log.say(`[Server thread/INFO]: [${source}: ${answer}]`)
    return answer
  }

  async #answer(server: Server, verb: string, args: string[], source: string): Promise<string> {
    switch (verb) {
      case 'whitelist':
        return whitelist(this.#access(server), args)
      case 'op':
      case 'deop':
        return op(this.#access(server), verb, args[0] ?? '')
      case 'ban':
        return ban(this.#access(server), args[0] ?? '', args.slice(1).join(' '), source)
      case 'pardon':
        return pardon(this.#access(server), args[0] ?? '')
      case 'kick':
        return kick(this.#access(server), args)
      case 'ban-ip':
        return banIp(server.lists, args[0] ?? '', args.slice(1).join(' '), source)
      case 'pardon-ip':
        return pardonIp(server.lists, args[0] ?? '')
      case 'list': {
        const max = server.env.MAX_PLAYERS ?? '20'
        const names = [...server.online].map(([uuid, name]) =>
          args[0] === 'uuids' ? `${name} (${uuid})` : name,
        )
        return `There are ${server.online.size} of a max of ${max} players online: ${names.join(', ')}`
      }
      case 'difficulty':
        return this.#difficulty(server, args[0] ?? '')
      case 'defaultgamemode':
        return this.#defaultGameMode(server, args[0] ?? '')
      case 'gamemode':
        return this.#gameMode(server, args[0] ?? '', args[1] ?? '')
      case 'gamerule':
        return this.#gameRule(server, args[0] ?? '', args[1])
      case 'data':
        return this.#data(server, args)
      case 'execute':
        return args[0] === 'as' ? this.#testFooting(server, args) : this.#executeIn(server, args)
      case 'save-all':
        return 'Saving the game (this may take a moment!)Saved the game'
      case 'save-off':
        return 'Automatic saving is now disabled'
      case 'save-on':
        return 'Automatic saving is now enabled'
      case 'say': {
        const message = args.join(' ')
        server.said.push(message)
        server.log.say(`[Server thread/INFO]: [Server] ${message}`)
        return ''
      }
      case 'tellraw': {
        // As a player reads it: each part's text, in order. The server logs nothing of it.
        const line = JSON.parse(args.slice(1).join(' ')) as { text?: string; extra?: { text?: string }[] }
        server.said.push([line, ...(line.extra ?? [])].map((part) => part.text ?? '').join(''))
        return ''
      }
      default:
        return plugin(server.dir, verb, args)
    }
  }

  #difficulty(server: Server, difficulty: string): string {
    if (!['peaceful', 'easy', 'normal', 'hard'].includes(difficulty)) return 'Incorrect argument for command'
    if (server.game.difficulty === difficulty)
      return `The difficulty did not change; it is already set to ${difficulty}`
    server.game.difficulty = difficulty
    return `The difficulty has been set to ${capitalized(difficulty)}`
  }

  /** Only the running game changes: its properties still say what the image wrote (seen on 26.3 and 1.21.8). */
  #defaultGameMode(server: Server, mode: string): string {
    if (!GAME_MODES.includes(mode)) return 'Incorrect argument for command'
    server.game.defaultGameMode = mode
    return `The default game mode is now ${capitalized(mode)} Mode`
  }

  #gameMode(server: Server, mode: string, target: string): string {
    if (!GAME_MODES.includes(mode)) return 'Incorrect argument for command'
    const targets =
      target === '@a' ? [...server.online] : [...server.online].filter(([, name]) => name === target)
    if (targets.length === 0) return 'No player was found'
    // A player named who is already in that mode is left alone, and the game says nothing (1.20.1, 26.3).
    const changed = target === '@a' ? targets : targets.filter(([uuid]) => server.modes.get(uuid) !== mode)
    for (const [uuid] of changed) server.modes.set(uuid, mode)
    return changed.map(([, name]) => `Set ${name}'s game mode to ${capitalized(mode)} Mode`).join('')
  }

  /** `data get entity <name> <field>`, for the fields a player page reads. */
  #data(server: Server, args: string[]): string {
    const [get, entity, name = '', field = ''] = args
    if (get !== 'get' || entity !== 'entity') return 'Unknown or incomplete command, see below for error'
    const uuid = this.#onlineNamed(server, name)
    if (uuid === null) return 'No entity was found'
    const place = server.places.get(uuid) ?? { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    const death = server.deaths.get(uuid)
    const data: Record<string, string | null> = {
      Pos: `[${place.x.toFixed(1)}d, ${place.y.toFixed(1)}d, ${place.z.toFixed(1)}d]`,
      Dimension: `"${place.dimension}"`,
      playerGameType: String(GAME_MODES.indexOf(server.modes.get(uuid) ?? 'survival')),
      LastDeathLocation: death
        ? `{pos: [I; ${death.x}, ${death.y}, ${death.z}], dimension: "${death.dimension}"}`
        : null,
      Inventory: '[]',
      EnderItems: '[]',
      equipment: null,
    }
    const value = data[field]
    return value === undefined || value === null
      ? `Found no elements matching ${field}`
      : `${name} has the following entity data: ${value}`
  }

  /** `execute in <dimension> run tp|spreadplayers …`, moving one player on. */
  #executeIn(server: Server, args: string[]): string {
    const [inWord, dimension = '', run, verb, ...rest] = args
    if (inWord !== 'in' || run !== 'run') return 'Unknown or incomplete command, see below for error'
    if (verb === 'tp') {
      const [name = '', x = '0', y = '0', z = '0'] = rest
      const uuid = this.#onlineNamed(server, name)
      if (uuid === null) return 'No entity was found'
      server.places.set(uuid, { dimension, x: Number(x), y: Number(y), z: Number(z) })
      const at = [x, y, z].map((n) => Number(n).toFixed(6)).join(', ')
      return `Teleported ${name} to ${at}`
    }
    if (verb === 'spreadplayers') {
      const [x = '0', z = '0', , range = '1'] = rest
      const name = rest.at(-1) ?? ''
      const uuid = this.#onlineNamed(server, name)
      if (uuid === null) return 'No entity was found'
      const found = spread(server, dimension, Number(x), Number(z), Number(range))
      if (found === null)
        return `Could not spread 1 entity around ${x}, ${z} (too many entities for space - try using spread of at most 0.00)`
      server.places.set(uuid, { dimension, ...found })
      return `Spread 1 entity/entities around ${x}, ${z} with an average distance of 0.00 block(s) apart`
    }
    return 'Unknown or incomplete command, see below for error'
  }

  /**
   * `execute as <name> at @s unless block ~ ~-1 ~ <block> …`, testing what a player on stands on,
   * answered as the game words it (`commands.execute.conditional.*` in its `en_us.json`).
   */
  #testFooting(server: Server, args: string[]): string {
    const [, name = '', at, self, ...tests] = args
    if (at !== 'at' || self !== '@s') return 'Unknown or incomplete command, see below for error'
    const uuid = this.#onlineNamed(server, name)
    if (uuid === null) return 'No entity was found'
    const place = server.places.get(uuid) ?? { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    const top = server.ground.get(`${place.dimension} ${Math.floor(place.x)} ${Math.floor(place.z)}`)
    const refused = new Set<string>()
    for (let i = 0; i < tests.length; i += 6) {
      const [unless, block, ...under] = tests.slice(i, i + 6)
      const id = under[3]
      if (unless !== 'unless' || block !== 'block' || under.slice(0, 3).join(' ') !== '~ ~-1 ~' || !id)
        return 'Unknown or incomplete command, see below for error'
      refused.add(id)
    }
    const on = typeof top === 'object' ? top.on : null
    return on !== null && refused.has(on) ? 'Test failed' : 'Test passed'
  }

  #onlineNamed(server: Server, name: string): string | null {
    for (const [uuid, named] of server.online) if (named === name) return uuid
    return null
  }

  /** The world keeps its game rules; PvP is one from 1.21.9. */
  async #gameRule(server: Server, rule: string, value: string | undefined): Promise<string> {
    if (rule !== 'pvp' || !pvpIsGameRule(server.env))
      return `Incorrect argument for commandgamerule ${rule}<--[HERE]`
    if (value === undefined) return `Game rule pvp is currently set to ${server.game.pvp}`
    if (value !== 'true' && value !== 'false') return 'Incorrect argument for command'
    server.game.pvp = value === 'true'
    await writeFile(join(server.dir, server.env.LEVEL ?? 'world', 'gamerules'), `pvp=${value}\n`)
    return `Game rule pvp is now set to ${value}`
  }

  /** What the access commands change on this server, and nothing else. */
  #access(server: Server): AccessServer {
    return {
      dir: server.dir,
      enforcesWhitelist: server.env.ENFORCE_WHITELIST === 'TRUE',
      checksAccounts: checksAccounts(server.env),
      lists: server.lists,
      names: server.names,
      online: server.online,
      kicks: server.kicks,
    }
  }
}

/** A zip ends with its end-of-central-directory record (at most a 64 KiB comment after it). */
function isReadableJar(bytes: Buffer): boolean {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  return (
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && end >= 0 && bytes.length - end >= 22
  )
}

const GAME_MODES: readonly string[] = ['survival', 'creative', 'adventure', 'spectator']

/** A block in a dimension, as the game names it. */
export interface FakePlace {
  dimension: string
  x: number
  y: number
  z: number
}

/**
 * Lava, the void, the height a player stands at on the column's highest block, or that height on
 * a block that hurts (`{ on: 'minecraft:magma_block', y: 64 }`), which `spreadplayers` takes all
 * the same.
 */
export type FakeGround = number | 'lava' | 'void' | { on: string; y: number }

/**
 * Where `spreadplayers` stands one player within `range` of a point: the middle of a column whose
 * highest block isn't lava, null where every column in range is lava or void. Vanilla picks one at
 * random; this takes the nearest, and the next nearest each further time it is asked around the
 * same point, so asking again lands somewhere else, as it would.
 */
function spread(
  server: Server,
  dimension: string,
  x: number,
  z: number,
  range: number,
): { x: number; y: number; z: number } | null {
  const [cx, cz] = [Math.floor(x), Math.floor(z)]
  const found: { x: number; y: number; z: number; off: number }[] = []
  for (let bx = Math.floor(x - range); bx <= Math.floor(x + range); bx++)
    for (let bz = Math.floor(z - range); bz <= Math.floor(z + range); bz++) {
      const top = server.ground.get(`${dimension} ${bx} ${bz}`) ?? 64
      if (top === 'lava' || top === 'void') continue
      const y = typeof top === 'number' ? top : top.y
      found.push({ x: bx + 0.5, y, z: bz + 0.5, off: Math.hypot(bx - cx, bz - cz) })
    }
  found.sort((a, b) => a.off - b.off)
  const key = `${dimension} ${cx} ${cz}`
  const asked = server.spreads.get(key) ?? 0
  const pick = found[asked % found.length]
  if (pick === undefined) return null
  server.spreads.set(key, asked + 1)
  return { x: pick.x, y: pick.y, z: pick.z }
}

/** Whether the release this server runs keeps PvP as a game rule: 1.21.9 and after. */
function pvpIsGameRule(env: Readonly<Record<string, string>>): boolean {
  const [major = 0, minor = 0, patch = 0] = (env.VERSION ?? '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  return major > 1 || minor > 21 || (minor === 21 && patch >= 9)
}
const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
