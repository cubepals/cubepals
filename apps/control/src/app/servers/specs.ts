import { createHash } from 'node:crypto'
import { BLOCKLY_ICON } from '@blockly/contracts'
import type { Queryable } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import type { MemoryTier } from '../../domain/server/size.ts'
import type { World } from '../../domain/world/world.ts'
import { leaveOutNow } from '../../minecraft/pack-build.ts'
import {
  IDENTITY_ENV,
  installOf,
  PLAN_ENV,
  toRuntimeSpec,
  withoutFilesStep,
} from '../../minecraft/runtime-spec.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { ArtifactLinks } from '../artifacts/links.ts'
import { loadPackContents } from '../packs/persistence.ts'
import type { InstallSeed, RuntimeSpec } from '../ports/runtime.ts'
import { acceptedSecrets, deriveServerSecret, type SecretKeyring } from '../secrets.ts'
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
}

/** The spec says which key its secrets come from, so a rotation changes every digest and drift applies it. */
const SECRETS_VERSION_LABEL = 'blockly.secrets-version'

/** Hashes a spec without its secrets; drift detection compares these. */
export function specDigest(spec: RuntimeSpec): string {
  // What a runtime may leave behind when it moves storage says nothing about what the server runs.
  const {
    secrets: _secrets,
    storage: { reconstructible: _reconstructible, ...storage },
    ...rest
  } = spec
  return createHash('sha256')
    .update(canonical({ ...rest, storage }))
    .digest('hex')
}

/**
 * The spec as drift sees it: without what the owner's plan sets, the picture they chose, or the
 * step that moves a Paper world's Nether and End back for another server type.
 */
export function withoutPlanLimits(spec: RuntimeSpec): RuntimeSpec {
  const ignored = [...PLAN_ENV, ...IDENTITY_ENV]
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

  constructor(secrets: SecretKeyring, links: ArtifactLinks) {
    this.#secrets = secrets
    this.#links = links
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
    const revision = await withWhatItsPackLearned(q, await loadRevision(q, config.revisionId))
    const world = await loadWorld(q, config.worldId)
    const standing = await loadStanding(q, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const { current } = this.#secrets
    const built = toRuntimeSpec({
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
      iconUrl: this.#links.icon(server.icon ?? BLOCKLY_ICON),
    })
    const spec = { ...built, labels: { ...built.labels, [SECRETS_VERSION_LABEL]: String(current.version) } }
    return {
      revision,
      world,
      spec,
      digest: specDigest(spec),
      driftDigest: specDigest(withoutPlanLimits(spec)),
      secretsVersion: current.version,
      install: installOf(revision),
    }
  }
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
