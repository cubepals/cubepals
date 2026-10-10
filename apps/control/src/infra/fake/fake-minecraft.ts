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
 *   server, finally derived from the name in lower case;
 * - RCON wants the secret the spec carries; a status ping answers once the world is loaded;
 * - each player on has a place and may have a last death, which `data get entity`, `tp` and
 *   `spreadplayers` (under `execute in`) read and move, answering in vanilla's words (1.20.1, 26.3).
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
  op,
  pardon,
  pardonIp,
  whitelist,
} from './fake-minecraft/access-commands.ts'
import { installJars, installPack, jarDir, placeCarried } from './fake-minecraft/image.ts'
import { AccessLists } from './fake-minecraft/lists.ts'
import { ServerLog } from './fake-minecraft/log.ts'
import { checksAccounts, dashed, NameCache, offlineUuid } from './fake-minecraft/names.ts'
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
  /** The access lists as the running server holds them. */
  lists: AccessLists
  /** Which name is which player: `usercache.json`. */
  names: NameCache
  /** What `say` and `tellraw` broadcast to the players, in order. */
  said: string[]
  /** How the running game plays: set from the properties as it starts, and by commands after. */
  game: { difficulty: string; defaultGameMode: string; pvp: boolean }
  /** Each player's game mode, by UUID: the default one as they join, or what a command set. */
  modes: Map<string, string>
  /** Where each player on is, and where each last died, by UUID. */
  places: Map<string, FakePlace>
  deaths: Map<string, FakePlace>
  log: ServerLog
}

export class FakeMinecraft implements FakeWorkload, ServerConsole, ReadinessProbe, LogSource {
  readonly #profiles: PlayerProfiles
  readonly #servers = new Map<string, Server>()
  readonly #keyOf: (handle: RuntimeHandle) => string
  #breaks: (env: Readonly<Record<string, string>>) => string | null = () => null
  #refused: RegExp | null = null
  #stalls: (env: Readonly<Record<string, string>>) => boolean = () => false

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
    server.ready = !this.#stalls(server.env)
    if (server.ready) server.log.say('[Server thread/INFO]: Done (0.100s)! For help, type "help"')
  }

  async stop(machine: FakeMachine): Promise<void> {
    const server = this.#servers.get(machine.key)
    if (server === undefined) return
    server.log.say('[Server thread/INFO]: Stopping server')
    server.running = false
    server.ready = false
    server.online.clear()
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

  /** Servers started with a matching environment run, but their world never finishes loading. */
  stallOn(matches: (env: Readonly<Record<string, string>>) => boolean): void {
    this.#stalls = matches
  }

  /** What the server broadcast to its players with `say` or `tellraw`, oldest first. */
  said(key: string): readonly string[] {
    return [...this.#require(key).said]
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
        lists: new AccessLists(),
        names: new NameCache(this.#profiles),
        said: [],
        game: { difficulty: 'easy', defaultGameMode: 'survival', pvp: true },
        modes: new Map(),
        places: new Map(),
        deaths: new Map(),
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
    const [verb = '', ...rest] = input.trim().replace(/^\//, '').split(/\s+/)
    const answer = await this.#answer(server, verb.toLowerCase(), rest, source)
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
        return this.#executeIn(server, args)
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
        return 'Unknown or incomplete command, see below for error'
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
      const [x = '0', z = '0', , , , name = ''] = rest
      const uuid = this.#onlineNamed(server, name)
      if (uuid === null) return 'No entity was found'
      server.places.set(uuid, { dimension, x: Number(x), y: 64, z: Number(z) })
      return `Spread 1 entity/entities around ${x}, ${z} with an average distance of 0.00 block(s) apart`
    }
    return 'Unknown or incomplete command, see below for error'
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

/** Whether the release this server runs keeps PvP as a game rule: 1.21.9 and after. */
function pvpIsGameRule(env: Readonly<Record<string, string>>): boolean {
  const [major = 0, minor = 0, patch = 0] = (env.VERSION ?? '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  return major > 1 || minor > 21 || (minor === 21 && patch >= 9)
}
const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
