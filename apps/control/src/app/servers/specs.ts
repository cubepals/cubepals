// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { BLOCKLY_ICON } from '@blockly/contracts'
import type { Queryable } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import type { MemoryTier } from '../../domain/server/size.ts'
import type { World } from '../../domain/world/world.ts'
import { COMPAT_PREFIX } from '../../minecraft/carried.ts'
import { leaveOutNow } from '../../minecraft/pack-build.ts'
import {
  IDENTITY_ENV,
  installOf,
  PLAN_ENV,
  PROXY_ENV,
  toRuntimeSpec,
  usesProxyProtocol,
  withoutFilesStep,
} from '../../minecraft/runtime-spec.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { BuiltPack } from '../artifacts/brand-pack.ts'
import type { ArtifactLinks } from '../artifacts/links.ts'
import { compatFor, projectsOf } from '../compat/service.ts'
import { loadListing } from '../listings/persistence.ts'
import { quarantinedOf } from '../mods/jar-check-records.ts'
import { loadPackContents } from '../packs/persistence.ts'
import type { InstallSeed, RuntimeSpec } from '../ports/runtime.ts'
import { acceptedSecrets, deriveServerSecret, type SecretKeyring } from '../secrets.ts'
import { withCompressedFiles } from './carried-files.ts'
import { withCurrentOwnFiles } from './own-files.ts'
import { grownStorage, loadRevision, loadWorld } from './persistence.ts'

export interface DesiredRuntime {
  revision: ServerRevision
  world: World
  spec: RuntimeSpec
  /** The whole spec's: a server whose applied digest differs boots it at its next start. */
  digest: string
  /**
   * The spec's without the owner's plan limits: what drift compares, so a plan change reaches a
   * server at its next start or change and never restarts one that is running.
   */
  driftDigest: string
  /** The runtime key version the spec's secrets come from. */
  secretsVersion: number
  /** What its install shares with other servers of its release, when a runtime can reuse it. */
  install: InstallSeed | null
  /** Whether the server it boots reads a PROXY protocol header before each connection. */
  proxyProtocol: boolean
  /** Which of Cubepals' Via plugins its boot places, by Modrinth project id (`app/compat/`). */
  compat: string[]
}

/** The spec says which key its secrets come from, so a rotation changes every digest and drift applies it. */
const SECRETS_VERSION_LABEL = 'blockly.secrets-version'

/** Hashes a spec without its secrets; drift detection compares these. */
export function specDigest(spec: RuntimeSpec): string {
  // What a runtime may leave behind when it moves storage says nothing about what the server runs.
  const {
    secrets: _secrets,
    storage: { reconstructible: _reconstructible, ...storage },
    resumesOn: _resumesOn,
    ...rest
  } = spec
  return createHash('sha256')
    .update(canonical({ ...rest, storage }))
    .digest('hex')
}

/**
 * The spec as drift sees it: without what the owner's plan sets, the picture they chose, the
 * step that moves a Paper world's Nether and End back for another server type, or Paper's reading
 * a PROXY protocol header, which a server running from before it was asked takes at its next start.
 */
export function withoutPlanLimits(spec: RuntimeSpec): RuntimeSpec {
  const ignored = [...PLAN_ENV, ...IDENTITY_ENV, PROXY_ENV]
  const { entrypoint: _entrypoint, ...rest } = spec
  const entrypoint = withoutFilesStep(spec.entrypoint)
  return {
    ...rest,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    env: Object.fromEntries(Object.entries(spec.env).filter(([name]) => !ignored.includes(name))),
    // A bigger disk, from a plan or from growing, waits for the next start like any plan limit.
    storage: { ...spec.storage, sizeGb: 0 },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Builds what a server should be running right now, from its desired revision and world. */
export class RuntimeSpecs {
  readonly #secrets: SecretKeyring
  readonly #links: ArtifactLinks
  /**
   * Cubepals' resource pack, which the site serves, and which a server offers only when it runs one
   * of Cubepals' own games and Cubepals runs it itself (marked official): its look is Cubepals'
   * alone, so a player's server made from the same template never looks like an official one.
   */
  readonly brandPack: BuiltPack

  constructor(secrets: SecretKeyring, links: ArtifactLinks, brandPack: BuiltPack) {
    this.#secrets = secrets
    this.#links = links
    this.brandPack = brandPack
  }

  /**
   * The passwords a server's console may have, the current key's first: during a rotation a server
   * not yet moved onto the new key, or one that just booted on it, answers to one of them.
   */
  rconPasswords(serverId: string): string[] {
    return acceptedSecrets(this.#secrets, serverId, 'rcon')
  }

  /** What the server should run now: its desired revision, active world and size. */
  desired(q: Queryable, server: MinecraftServer): Promise<DesiredRuntime> {
    return this.forConfig(q, server, {
      revisionId: server.desiredRevisionId,
      worldId: server.activeWorldId,
      memoryTier: server.memoryTier,
    })
  }

  /** The runtime for one configuration, such as the one last applied, to go back to it. */
  async forConfig(
    q: Queryable,
    server: MinecraftServer,
    config: { revisionId: string; worldId: string; memoryTier: MemoryTier },
  ): Promise<DesiredRuntime> {
    const revision = await withoutMalware(
      q,
      await withWhatItsPackLearned(q, await loadRevision(q, config.revisionId)),
    )
    const world = await loadWorld(q, config.worldId)
    const standing = await loadStanding(q, server.ownerId)
    const official = (await loadListing(q, server.id))?.official === true
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const { current } = this.#secrets
    const input = {
      serverId: server.id,
      revision,
      world,
      memoryTier: config.memoryTier,
      rconPassword: deriveServerSecret(current.key, server.id, 'rcon'),
      artifactUrl: this.#links.forServer(server.id),
      limits: {
        // The owner's own AFK kick where they set one, the plan's otherwise.
        playerIdleKickMinutes: standing.afkKickMinutes ?? plan.playerIdleKickMinutes,
        worldRadius: plan.worldRadius,
        storageGb: Math.max(plan.storage.startGb, await grownStorage(q, server.id)),
      },
      iconUrl:
        server.ownIcon === null
          ? this.#links.icon(server.icon ?? BLOCKLY_ICON)
          : this.#links.ownIcon(server.id, server.ownIcon),
      brandPack: official ? this.brandPack : null,
    }
    const label = (spec: RuntimeSpec) => ({
      ...spec,
      labels: { ...spec.labels, [SECRETS_VERSION_LABEL]: String(current.version) },
    })
    const placed = await compatFor(q, revision)
    // A start places the files Cubepals owns as they are now (`own-files.ts`); like the Via
    // plugins, they never arrive through drift.
    const starting = withCurrentOwnFiles(revision)
    // Its carried files compressed, so that no variable comes near Linux's limit (`carried-files.ts`).
    const labelled = label(
      withCompressedFiles(toRuntimeSpec({ ...input, revision: starting, compat: placed })),
    )
    // The Via plugins arrive at a start, never through drift: a running server isn't restarted
    // for Cubepals' compatibility layer, or for a newer pin of it.
    const driftDigest = specDigest(withoutPlanLimits(label(toRuntimeSpec(input))))
    const compat = projectsOf(placed)
    // What drift leaves for the next start, a machine asleep can leave too: it wakes as it slept.
    // But not without the Via plugins it should have, or with ones turned off: a sleeping server
    // may never stop, so its wake boots once to place them. A newer pin of the same ones waits
    // for its next boot. One that places none wakes on the drift digest alone, as before them.
    // How they are named on disk is in it too: one asleep on jars named as the image names its
    // own, which the image could remove as it started (`carried.ts`), boots once to have them.
    // So do the files Cubepals owns, where they are newer than its revision's: a server that only
    // ever sleeps and wakes would otherwise never have them. Its wake boots once to place them;
    // after that it wakes as it slept again, until Cubepals' files change once more.
    const newer =
      filesDigest(starting.files) === filesDigest(revision.files) ? [] : [filesDigest(starting.files)]
    const startOnly = [...(compat.length === 0 ? [] : [compat.join(','), COMPAT_PREFIX]), ...newer]
    const resumesOn =
      startOnly.length === 0
        ? driftDigest
        : createHash('sha256')
            .update(`${driftDigest} ${startOnly.join(' ')}`)
            .digest('hex')
    const spec = { ...labelled, resumesOn }
    return {
      revision,
      world,
      spec,
      digest: specDigest(spec),
      driftDigest,
      secretsVersion: current.version,
      install: installOf(revision),
      proxyProtocol: usesProxyProtocol(revision),
      compat,
    }
  }
}

/** A revision's carried files, by path and content, in any order, as one digest. */
const filesDigest = (files: readonly CarriedFile[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content])),
    )
    .digest('hex')

/**
 * A revision without the jars found to be malware since it was pinned (`mods/jar-checks.ts`): each
 * comes off at the server's next start, and its other files and world stay as they are.
 */
async function withoutMalware(q: Queryable, revision: ServerRevision): Promise<ServerRevision> {
  const malware = await quarantinedOf(
    q,
    revision.mods.map((m) => m.artifact.sha512),
  )
  if (malware.size === 0) return revision
  return { ...revision, mods: revision.mods.filter((m) => !malware.has(m.artifact.sha512)) }
}

/**
 * A pack server's revision with what its pack learned since it was pinned: mods that stopped a
 * server of the pack as it started are left out, and ones it turned out to need are put back
 * (docs/modpack-system.md § Verify). The same pack file teaches every server that plays it.
 */
async function withWhatItsPackLearned(q: Queryable, revision: ServerRevision): Promise<ServerRevision> {
  const pack = revision.modpack
  if (pack === null) return revision
  const contents = await loadPackContents(q, pack.artifact.sha512)
  const leaveOut = leaveOutNow(pack.leaveOut ?? [], contents?.leftOut ?? null)
  const forceInclude = (contents?.leftOut ?? []).filter((l) => l.why === 'needed').map((l) => l.path)
  const same =
    leaveOut.length === (pack.leaveOut ?? []).length && leaveOut.every((p) => pack.leaveOut?.includes(p))
  if (same && forceInclude.length === 0) return revision
  const { leaveOut: _pinned, ...rest } = pack
  return {
    ...revision,
    modpack: {
      ...rest,
      ...(leaveOut.length === 0 ? {} : { leaveOut }),
      ...(forceInclude.length === 0 ? {} : { forceInclude }),
    },
  }
}
