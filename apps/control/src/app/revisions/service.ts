// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { ONLINE_MODE_KEPT } from '@blockly/contracts'
import { type Db, schema, type Tx } from '@blockly/db'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { type PinnedModpack, samePack } from '../../domain/mods/modpack.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import {
  bedrockOf,
  describeChanges,
  type GameSettings,
  isPlain,
  type Loader,
  type OtherVersions,
  otherVersionsOf,
  type RevisionDraft,
  runsOnPaper,
  type ServerRevision,
  type ServerSettings,
  settingsProblems,
} from '../../domain/revision/revision.ts'
import { decide } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import {
  closestTier,
  type MemoryTier,
  PARTY,
  type PartySize,
  playerCapacity,
  sizeLabel,
} from '../../domain/server/size.ts'
import { compareVersions, notOffered, supports } from '../../minecraft/versions.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import { revokedIn } from '../catalog/persistence.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { insertRevision, loadRevision, loadRuntime, lockServer, setDesired } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { presenceFor } from '../servers/usage.ts'
import { requireWithinPlan, runsOf } from './caps.ts'
import { paperPin, pinUnpinned } from './pins.ts'

export interface ChangeOptions {
  /** The owner was told which jars were taken down where they were published, and runs them anyway. */
  acknowledgeRevoked?: boolean | undefined
  /**
   * The server's version as the person saw it (§4: optimistic concurrency). A server that changed
   * since refuses the change rather than let it undo what the person hasn't seen.
   */
  version?: number | undefined
}

/**
 * The revision `changeBedrock` makes, and whether it moves plain Minecraft onto Paper; null where
 * nothing changes. Plain Minecraft that never chose its other versions lets them in with Bedrock.
 */
async function bedrockDraft(
  builds: LoaderBuilds,
  desired: ServerRevision,
  bedrock: boolean,
): Promise<{ draft: RevisionDraft; moves: boolean } | null> {
  const plain = isPlain(desired)
  if (!plain && (desired.loader !== 'paper' || desired.modpack !== null))
    throw new AppError('invalid_choice', 'Bedrock players join only a server without mods.')
  const moves = bedrock && plain && !runsOnPaper(desired)
  if (bedrockOf(desired) === bedrock && !moves) return null
  const loaderVersion = moves ? await paperPin(builds, desired.gameVersion, 'refuse') : desired.loaderVersion
  if (loaderVersion === null && moves)
    throw new AppError('invalid_choice', `Bedrock players can’t join Minecraft ${desired.gameVersion} yet.`)
  const opens = plain && bedrock && desired.settings.otherVersions === undefined
  return {
    moves,
    draft: {
      ...draftOf(desired),
      loaderVersion,
      settings: { ...desired.settings, bedrock, ...(opens ? { otherVersions: 'on' } : {}) },
      reason: moves ? 'version_changed' : 'settings_changed',
      basedOnRevisionId: desired.id,
    },
  }
}

/** Mods resolved for a change, and the revision the resolution started from. */
export interface ResolvedMods {
  basedOn: string
  mods: PinnedMod[]
  /** The carried files that go with these mods, where the change brings its own. */
  files?: CarriedFile[]
}

interface Plan {
  /** A new revision to boot; absent when only the size changes. */
  draft?: RevisionDraft
  memoryTier?: MemoryTier
  audit: { action: string; data: Record<string, unknown> }
}

/**
 * Boot configuration changes (§4, §15.5). Every change is a new revision that the server should
 * run; a running server is updated into it at once (`apply`, with automatic rollback), a stopped
 * one keeps it for its next start. Asking for what is already desired changes nothing, which
 * also makes a retried request harmless.
 */
export class RevisionService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #artifacts: ArtifactService
  readonly #providers: readonly string[]
  readonly #builds: LoaderBuilds

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    transitions: ServerTransitions
    events: EventBus
    artifacts: ArtifactService
    /** The runtime this deployment runs; applied state is read from its bindings. */
    /** The runtimes this deployment runs: a binding to another is foreign. */
    providers: readonly string[]
    loaderBuilds: LoaderBuilds
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#artifacts = deps.artifacts
    this.#providers = deps.providers
    this.#builds = deps.loaderBuilds
  }

  changeSettings(
    actor: Actor,
    serverId: string,
    game: GameSettings,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (_tx, server, desired) => {
      const settings: ServerSettings = {
        ...game,
        motd: game.motd.trim(),
        onlineMode: desired.settings.onlineMode,
        ...(desired.settings.otherVersions === undefined
          ? {}
          : { otherVersions: desired.settings.otherVersions }),
        ...(desired.settings.bedrock === undefined ? {} : { bedrock: desired.settings.bedrock }),
      }
      const problems = settingsProblems(settings, playerCapacity(server.memoryTier))
      if (problems.length > 0) throw new AppError('invalid_settings', problems.join(' '))
      const draft: RevisionDraft = {
        ...draftOf(desired),
        settings,
        reason: 'settings_changed',
        basedOnRevisionId: desired.id,
      }
      const changes = describeChanges(desired, draft)
      if (changes.length === 0) return null
      return { draft, audit: { action: 'server.settings_changed', data: { changes } } }
    })
  }

  /**
   * Whether the server checks players with Minecraft's account servers (§15.1). Its own change,
   * apart from the game settings, because it changes which player each name belongs to: the
   * access lists are keyed again for the new kind of server at its next boot, which restarts it
   * once more to load them. Free keeps it on (`Entitlements.mayTurnOffOnlineMode`); turning it on
   * is always open.
   */
  changeAuthentication(
    actor: Actor,
    serverId: string,
    onlineMode: boolean,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (tx, server, desired) => {
      if (desired.settings.onlineMode === onlineMode) return null
      const standing = await loadStanding(tx, server.ownerId)
      if (!onlineMode && !entitlementsOf(standing).mayTurnOffOnlineMode)
        throw new AppError('not_entitled', ONLINE_MODE_KEPT)
      const draft: RevisionDraft = {
        ...draftOf(desired),
        settings: { ...desired.settings, onlineMode },
        reason: 'settings_changed',
        basedOnRevisionId: desired.id,
      }
      return {
        draft,
        audit: { action: 'server.authentication_changed', data: { onlineMode } },
      }
    })
  }

  /**
   * Which other Minecraft versions' players the server lets in (`ServerSettings.otherVersions`):
   * the Via plugins Cubepals adds as it starts, or none. Only Paper runs them, plain Minecraft's
   * where it runs on Paper, so another server type has no such choice. They are Cubepals' own, never the owner's plugins, so no plan counts
   * them; they come and go with the server's next start.
   */
  changeOtherVersions(
    actor: Actor,
    serverId: string,
    otherVersions: OtherVersions,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (_tx, _server, desired) => {
      if (desired.modpack !== null || (desired.loader !== 'paper' && !runsOnPaper(desired)))
        throw new AppError('invalid_choice', 'Only a Paper server lets players on other versions in.')
      if (otherVersionsOf(desired) === otherVersions) return null
      const draft: RevisionDraft = {
        ...draftOf(desired),
        settings: { ...desired.settings, otherVersions },
        reason: 'settings_changed',
        basedOnRevisionId: desired.id,
      }
      return { draft, audit: { action: 'server.other_versions_changed', data: { otherVersions } } }
    })
  }

  /**
   * Whether the server lets Bedrock players in (`ServerSettings.bedrock`): Floodgate, and the Via
   * plugins its version needs, which Cubepals adds as it starts. Only Paper runs them. They are
   * Cubepals' own, never the owner's plugins, so no plan counts them. The change restarts a running
   * server only while nobody is on it; with players on, it is saved and the server takes it at its
   * next start.
   *
   * Plain Minecraft lets them in too. On Mojang's own server, letting them in moves it onto Paper in
   * the same change, which a start applies as any change of server type: a snapshot first, and back
   * to it if Paper doesn't come up. Its other versions come on with it where it never chose them,
   * since Bedrock players reach most releases only through them. Turning Bedrock off leaves it on
   * Paper; Mojang's own server is its own switch (`changeVersion`).
   */
  changeBedrock(
    actor: Actor,
    serverId: string,
    bedrock: boolean,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(
      actor,
      serverId,
      requestId,
      'apply',
      options,
      async (_tx, _server, desired) => {
        const next = await bedrockDraft(this.#builds, desired, bedrock)
        if (next === null) return null
        const data = { bedrock, ...(next.moves ? { onPaper: true } : {}) }
        return { draft: next.draft, audit: { action: 'server.bedrock_changed', data } }
      },
      true,
    )
  }

  /**
   * A newer game version, or another server type, with every mod resolved again for it
   * (`ModService`). Worlds only move forward: a version older than the one the world last ran is
   * refused, since the game can't open it.
   */
  changeVersion(
    actor: Actor,
    serverId: string,
    change: { gameVersion: string; loader: Loader; loaderVersion: string | null; resolved: ResolvedMods },
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (tx, server, desired) => {
      playsNoPack(desired)
      if (!supports(change.gameVersion, change.loader))
        throw new AppError('invalid_choice', notOffered(change.loader, change.gameVersion))
      const newest = await this.#newestVersion(tx, server, desired)
      if (compareVersions(change.gameVersion, newest) < 0)
        throw new AppError(
          'version_downgrade',
          `This world has run on ${newest}, and Minecraft can't open it on an older version.`,
        )
      const sameRun = runsOnPaper({ ...change, mods: change.resolved.mods }) === runsOnPaper(desired)
      if (change.gameVersion === desired.gameVersion && change.loader === desired.loader && sameRun)
        return null
      sameStart(change.resolved, desired)
      const draft: RevisionDraft = {
        ...draftOf(desired),
        gameVersion: change.gameVersion,
        loader: change.loader,
        loaderVersion: change.loaderVersion,
        mods: change.resolved.mods,
        ...(change.resolved.files ? { files: change.resolved.files } : {}),
        reason: 'version_changed',
        basedOnRevisionId: desired.id,
      }
      return {
        draft,
        audit: { action: 'server.version_changed', data: { changes: describeChanges(desired, draft) } },
      }
    })
  }

  /**
   * A revision with exactly these mods, already resolved and pinned (§15.2). Resolution is
   * `ModService`'s; this only makes the change and applies it like any other.
   */
  changeMods(
    actor: Actor,
    serverId: string,
    resolved: ResolvedMods,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (_tx, _server, desired) => {
      playsNoPack(desired)
      sameStart(resolved, desired)
      const draft: RevisionDraft = {
        ...draftOf(desired),
        mods: resolved.mods,
        ...(resolved.files ? { files: resolved.files } : {}),
        reason: 'mods_changed',
        basedOnRevisionId: desired.id,
      }
      const changes = describeChanges(desired, draft)
      if (changes.length === 0) return null
      return { draft, audit: { action: 'server.mods_changed', data: { changes } } }
    })
  }

  /**
   * Another version of the pack a server plays, or a pack its owner uploaded in its place. What it
   * runs on comes with the pack, and a world only moves forward: a pack for an older Minecraft
   * than the world has run is refused. Applied like any other change, with a snapshot first and the
   * pack before it back if the new one doesn't start (§9).
   */
  changePack(
    actor: Actor,
    serverId: string,
    change: { pack: PinnedModpack; gameVersion: string; loader: Loader; loaderVersion: string | null },
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'apply', options, async (tx, server, desired) => {
      if (desired.modpack === null)
        throw new AppError(
          'invalid_choice',
          'This server doesn’t play a modpack, so there’s no pack to change.',
        )
      if (samePack(desired.modpack, change.pack)) return null
      const newest = await this.#newestVersion(tx, server, desired)
      if (compareVersions(change.gameVersion, newest) < 0)
        throw new AppError(
          'version_downgrade',
          `This world has run on ${newest}, and ${change.pack.name} ${change.pack.versionLabel} is for ${change.gameVersion}: Minecraft can't open a world on an older version.`,
        )
      const draft: RevisionDraft = {
        ...draftOf(desired),
        gameVersion: change.gameVersion,
        loader: change.loader,
        loaderVersion: change.loaderVersion,
        mods: [],
        modpack: change.pack,
        reason: change.gameVersion === desired.gameVersion ? 'mods_changed' : 'version_changed',
        basedOnRevisionId: desired.id,
      }
      return {
        draft,
        audit: { action: 'server.pack_changed', data: { changes: describeChanges(desired, draft) } },
      }
    })
  }

  /**
   * A bigger or smaller server, chosen as people choose it: by how many play. Max players
   * follows the size down when it no longer fits.
   */
  resize(
    actor: Actor,
    serverId: string,
    size: MemoryTier | PartySize,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    const memoryTier = size in PARTY ? PARTY[size as PartySize].tier : (size as MemoryTier)
    return this.#change(actor, serverId, requestId, 'apply', options, async (tx, server, desired) => {
      if (memoryTier === server.memoryTier) return null
      await this.#policy.require(tx, server.ownerId, { kind: 'resize_server', memoryTier })
      const capacity = playerCapacity(memoryTier)
      const draft: RevisionDraft | undefined =
        desired.settings.maxPlayers > capacity
          ? {
              ...draftOf(desired),
              settings: { ...desired.settings, maxPlayers: capacity },
              reason: 'settings_changed',
              basedOnRevisionId: desired.id,
            }
          : undefined
      return {
        ...(draft ? { draft } : {}),
        memoryTier,
        audit: { action: 'server.resized', data: { from: server.memoryTier, to: memoryTier } },
      }
    })
  }

  /**
   * An earlier revision's configuration, as a new `rollback` revision. Going back to an older
   * game version would need the world from before the upgrade, which is a restore, not this.
   */
  rollback(
    actor: Actor,
    serverId: string,
    revisionId: string,
    requestId: string,
    options: ChangeOptions = {},
  ) {
    return this.#change(actor, serverId, requestId, 'rollback', options, async (tx, server, desired) => {
      const target = await loadRevision(tx, revisionId).catch(() => null)
      if (target === null || target.serverId !== server.id) throw new NotFound('Revision')
      const newest = await this.#newestVersion(tx, server, desired)
      if (compareVersions(target.gameVersion, newest) < 0)
        throw new AppError(
          'version_downgrade',
          `That revision runs ${target.gameVersion}, and this world has run on ${newest}. Restore a backup from ${target.gameVersion} to go back with its world.`,
        )
      const draft: RevisionDraft = {
        ...draftOf(target),
        // Going back never changes how players are checked: that has its own setting.
        settings: { ...target.settings, onlineMode: desired.settings.onlineMode },
        reason: 'rollback',
        basedOnRevisionId: target.id,
      }
      const changes = describeChanges(desired, draft)
      if (changes.length === 0 && server.lifecycle.status !== 'failed') return null
      return { draft, audit: { action: 'server.rolled_back', data: { to: target.number, changes } } }
    })
  }

  async #change(
    actor: Actor,
    serverId: string,
    requestId: string,
    command: 'apply' | 'rollback',
    options: ChangeOptions,
    plan: (tx: Tx, server: MinecraftServer, desired: ServerRevision) => Promise<Plan | null>,
    waitsForPlayers = false,
  ): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (options.version !== undefined && options.version !== server.version)
        throw new AppError(
          'changed_meanwhile',
          'This server changed since you looked at it. Look at it again, then try once more.',
        )
      const desired = await loadRevision(tx, server.desiredRevisionId)
      const next = await plan(tx, server, desired)
      if (next === null) return server
      const standing = await loadStanding(tx, server.ownerId)
      const entitlements = entitlementsOf(standing)
      if (next.draft) requireWithinPlan(entitlements, next.draft)
      // A size the plan no longer offers moves to the closest one it does at this change, which
      // says so; until now the server kept running on it.
      const planMove =
        next.memoryTier === undefined && !entitlements.allowedMemoryTiers.includes(server.memoryTier)
          ? closestTier(server.memoryTier, entitlements.allowedMemoryTiers)
          : null
      if (planMove !== null) {
        const capacity = playerCapacity(planMove)
        const players = (next.draft ?? desired).settings.maxPlayers
        if (players > capacity)
          throw new AppError(
            'not_entitled',
            `This change moves the server to ${sizeLabel(planMove)}, the size your plan offers, which holds up to ${capacity} players. Set max players to ${capacity} or less.`,
          )
      }
      // Rare, and brief: only a draft from a revision made before builds were pinned reads a list.
      if (next.draft) await pinUnpinned(this.#builds, next.draft)
      if (next.draft) next.draft.acknowledgedRevoked = await acknowledged(tx, next.draft, options)
      const revision = next.draft ? await insertRevision(tx, server.id, next.draft, requestedBy(actor)) : null
      if (revision) await this.#artifacts.pinned(tx, revision.mods, revision.modpack)
      // Rolling a failed server back boots it, and booting spends: the same check as a start.
      const decision = decide(server.lifecycle, { type: command })
      if (decision.kind === 'accept' && decision.operation === 'start')
        await this.#policy.require(tx, server.ownerId, {
          kind: 'start_server',
          runs: runsOf(next.memoryTier ?? planMove ?? server.memoryTier, revision ?? desired),
          serverId: server.id,
        })
      const memoryTier = next.memoryTier ?? planMove
      const moved = await setDesired(tx, server, {
        ...(revision ? { revisionId: revision.id } : {}),
        ...(memoryTier ? { memoryTier } : {}),
      })
      const result = await this.#applyChange(tx, moved, {
        command,
        requestedBy: requestedBy(actor),
        key: `${command}:${requestId}`,
        input: revision ? { revisionId: revision.id } : {},
        waitsForPlayers,
      })
      // Where the status didn't move, nothing else told the owner's pages that the server changed.
      if (result.server === moved)
        await this.#events.publish(tx, {
          type: 'server_changed',
          serverId: moved.id,
          ownerId: moved.ownerId,
          status: moved.lifecycle.status,
          version: moved.version,
        })
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: next.audit.action,
        subjectType: 'server',
        subjectId: server.id,
        data: {
          ...next.audit.data,
          ...(planMove === null ? {} : { sizeMovedByPlan: { from: server.memoryTier, to: planMove } }),
        },
      })
      return result.server
    })
  }

  /**
   * The command that applies a saved change. One that waits for players is not given while anyone is
   * on a running server: the change stays the server's desired revision, and its next start runs it.
   */
  async #applyChange(
    tx: Tx,
    moved: MinecraftServer,
    how: {
      command: 'apply' | 'rollback'
      requestedBy: string
      key: string
      input: { revisionId?: string }
      waitsForPlayers: boolean
    },
  ) {
    const occupied =
      how.waitsForPlayers &&
      moved.lifecycle.status === 'running' &&
      ((await presenceFor(tx, [moved.id])).get(moved.id)?.length ?? 0) > 0
    if (occupied) return { server: moved }
    return this.#transitions.command(
      tx,
      moved,
      { type: how.command },
      { requestedBy: how.requestedBy, idempotencyKey: how.key, input: how.input },
    )
  }

  /** The newest game version this server's world has run on, or is about to. */
  async #newestVersion(tx: Tx, server: MinecraftServer, desired: ServerRevision): Promise<string> {
    const { applied } = await loadRuntime(tx, server.id, this.#providers)
    if (applied === null) return desired.gameVersion
    const ran = await loadRevision(tx, applied.revisionId)
    return compareVersions(ran.gameVersion, desired.gameVersion) > 0 ? ran.gameVersion : desired.gameVersion
  }
}

export const draftOf = (revision: ServerRevision): RevisionDraft => ({
  gameVersion: revision.gameVersion,
  loader: revision.loader,
  loaderVersion: revision.loaderVersion,
  settings: revision.settings,
  mods: revision.mods,
  modpack: revision.modpack,
  files: revision.files,
  acknowledgedRevoked: revision.acknowledgedRevoked,
  reason: revision.reason,
  basedOnRevisionId: revision.basedOnRevisionId,
})

/**
 * A server that plays a pack runs the pack's Minecraft and the pack's mods: changing either on its
 * own would leave a revision that says one thing and runs another. The pack changes as a whole.
 */
/** A pack server's Minecraft and mods come with its pack: they change only by changing the pack. */
export function playsNoPack(desired: ServerRevision): void {
  if (desired.modpack !== null)
    throw new AppError(
      'invalid_choice',
      `This server plays ${desired.modpack.name}: its Minecraft and its mods come with the pack. Change the pack instead.`,
    )
}

/** Mods resolved against one revision fit only a change made from that revision. */
function sameStart(resolved: ResolvedMods, desired: ServerRevision): void {
  if (resolved.basedOn !== desired.id)
    throw new AppError(
      'changed_meanwhile',
      "The server's configuration changed while this was being prepared. Look at it again, then try once more.",
    )
}

/**
 * Jars taken down where they were published run only when the owner said they want them anyway
 * (§15.3): Blockly can't tell an author's clean-up from a removal for malware, so it warns and
 * lets the owner decide. What the revision no longer pins stops being acknowledged.
 */
export async function acknowledged(tx: Tx, draft: RevisionDraft, options: ChangeOptions): Promise<string[]> {
  const pinned = new Set(draft.mods.map((m) => m.artifact.sha512))
  const kept = draft.acknowledgedRevoked.filter((sha512) => pinned.has(sha512))
  const unacknowledged = (await revokedIn(tx, draft.mods)).filter((m) => !kept.includes(m.artifact.sha512))
  if (unacknowledged.length === 0) return kept
  if (!options.acknowledgeRevoked) {
    const names = unacknowledged.map((m) => m.name).join(', ')
    throw new AppError(
      'revoked_artifacts',
      `${names} ${unacknowledged.length === 1 ? 'was' : 'were'} taken down where ${unacknowledged.length === 1 ? 'it was' : 'they were'} published. That can be the author tidying up or a removal for malware; run ${unacknowledged.length === 1 ? 'it' : 'them'} only if you trust ${unacknowledged.length === 1 ? 'it' : 'them'}.`,
    )
  }
  return [...kept, ...unacknowledged.map((m) => m.artifact.sha512)]
}
