// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reaches one running server for its players: their facts from the console while they are on,
 * their files otherwise (through the runtime's exec, as access files are read, on every runtime),
 * and the console commands that move them or change their game mode. What the commands and files
 * say is `minecraft/players.ts`'s; what is kept and who may ask is the service's.
 */
import {
  accepted,
  type GameMode,
  livePlayerQueries,
  onHazard,
  type Place,
  type PlayerFacts,
  type PlayerStats,
  parseLivePlayer,
  parsePlayerFiles,
  playerFromFile,
  positionOf,
  positionQuery,
  readPlayerFiles,
  safeFooting,
  setGameMode,
  statsFromFile,
  teleportNearDeath,
  teleportToSpawn,
  worldSpawn,
} from '../../minecraft/players.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import type { FileFormats } from '../ports/formats.ts'
import type { ServerConsole } from '../ports/minecraft.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'

export type PlayerAction = { kind: 'place'; what: 'death' | 'spawn' } | { kind: 'game_mode'; what: GameMode }

/**
 * `done`; `near` where they went back where they died and stand on safe ground `blocks` away from
 * the spot (on top of the cave they died in, beside the lava); `at_spawn` where nowhere near it
 * was safe to stand (the void, a lake of lava), so they went to the spawn; `not_on` where the
 * player isn't there to do it to; `nowhere` where there is no such place (they never died here);
 * `failed` where the server didn't answer, or wouldn't.
 */
export type ActionOutcome =
  | 'done'
  | { near: Place; blocks: number }
  | 'at_spawn'
  | 'not_on'
  | 'nowhere'
  | 'failed'

/** How many times a trip back looks further out after the game stood them on a hazard. */
const FURTHER_TRIES = 4

export interface FromFiles {
  spawn: Place | null
  players: Map<string, { facts: PlayerFacts | null; stats: PlayerStats | null }>
}

export class PlayerReading {
  readonly #runtime: Pick<Runtimes, 'exec' | 'endpoint'>
  readonly #console: ServerConsole
  readonly #specs: Pick<RuntimeSpecs, 'rconPasswords'>
  readonly #formats: Pick<FileFormats, 'decodeNbt' | 'decode'>

  constructor(deps: {
    runtime: Pick<Runtimes, 'exec' | 'endpoint'>
    console: ServerConsole
    specs: Pick<RuntimeSpecs, 'rconPasswords'>
    formats: Pick<FileFormats, 'decodeNbt' | 'decode'>
  }) {
    this.#runtime = deps.runtime
    this.#console = deps.console
    this.#specs = deps.specs
    this.#formats = deps.formats
  }

  /** What the game says of a player who is on, over one console connection; null when they aren't. */
  async live(serverId: string, handle: RuntimeHandle, name: string): Promise<PlayerFacts | null> {
    const answers = await this.#console.runAll(this.#target(serverId, handle), livePlayerQueries(name))
    return parseLivePlayer(answers.map((a) => (a.ok ? a.output : null)))
  }

  /** The world's spawn and these players' files, or the most recent players' (`recent`). */
  async files(handle: RuntimeHandle, players: readonly string[] | 'recent'): Promise<FromFiles> {
    const read = await this.#runtime.exec(handle, readPlayerFiles(players), 60)
    if (read.exitCode !== 0) throw new Error(`Reading players' files failed: ${read.stderr.trim()}`)
    const files = parsePlayerFiles(read.stdout)
    const decoded: FromFiles = {
      spawn:
        files.level === null
          ? null
          : worldSpawn(await this.#formats.decodeNbt(files.level).catch(() => null)),
      players: new Map(),
    }
    for (const [uuid, file] of files.players) {
      // One unreadable file is that player's alone.
      const facts = await this.#formats
        .decodeNbt(file.data)
        .then(playerFromFile)
        .catch(() => null)
      let stats: PlayerStats | null = null
      try {
        stats = file.stats === null ? null : statsFromFile(this.#formats.decode('json', file.stats))
      } catch {
        stats = null
      }
      decoded.players.set(uuid, { facts, stats })
    }
    return decoded
  }

  /** Does it now, to a player who is on: their last death and the spawn are read at that moment. */
  async perform(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    action: PlayerAction,
  ): Promise<ActionOutcome> {
    if (action.kind === 'game_mode')
      return took(await this.#first(serverId, handle, setGameMode(name, action.what)))
    if (action.what === 'spawn') return this.#toSpawn(serverId, handle, name)
    const facts = await this.live(serverId, handle, name).catch(() => undefined)
    if (facts === undefined) return 'failed'
    if (facts === null) return 'not_on'
    if (facts.lastDeath === null) return 'nowhere'
    const near = await this.#nearDeath(serverId, handle, name, facts.lastDeath)
    if (near !== 'refused') return near
    // Nowhere near was safe to stand: the spawn, and whoever asked is told.
    const spawn = await this.#toSpawn(serverId, handle, name)
    if (spawn === 'done') return 'at_spawn'
    return spawn === 'nowhere' ? 'failed' : spawn
  }

  async #toSpawn(serverId: string, handle: RuntimeHandle, name: string): Promise<ActionOutcome> {
    const spawn = await this.files(handle, [])
      .then((files) => files.spawn)
      .catch(() => undefined)
    if (spawn === undefined) return 'failed'
    if (spawn === null) return 'nowhere'
    return took(await this.#first(serverId, handle, teleportToSpawn(name, spawn)))
  }

  /**
   * Somewhere near where they died that the game finds safe, and that isn't one of the hazards it
   * would stand them on all the same: within a block, then further out, again where they landed on
   * one. `refused` where the game found nowhere at all, or only hazards.
   */
  async #nearDeath(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    death: Place,
  ): Promise<ActionOutcome | 'refused'> {
    const [close = '', further = ''] = teleportNearDeath(name, death)
    for (const command of [close, ...Array<string>(FURTHER_TRIES).fill(further)]) {
      const moved = await this.#first(serverId, handle, [command])
      // The game looked through every column in range: asking again finds nothing new.
      if (moved === 'refused' && command === further) return 'refused'
      if (moved === 'refused') continue
      if (moved !== 'done') return moved
      const footing = await this.#ask(serverId, handle, safeFooting(name))
      if (footing === null) return 'failed'
      if (!onHazard(footing)) return this.#landed(serverId, handle, name, death)
    }
    return 'refused'
  }

  /** Where they stand now, said where it is more than a block from where they died. */
  async #landed(serverId: string, handle: RuntimeHandle, name: string, death: Place): Promise<ActionOutcome> {
    const answer = await this.#ask(serverId, handle, positionQuery(name))
    const pos = answer === null ? null : positionOf(answer)
    if (pos === null) return 'done'
    const [x, y, z] = pos.map(Math.floor) as [number, number, number]
    const blocks = Math.round(
      Math.hypot(x - Math.floor(death.x), y - Math.floor(death.y), z - Math.floor(death.z)),
    )
    return blocks <= 1 ? 'done' : { near: { dimension: death.dimension, x, y, z }, blocks }
  }

  /** Each is another way to the same end: the first the server takes is enough. */
  async #first(
    serverId: string,
    handle: RuntimeHandle,
    commands: readonly string[],
  ): Promise<'done' | 'not_on' | 'failed' | 'refused'> {
    for (const command of commands) {
      const answer = await this.#ask(serverId, handle, command)
      if (answer === null) return 'failed'
      if (accepted(answer)) return 'done'
      if (/^No (player|entity) was found/.test(answer.trim())) return 'not_on'
    }
    return 'refused'
  }

  /** The server's answer; null where it gave none. */
  #ask(serverId: string, handle: RuntimeHandle, command: string): Promise<string | null> {
    return this.#console.run(this.#target(serverId, handle), command).catch(() => null)
  }

  #target(serverId: string, handle: RuntimeHandle) {
    return {
      endpoint: this.#runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: this.#specs.rconPasswords(serverId),
    }
  }
}

/** Where there is nothing else to try, a refusal is a failure. */
function took(outcome: 'done' | 'not_on' | 'failed' | 'refused'): ActionOutcome {
  return outcome === 'refused' ? 'failed' : outcome
}
