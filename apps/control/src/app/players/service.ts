/**
 * One player's page (§15.1): where they are and where they died, their game mode, what they
 * carry and a few stats, and the three things the owner can do for them there — back to where
 * they died, to the spawn, another game mode. A player who is away gets them when they next join:
 * the ask waits here, can be taken back, and is delivered by the presence reading that sees them
 * arrive. Nobody's files are ever written. Who may ask is who may change access: the owner, held
 * to the same policy and the same per-minute count, and every ask is audited like an access change.
 */
import type { PlayerChangeView, PlayerView } from '@blockly/contracts'
import { type Db, type PlayerSnapshotJson, schema, type Tx } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
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
  dropWaiting,
  listWaiting,
  loadSnapshot,
  playedHere,
  putWaiting,
  replaceSnapshots,
  type WaitingKind,
} from './persistence.ts'
import { type PlayerAction, PlayerReading } from './reading.ts'

/** Who asks for what waits, once the player arrives. */
const ON_JOIN = 'system:access'

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
    const waiting = (await listWaiting(this.#db, server.id, [uuid])).map((w) => ({
      kind: w.kind,
      what: w.what as PlayerView['waiting'][number]['what'],
      askedAt: w.askedAt.toISOString(),
    }))
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

  /** Back to where they last died, or to the world's spawn. */
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
   * What waits for players a presence reading has just seen on: each done now, then gone. One the
   * server didn't take stays for the next reading; one with nowhere to go (they never died here)
   * is dropped. Best effort, and never holds up the reading.
   */
  async deliverWaiting(
    server: MinecraftServer,
    handle: RuntimeHandle,
    players: readonly { uuid: string; name: string }[],
  ) {
    const here = new Map(players.map((p) => [p.uuid, p.name]))
    const waiting = await listWaiting(this.#db, server.id, [...here.keys()])
    let delivered = 0
    for (const action of waiting) {
      const name = here.get(action.playerUuid) ?? action.playerName
      const outcome = await this.#reading.perform(server.id, handle, name, {
        kind: action.kind,
        what: action.what,
      } as PlayerAction)
      if (outcome !== 'done' && outcome !== 'nowhere') continue
      await this.#db.transaction(async (tx) => {
        if ((await dropWaiting(tx, server.id, action.playerUuid, action.kind)) === null) return
        await audit(
          tx,
          ON_JOIN,
          server.id,
          { uuid: action.playerUuid, name },
          {
            change: outcome === 'done' ? 'done_on_join' : 'dropped_on_join',
            kind: action.kind,
            what: action.what,
            askedBy: action.requestedBy,
          },
        )
      })
      delivered++
    }
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
      if (outcome === 'done') {
        // What was done now replaces what waited for the same.
        await dropWaiting(this.#db, server.id, uuid, action.kind)
        return { done: 'now' }
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
