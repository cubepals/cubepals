// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One player's page (§15.1): where they are and where they died, their game mode, what they
 * carry and a few stats, and what the owner can do for them there — back to where they died, to
 * the spawn, another game mode, and the buttons for what they would otherwise type into the
 * console. A player who is away gets a trip, a game mode, items, levels or an emptied inventory
 * when they next join: the ask waits here (`kept-powers.ts` says how), can be taken back, and is
 * delivered by the presence reading that sees them arrive. Nobody's files are ever written. Who may ask is who may change access: the owner, held
 * to the same policy and the same per-minute count, and every ask is audited like an access change.
 */
import type { PlayerChangeView, PlayerPower, PlayerView } from '@blockly/contracts'
import { type Db, type PlayerSnapshotJson, schema, type Tx } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { powerSteps } from '../../minecraft/player-powers.ts'
import type { PlayerFacts, PlayerStats } from '../../minecraft/players.ts'
import { readAccess } from '../access/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { FileFormats } from '../ports/formats.ts'
import type { ServerConsole } from '../ports/minecraft.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { findServer, loadRuntime, lockServer } from '../servers/persistence.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'
import { presenceFor } from '../servers/usage.ts'
import {
  inJoinOrder,
  itemsOfPowers,
  joined,
  keptOf,
  keptPowers,
  remaining,
  waitingView,
} from './kept-powers.ts'
import {
  dropWaiting,
  holdDeliveries,
  listWaiting,
  loadSnapshot,
  playedHere,
  putWaiting,
  replaceSnapshots,
  updateWaiting,
  type WaitingAction,
  type WaitingKind,
} from './persistence.ts'
import { type ActionOutcome, type PlayerAction, PlayerReading } from './reading.ts'

/** Who asks for what waits, once the player arrives. */
const ON_JOIN = 'system:access'

/** One waiting ask done as they joined: what of it, whether all of it, and what the audit says. */
interface Delivery {
  handled: string
  stopped: boolean
  said: Record<string, string>
}

export class PlayerService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #reading: PlayerReading
  readonly #events: EventBus
  readonly #providers: readonly string[]

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    events: EventBus
    runtime: Runtimes
    console: ServerConsole
    specs: RuntimeSpecs
    formats: FileFormats
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#reading = new PlayerReading(deps)
    this.#events = deps.events
    this.#providers = deps.runtime.providers
  }

  /**
   * Read while the page is open, never for everyone: from the game while they are on, their files
   * while the server runs, and the snapshot kept as it went to sleep while it doesn't.
   */
  async view(actor: Actor, serverId: string, playerUuid: string): Promise<PlayerView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const uuid = normalizeUuid(playerUuid)
    const who = await this.#who(this.#db, server.id, uuid)
    const running = server.lifecycle.status === 'running'
    const here = running ? ((await presenceFor(this.#db, [server.id])).get(server.id) ?? []) : []
    const onNow = here.find((p) => p.uuid === uuid)
    const waiting = (await listWaiting(this.#db, server.id, [uuid]))
      .map((w) => waitingView(w.kind, w.what, w.askedAt))
      .filter((w) => w !== null)
    const base = {
      uuid,
      name: onNow?.name ?? who.name,
      online: onNow !== undefined,
      lastSeenAt: who.lastSeenAt,
      waiting,
    }

    const handle = running ? (await loadRuntime(this.#db, server.id, this.#providers)).handle : null
    if (handle !== null) {
      const [live, files] = await Promise.all([
        onNow === undefined ? null : this.#reading.live(server.id, handle, onNow.name).catch(() => null),
        this.#reading.files(handle, [uuid]).catch(() => null),
      ])
      const saved = files?.players.get(uuid)
      const facts = live ?? saved?.facts ?? null
      if (facts !== null)
        return {
          ...base,
          source: live === null ? 'files' : 'live',
          asOf: null,
          ...factsView(facts, saved?.stats ?? null),
        }
    }
    const snapshot = await loadSnapshot(this.#db, server.id, uuid)
    if (snapshot === null)
      return {
        ...base,
        source: 'none',
        asOf: null,
        position: null,
        lastDeath: null,
        gameMode: null,
        inventory: null,
        stats: null,
      }
    return { ...base, source: 'snapshot', asOf: snapshot.takenAt.toISOString(), ...snapshot.facts }
  }

  /** Back near where they last died (the spawn, where nothing near it is safe), or to the world's spawn. */
  teleport(
    actor: Actor,
    serverId: string,
    playerUuid: string,
    to: 'death' | 'spawn',
  ): Promise<PlayerChangeView> {
    return this.#change(actor, serverId, playerUuid, { kind: 'place', what: to })
  }

  setGameMode(
    actor: Actor,
    serverId: string,
    playerUuid: string,
    mode: PlayerAction['what'],
  ): Promise<PlayerChangeView> {
    return this.#change(actor, serverId, playerUuid, { kind: 'game_mode', what: mode } as PlayerAction)
  }

  /**
   * Does what the owner would otherwise type into the console, at once to a player who is on. For
   * someone away, a trip, items, levels and an emptied inventory wait for their next join; a heal,
   * a kick or a trip to someone on now mean nothing once the moment has passed, so they don't.
   */
  async act(
    actor: Actor,
    serverId: string,
    playerUuid: string,
    power: PlayerPower,
  ): Promise<PlayerChangeView> {
    const uuid = normalizeUuid(playerUuid)
    const { server, name } = await this.#db.transaction(async (tx) => {
      const server = await this.#allowed(tx, actor, serverId)
      const who = await this.#who(tx, server.id, uuid)
      await audit(
        tx,
        requestedBy(actor),
        server.id,
        { uuid, name: who.name },
        { change: 'asked', ...said(power) },
      )
      return { server, name: who.name }
    })
    const kept = keptOf(power)
    const running = server.lifecycle.status === 'running'
    const here = running ? ((await presenceFor(this.#db, [server.id])).get(server.id) ?? []) : []
    const player = here.find((p) => p.uuid === uuid)
    const { handle } =
      player === undefined ? { handle: null } : await loadRuntime(this.#db, server.id, this.#providers)
    if (player !== undefined && handle !== null) {
      // What already waits for them goes first, in its order; items wait behind an emptying that
      // still has to happen, so it can't take them.
      await this.deliverWaiting(server, handle, [player])
      const clearing = (await listWaiting(this.#db, server.id, [uuid])).some(
        (w) => w.kind === 'clear_inventory',
      )
      if (clearing && kept?.kind === 'give') return this.#keep(actor, server.id, player, kept)
      return this.#actNow(actor, server.id, handle, { player, here }, power)
    }
    if (kept !== null) return this.#keep(actor, server.id, { uuid, name: player?.name ?? name }, kept)
    if (!running) throw new AppError('server_not_running', 'Start the server to do this.')
    throw new AppError('invalid_choice', `${name} isn’t playing just now.`)
  }

  /** `act` for a player the server has on now; `here` is everyone on, for a trip to one of them. */
  async #actNow(
    actor: Actor,
    serverId: string,
    handle: RuntimeHandle,
    {
      player,
      here,
    }: { player: { uuid: string; name: string }; here: readonly { uuid: string; name: string }[] },
    power: PlayerPower,
  ): Promise<PlayerChangeView> {
    const kept = keptOf(power)
    const to = power.kind === 'to_player' ? here.find((p) => p.uuid === normalizeUuid(power.to)) : undefined
    if (power.kind === 'to_player' && (to === undefined || to.uuid === player.uuid))
      throw new AppError('invalid_choice', 'Pick someone else who is playing now.')

    const outcome = await this.#reading.steps(serverId, handle, powerSteps(player.name, power, to?.name))
    if (outcome === 'done') {
      // A trip or an emptying done now is the one that waited; items and levels waiting still add.
      if (kept?.kind === 'place' || kept?.kind === 'clear_inventory')
        await dropWaiting(this.#db, serverId, player.uuid, kept.kind)
      return { done: 'now' }
    }
    if (outcome === 'not_on') {
      // They left just as it was asked: it waits for them, where it can.
      if (kept !== null) return this.#keep(actor, serverId, player, kept)
      throw new AppError('invalid_choice', `${player.name} isn’t playing just now.`)
    }
    if (outcome === 'failed')
      throw new AppError('server_not_running', 'The server didn’t answer. Try again in a moment.')
    throw new AppError('command_refused', refusal(power, outcome.refused))
  }

  /** Takes back what waits for them to join. */
  async cancel(actor: Actor, serverId: string, playerUuid: string, kind: WaitingKind): Promise<void> {
    const uuid = normalizeUuid(playerUuid)
    await this.#db.transaction(async (tx) => {
      const server = await this.#allowed(tx, actor, serverId)
      const dropped = await dropWaiting(tx, server.id, uuid, kind)
      if (dropped === null) return
      await audit(
        tx,
        requestedBy(actor),
        server.id,
        { uuid, name: (await this.#who(tx, server.id, uuid)).name },
        {
          change: 'cancelled',
          kind,
          what: dropped.what,
        },
      )
    })
  }

  /**
   * What waits for players a presence reading has just seen on: each done now, then gone, an
   * emptied inventory before any items. One the server didn't take stays for the next reading, and
   * the rest of that player's wait with it, so the order holds across retries; items it gave only
   * some of leave the rest waiting. One with nowhere to go (they never died here), or that the game
   * refused (an item this version doesn't have), is dropped and audited. Best effort, and never
   * holds up the reading.
   */
  async deliverWaiting(
    server: MinecraftServer,
    handle: RuntimeHandle,
    players: readonly { uuid: string; name: string }[],
  ) {
    const delivered = await this.#db.transaction(async (tx) => {
      await holdDeliveries(tx, server.id)
      return this.#deliverAll(server.id, handle, players)
    })
    if (delivered > 0)
      await this.#db.transaction((tx) =>
        this.#events.publish(tx, {
          type: 'presence',
          serverId: server.id,
          ownerId: server.ownerId,
          online: players.length,
        }),
      )
  }

  /** `deliverWaiting`'s work, under its hold: how many asks were done or dropped. */
  async #deliverAll(
    serverId: string,
    handle: RuntimeHandle,
    players: readonly { uuid: string; name: string }[],
  ): Promise<number> {
    const here = new Map(players.map((p) => [p.uuid, p.name]))
    const waiting = inJoinOrder(await listWaiting(this.#db, serverId, [...here.keys()]))
    const held = new Set<string>()
    let delivered = 0
    for (const action of waiting) {
      if (held.has(action.playerUuid)) continue
      const name = here.get(action.playerUuid) ?? action.playerName
      const result = await this.#deliver(serverId, handle, name, action)
      if (result === 'later' || result.stopped) held.add(action.playerUuid)
      if (result === 'later') continue
      await this.#settle(serverId, { uuid: action.playerUuid, name }, action, result)
      delivered++
    }
    return delivered
  }

  /**
   * As the server stops, its world just saved: each recent player's facts from their files, kept
   * for the page while the server sleeps. Best effort: a server that won't answer stops all the same.
   */
  async snapshot(server: MinecraftServer, handle: RuntimeHandle, now = new Date()): Promise<void> {
    const files = await this.#reading.files(handle, 'recent').catch(() => null)
    if (files === null) return
    const kept = new Map<string, PlayerSnapshotJson>()
    for (const [uuid, read] of files.players)
      if (read.facts !== null) kept.set(uuid, factsView(read.facts, read.stats))
    await replaceSnapshots(this.#db, server.id, now, kept)
  }

  /**
   * One waiting ask, done for someone just seen on: what of it was `handled` (done, or refused by
   * the game), whether it `stopped` before the end, and what the audit says; `later` where the
   * server took none of it.
   */
  async #deliver(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    action: WaitingAction,
  ): Promise<Delivery | 'later'> {
    const powers = keptPowers(action.kind, action.what)
    if (powers !== null) return this.#deliverPowers(serverId, handle, name, action, powers)
    const outcome = await this.#reading.perform(serverId, handle, name, {
      kind: action.kind,
      what: action.what,
    } as PlayerAction)
    if (outcome === 'not_on' || outcome === 'failed') return 'later'
    return {
      handled: action.what,
      stopped: false,
      said: {
        change: outcome === 'nowhere' ? 'dropped_on_join' : 'done_on_join',
        ...(outcome === 'at_spawn' ? { instead: 'spawn' } : {}),
        ...(typeof outcome === 'object' ? { at: placed(outcome.near) } : {}),
      },
    }
  }

  /** Each power in turn, until the server stops taking them; one the game refused is let go. */
  async #deliverPowers(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    action: WaitingAction,
    powers: readonly PlayerPower[],
  ): Promise<Delivery | 'later'> {
    const refused: string[] = []
    let taken = 0
    for (const power of powers) {
      const outcome = await this.#reading.steps(serverId, handle, powerSteps(name, power))
      if (outcome === 'not_on' || outcome === 'failed') break
      if (typeof outcome === 'object') refused.push(outcome.refused)
      taken++
    }
    if (taken === 0 && powers.length > 0) return 'later'
    return {
      handled: action.kind === 'give' ? itemsOfPowers(powers.slice(0, taken)) : action.what,
      stopped: taken < powers.length,
      said: {
        change: refused.length === taken ? 'dropped_on_join' : 'done_on_join',
        ...(refused.length > 0 ? { refused: refused.join(' / ') } : {}),
      },
    }
  }

  /**
   * Takes what was handled off what waits now, under the server's lock that every ask takes: an ask
   * added while it was being done stays, and nothing handled is done twice.
   */
  async #settle(
    serverId: string,
    player: { uuid: string; name: string },
    action: WaitingAction,
    result: Delivery,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await lockServer(tx, serverId)
      const now = (await listWaiting(tx, serverId, [player.uuid])).find((w) => w.kind === action.kind)
      if (now === undefined) return
      const rest = remaining(action.kind, now.what, result.handled)
      if (rest === null) await dropWaiting(tx, serverId, player.uuid, action.kind)
      else await updateWaiting(tx, serverId, player.uuid, action.kind, rest)
      await audit(tx, ON_JOIN, serverId, player, {
        ...result.said,
        kind: action.kind,
        what: result.handled,
        askedBy: action.requestedBy,
      })
    })
  }

  /** Kept for their next join, with what already waits of the same kind (`kept-powers.ts`). */
  async #keep(
    actor: Actor,
    serverId: string,
    player: { uuid: string; name: string },
    kept: { kind: WaitingKind; what: string },
  ): Promise<PlayerChangeView> {
    await this.#db.transaction(async (tx) => {
      await lockServer(tx, serverId)
      const before = (await listWaiting(tx, serverId, [player.uuid])).find((w) => w.kind === kept.kind)
      const what = joined(kept.kind, before?.what ?? null, kept.what)
      if (what === null)
        throw new AppError(
          'invalid_choice',
          'With what already waits for them, that is more than Minecraft hands over at once. Cancel what waits, or ask for less.',
        )
      await putWaiting(tx, serverId, {
        playerUuid: player.uuid,
        playerName: player.name,
        kind: kept.kind,
        what,
        requestedBy: requestedBy(actor),
        askedAt: new Date(),
      })
    })
    return { done: 'when_they_join' }
  }

  async #change(
    actor: Actor,
    serverId: string,
    playerUuid: string,
    action: PlayerAction,
  ): Promise<PlayerChangeView> {
    const uuid = normalizeUuid(playerUuid)
    const { server, name } = await this.#db.transaction(async (tx) => {
      const server = await this.#allowed(tx, actor, serverId)
      const who = await this.#who(tx, server.id, uuid)
      await audit(tx, requestedBy(actor), server.id, { uuid, name: who.name }, { change: 'asked', ...action })
      return { server, name: who.name }
    })

    const here =
      server.lifecycle.status === 'running'
        ? ((await presenceFor(this.#db, [server.id])).get(server.id) ?? []).find((p) => p.uuid === uuid)
        : undefined
    const handle =
      here === undefined ? null : (await loadRuntime(this.#db, server.id, this.#providers)).handle
    if (here !== undefined && handle !== null) {
      const outcome = await this.#reading.perform(server.id, handle, here.name, action)
      if (outcome === 'nowhere')
        throw new AppError(
          'invalid_choice',
          action.what === 'death'
            ? `${here.name} hasn’t died on this server yet.`
            : 'This world has no spawn yet.',
        )
      if (outcome === 'done' || outcome === 'at_spawn' || typeof outcome === 'object') {
        // What was done now replaces what waited for the same.
        await dropWaiting(this.#db, server.id, uuid, action.kind)
        return doneNow(outcome, here.name)
      }
    }
    // Away, or the server didn't take it just then: it waits for them, and the page says so.
    await putWaiting(this.#db, server.id, {
      playerUuid: uuid,
      playerName: here?.name ?? name,
      kind: action.kind,
      what: action.what,
      requestedBy: requestedBy(actor),
      askedAt: new Date(),
    })
    return { done: 'when_they_join' }
  }

  async #allowed(tx: Tx, actor: Actor, serverId: string): Promise<MinecraftServer> {
    const server = authorize(actor, await lockServer(tx, serverId))
    if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'manage_access' })
    return server
  }

  /** Someone who has played here or is on one of its lists; nobody else has a page. */
  async #who(
    q: Db | Tx,
    serverId: string,
    uuid: string,
  ): Promise<{ name: string; lastSeenAt: string | null }> {
    const played = await playedHere(q, serverId, uuid)
    if (played !== null) return { name: played.name, lastSeenAt: played.lastSeenAt.toISOString() }
    const listed = (await readAccess(q, serverId)).record.entries.find((e) => e.player.uuid === uuid)
    if (listed === undefined) throw new NotFound('Player')
    return { name: listed.player.name, lastSeenAt: null }
  }
}

/** What was asked, for the audit: every value as text. */
function said(power: PlayerPower): Record<string, string> {
  return Object.fromEntries(
    Object.entries(power).map(([key, value]) => [key === 'kind' ? 'power' : key, String(value)]),
  )
}

/** Why the game wouldn't, in the owner's words where Blockly knows them, and its own otherwise. */
function refusal(power: PlayerPower, answer: string): string {
  if (power.kind === 'give' && answer.startsWith('Unknown item'))
    return `Minecraft has no item called “${power.item}” in this version.`
  if (power.kind === 'give' && answer.startsWith("Can't give more than"))
    return 'That is more of it than Minecraft hands over at once. Try fewer.'
  if (power.kind === 'teleport' && answer.startsWith('Could not spread'))
    return 'There is nowhere to stand there. Give a height to go anyway.'
  return `Minecraft said: ${answer}`
}

/** Done at once, saying so where it went other than asked. */
function doneNow(
  outcome: Exclude<ActionOutcome, 'not_on' | 'nowhere' | 'failed'>,
  name: string,
): PlayerChangeView {
  if (outcome === 'done') return { done: 'now' }
  if (outcome === 'at_spawn')
    return {
      done: 'now',
      note: `There was nowhere safe to stand near where ${name} died, so they went to the spawn.`,
    }
  return {
    done: 'now',
    note: `${name} is on safe ground ${outcome.blocks} blocks from where they died, at ${placed(outcome.near)}.`,
  }
}

/** "12, 64, 34": a block, as the game's own coordinates show it. */
function placed(place: { x: number; y: number; z: number }): string {
  return [place.x, place.y, place.z].join(', ')
}

function factsView(facts: PlayerFacts, stats: PlayerStats | null): PlayerSnapshotJson {
  return {
    position: facts.position,
    lastDeath: facts.lastDeath,
    gameMode: facts.gameMode,
    inventory: facts.inventory,
    stats,
  }
}

/**
 * Counted as an access change, since it is one person's say over another's game: the same
 * per-minute allowance, and the same audit, with who, which player and what.
 */
async function audit(
  tx: Tx,
  actor: string,
  serverId: string,
  player: { uuid: string; name: string },
  data: Record<string, string>,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    actor,
    action: 'access.changed',
    subjectType: 'server',
    subjectId: serverId,
    data: { player, ...data },
  })
}
