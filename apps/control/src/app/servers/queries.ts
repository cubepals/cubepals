// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AccessView,
  AddressSuggestion,
  CreateOptions,
  CuratedPackView,
  ModpackHit,
  OperationView,
  PackLinkView,
  PackVersionView,
  PurgedServerView,
  RevisionView,
  ServerView,
  SettingsOptions,
  SetupPreview,
  TemplateReleases,
  TemplateView,
  TrashedServerView,
} from '@blockly/contracts'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { type Entitlements, entitlementsFor } from '../../domain/account/entitlements.ts'
import { changeKind, describeChanges, type Loader, SETTING_BOUNDS } from '../../domain/revision/revision.ts'
import { bedtime } from '../../domain/server/idle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import {
  closestTier,
  type MemoryTier,
  memoryMb,
  PARTY,
  type PartySize,
  playerCapacity,
  sizeLabel,
} from '../../domain/server/size.ts'
import { formatJoinAddress } from '../../minecraft/address.ts'
import { joinRange } from '../../minecraft/clients.ts'
import { loaderOfPack } from '../../minecraft/mods.ts'
import { packEnvironment, packTier, suggestedForServers } from '../../minecraft/packs.ts'
import { settingTakes } from '../../minecraft/settings.ts'
import {
  compareVersions,
  DEFAULT_GAME_VERSION,
  DEFAULT_LOADER,
  LOADER_LABELS,
  offeredVersions,
  packRuns,
} from '../../minecraft/versions.ts'
import { liftedIpBans, readAccess } from '../access/persistence.ts'
import { loadControls, loadStanding } from '../accounts/persistence.ts'
import { playToday, todayView } from '../accounts/play-today.ts'
import { playTotal, totalView } from '../accounts/play-total.ts'
import { type Actor, authorize } from '../actor.ts'
import type { PackCuration } from '../curation/service.ts'
import { type Shown, shownOf } from '../edge/routed.ts'
import { cameByView } from '../edge/turned-away.ts'
import { packView } from '../mods/pack.ts'
import {
  activeOperation,
  lastWakeSeconds,
  latestOfKind,
  type OperationRecord,
  wakePathOf,
} from '../operations/persistence.ts'
import type { PackService } from '../packs/service.ts'
import { idleMinutesFor } from '../platform/room.ts'
import type { CatalogHit, ModCatalog } from '../ports/catalog.ts'
import type { PlayAddressing, RegionCatalog } from '../ports/platform.ts'
import { hasDatapacks, isModded } from '../revisions/caps.ts'
import { pictureOf } from '../server-icons/view.ts'
import { loadPackChecks } from '../setups/persistence.ts'
import { type SetupService, type SetupSource, sizeOf } from '../setups/service.ts'
import { TEMPLATES } from '../setups/templates.ts'
import {
  countLive,
  findServer,
  listOwned,
  listTrashed,
  loadRuntime,
  OUT_OF_MEMORY,
  purgedWithArchives,
  readyBackupCounts,
} from './persistence.ts'
import { partySizesFor, planFit, usableFirst } from './plan-fit.ts'
import { loadChangeFacts, loadRevisionCard, loadRevisionFields, revisionHistory } from './revision-reads.ts'
import type { MinecraftServerService } from './service.ts'
import { lastsOnceRestored } from './temporary.ts'
import { knownPlayers, lastActivity, openIntervalStart, openRun, presenceFor } from './usage.ts'

/** Who is on a running server, as presence has it; null while it isn't running. */
type Online = { uuid: string; name: string }[] | null

/** Read models for people. Derived facts — addresses, labels, who is online — are joined here. */
export class ServerQueries {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #regions: RegionCatalog
  readonly #service: MinecraftServerService
  readonly #setups: SetupService
  readonly #catalog: ModCatalog
  readonly #packs: PackService
  readonly #curation: PackCuration
  readonly #providers: readonly string[]
  /**
   * What each template needs, worked out away from anyone waiting: a template's mods come from
   * the catalogue, and a page opening the choices should never wait on it. Kept for an hour.
   */
  readonly #templateSizes = new Map<string, { tier: MemoryTier; from: string }>()
  #templatesSizedAt = 0
  #sizingTemplates: Promise<void> | null = null

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    regions: RegionCatalog
    service: MinecraftServerService
    setups: SetupService
    catalog: ModCatalog
    packs: PackService
    curation: PackCuration
    /** The runtimes this deployment runs: a binding to another is foreign. */
    providers: readonly string[]
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#regions = deps.regions
    this.#service = deps.service
    this.#setups = deps.setups
    this.#catalog = deps.catalog
    this.#packs = deps.packs
    this.#curation = deps.curation
    this.#providers = deps.providers
  }

  /** The server's configuration history, newest first, each with what it changed. */
  async revisions(actor: Actor, serverId: string): Promise<RevisionView[]> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const { applied } = await loadRuntime(this.#db, server.id, this.#providers)
    const history = await revisionHistory(this.#db, server.id, server.desiredRevisionId, 51)
    const { desired, entries: revisions } = history
    return revisions.slice(0, 50).map((revision, i) => {
      const before = revisions[i + 1]
      return {
        id: revision.id,
        number: revision.number,
        reason: revision.reason,
        gameVersion: revision.gameVersion,
        loader: revision.loader,
        createdAt: revision.createdAt.toISOString(),
        byOwner: revision.createdBy === `user:${server.ownerId}`,
        changes: before ? describeChanges(before, revision) : [],
        fromCurrent: describeChanges(desired, revision),
        desired: revision.id === server.desiredRevisionId,
        applied: revision.id === applied?.revisionId,
      }
    })
  }

  /** What the settings page may offer: bounds, versions this world can move to, sizes the plan allows. */
  async settingsOptions(actor: Actor, serverId: string): Promise<SettingsOptions> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const revision = await loadRevisionFields(this.#db, server.desiredRevisionId, ['gameVersion', 'settings'])
    const standing = await loadStanding(this.#db, server.ownerId)
    const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
    // The plan's caps are the page's bounds too, so the form asks for a value it can save.
    const caps = entitlements.settingCaps
    const capped = (bounds: { min: number; max: number }, cap: number | undefined) =>
      cap === undefined ? bounds : { ...bounds, max: Math.min(bounds.max, cap) }
    return {
      bounds: {
        ...SETTING_BOUNDS,
        viewDistance: capped(SETTING_BOUNDS.viewDistance, caps?.viewDistance),
        simulationDistance: capped(SETTING_BOUNDS.simulationDistance, caps?.simulationDistance),
        maxPlayers: Math.min(playerCapacity(server.memoryTier), caps?.maxPlayers ?? Number.POSITIVE_INFINITY),
      },
      gameVersions: offeredVersions()
        .filter((v) => compareVersions(v.id, revision.gameVersion) >= 0)
        .map((v) => ({
          value: v.id,
          label: v.id,
          loaders: v.loaders.map((loader) => {
            // The server type alone, at a size the plan sells: a legacy size is the size's own matter.
            const fit = planFit(entitlements, LOADER_LABELS[loader], {
              tier: entitlements.allowedMemoryTiers[0] ?? server.memoryTier,
              loader,
              modded: false,
            })
            return {
              value: loader,
              label: LOADER_LABELS[loader],
              allowed: fit.allowed,
              ...(fit.allowed ? {} : { reason: fit.reason }),
            }
          }),
        })),
      partySizes: partySizesFor(entitlements),
      regions: [...this.#regions.list()],
      takes: Object.fromEntries(
        Object.keys(revision.settings).map((setting) => [
          setting,
          settingTakes(setting as keyof typeof revision.settings, revision.gameVersion),
        ]),
      ) as SettingsOptions['takes'],
    }
  }

  async list(actor: Actor & { kind: 'user' }): Promise<ServerView[]> {
    const servers = await listOwned(this.#db, actor.userId)
    const presence = await presenceFor(
      this.#db,
      servers.map((s) => s.id),
    )
    const shown = await shownOf(this.#db, servers)
    return Promise.all(servers.map((s) => this.#view(s, presence.get(s.id) ?? null, shown)))
  }

  /** The account's trash: what can still be restored, and until when. */
  async trash(actor: Actor & { kind: 'user' }): Promise<TrashedServerView[]> {
    const trashed = await listTrashed(this.#db, actor.userId)
    const backups = await readyBackupCounts(
      this.#db,
      trashed.map((s) => s.id),
    )
    return trashed.flatMap((server) =>
      server.deletedAt === null || server.purgeAfter === null
        ? []
        : [
            {
              id: server.id,
              name: server.name,
              slug: server.slug,
              deletedAt: server.deletedAt.toISOString(),
              purgeAfter: server.purgeAfter.toISOString(),
              backups: backups.get(server.id) ?? { snapshots: 0, archives: 0 },
              lastsOnceRestored: lastsOnceRestored(server),
            },
          ],
    )
  }

  /** Servers gone for good whose downloadable backups are still kept, and where to get them. */
  async purgedArchives(actor: Actor & { kind: 'user' }): Promise<PurgedServerView[]> {
    return (await purgedWithArchives(this.#db, actor.userId)).map((s) => ({
      id: s.id,
      name: s.name,
      archives: s.archives,
      keptUntil: s.keptUntil?.toISOString() ?? null,
    }))
  }

  async get(actor: Actor, serverId: string): Promise<ServerView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const presence = await presenceFor(this.#db, [server.id])
    return this.#view(server, presence.get(server.id) ?? null, await shownOf(this.#db, [server]))
  }

  async access(actor: Actor, serverId: string): Promise<AccessView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const read = await readAccess(this.#db, serverId)
    // Someone is on only while the server runs, as the server's own view has it.
    const running = server.lifecycle.status === 'running'
    const players = await knownPlayers(this.#db, server.id, KNOWN_PLAYERS_OFFERED)
    return {
      whitelistEnabled: read.record.whitelistEnabled,
      pendingWhitelistEnabled: read.record.whitelistEnabledPending,
      entries: read.record.entries.map((e) => ({
        list: e.list,
        player: e.player,
        state: e.state,
        origin: e.origin,
        error: e.error,
        reason: e.details.reason ?? null,
      })),
      syncedAt: read.syncedAt?.toISOString() ?? null,
      syncError: read.syncError,
      version: read.version,
      liftedIpBans: await liftedIpBans(this.#db, serverId, new Date(Date.now() - LIFTED_SHOWN_MS)),
      players: players.map((p) => ({ name: p.name, uuid: p.uuid, online: running && p.online })),
    }
  }

  async createOptions(actor: Actor & { kind: 'user' }): Promise<CreateOptions> {
    const standing = await loadStanding(this.#db, actor.userId)
    const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
    // Each template judged as a preview judges it: its size at the smallest party against this
    // plan. A template whose size isn't known yet (just started, or the catalogue away) is
    // offered as usual, and the preview on picking it is the answer.
    const [sizes, ready] = [this.#knownTemplateSizes(), await this.#setups.readyTemplates()]
    const templates = TEMPLATES.filter((t) => ready.has(t.key)).map((template): TemplateView => {
      const size = sizes.get(template.key)
      return {
        key: template.key,
        title: template.title,
        blurb: template.blurb,
        icon: template.icon,
        advanced: template.advanced === true,
        forADay: template.forADay === true,
        // What it runs is the template's own; its size, once known, the preview's.
        fits: planFit(entitlements, size?.from ?? template.title, {
          tier: size === undefined ? PARTY['5'].tier : sizeOf('5', size.tier),
          loader: template.setup.loader,
          modded: template.setup.mods.length > 0,
        }),
      }
    })
    // The packs Blockly offers by name, judged as their preview judges them: the size each release
    // needs at the smallest party, as a modpack, against this plan.
    const packs = (await this.#curation.offered()).map(
      ({ pack, release }): CuratedPackView => ({
        key: pack.key,
        name: pack.name,
        blurb: pack.blurb,
        authors: pack.authors,
        icon: release.pack.icon,
        version: release.version,
        gameVersion: release.facts.gameVersion,
        playersNeedIt: release.facts.playersNeedIt,
        way: 'way' in pack ? (pack.way ?? null) : null,
        fits: planFit(entitlements, pack.name, {
          tier: sizeOf('5', release.facts.tier as MemoryTier),
          loader: release.facts.loader as Loader,
          modded: true,
          modpack: true,
        }),
      }),
    )
    return {
      templates: usableFirst(templates),
      packs: usableFirst(packs),
      gameVersions: offeredVersions().map((v) => ({
        value: v.id,
        label: v.id,
        recommended: v.id === DEFAULT_GAME_VERSION,
      })),
      loaders: (['vanilla', 'paper', 'fabric'] as const).map((value) => ({
        value,
        label: LOADER_LABELS[value],
      })),
      regions: [...this.#regions.list()],
      partySizes: partySizesFor(entitlements),
      defaults: {
        gameVersion: DEFAULT_GAME_VERSION,
        loader: DEFAULT_LOADER,
        regionKey: this.#regions.defaultKey,
      },
    }
  }

  /**
   * When a world its plan keeps only so long after it was last played goes, once that is within
   * the first warning; null otherwise, or while an admin has it off. Its owner reads
   * it with the way to keep it, never as a countdown anywhere else.
   */
  async #deletesAt(server: MinecraftServer, plan: Entitlements): Promise<string | null> {
    const days = plan.deleteAfterIdleDays
    if (days === null || !['stopped', 'stored'].includes(server.lifecycle.status)) return null
    const goes = server.lastActiveAt.getTime() + days * DAY_MS
    if (goes - Date.now() > 30 * DAY_MS) return null
    if (!(await loadControls(this.#db)).expiringEnabled) return null
    return new Date(Math.max(goes, Date.now())).toISOString()
  }

  /**
   * The templates' sizes as known now. When they are an hour old, or some couldn't be worked out,
   * they are worked out again in the background; nobody waits for it.
   */
  #knownTemplateSizes(): ReadonlyMap<string, { tier: MemoryTier; from: string }> {
    const stale = Date.now() - this.#templatesSizedAt > TEMPLATE_SIZES_KEPT_MS
    if (stale && this.#sizingTemplates === null) {
      this.#sizingTemplates = Promise.all(
        TEMPLATES.map(async (template) => {
          // A template is the same setup for everyone, so nobody's account is asked about.
          const resolved = await this.#setups
            .resolve({ kind: 'template', key: template.key }, null)
            .catch(() => null)
          if (resolved === null) return false
          this.#templateSizes.set(template.key, { tier: resolved.tier, from: resolved.from })
          return true
        }),
      )
        .then((sized) => {
          if (sized.every(Boolean)) this.#templatesSizedAt = Date.now()
        })
        .finally(() => {
          this.#sizingTemplates = null
        })
    }
    return this.#templateSizes
  }

  /**
   * Modpacks by name, for the one place someone asks to play one. A pack made for a player's own
   * game is no server at all: it is never suggested, and it is listed only when searched for by
   * name, so its absence isn't a mystery, and refused if picked. The rest carry the newest
   * release Blockly offers that they run on, and whether the searcher's plan runs them — one it
   * can't is offered dimmed, with why.
   *
   * Order is a balance. Browsing (nothing typed) is the most-played list of packs for servers,
   * and there the packs a plan runs come first. A search keeps the catalogue's relevance exactly:
   * sorting by what fits would bury the pack somebody typed the name of, and could lift a stray
   * upload above it just because it happens to be small.
   */
  async searchModpacks(
    actor: Actor & { kind: 'user' },
    input: { text: string; offset: number; limit: number },
  ): Promise<ModpackHit[]> {
    const browsing = input.text.trim() === ''
    const { hits } = await this.#catalog.searchModpacks(input)
    const standing = await loadStanding(this.#db, actor.userId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const ids = hits.map((hit) => hit.projectId)
    const checks = await loadPackChecks(this.#db, this.#catalog.id, ids)
    // What no one has checked yet is checked now, off the request, so the next list knows it.
    void this.#setups
      .unchecked(ids)
      .then((due) => this.#setups.checkPacks(due))
      .catch(() => undefined)
    const results = hits
      .filter((hit) => !browsing || suggestedForServers(hit.environments))
      // Browsing suggests what can be picked; a pack found refused is only found by its name.
      .filter((hit) => !browsing || (checks.get(hit.projectId)?.refusal ?? null) === null)
      .map((hit) => this.#hit(hit, plan, checks.get(hit.projectId)?.refusal ?? null))
    return browsing ? usableFirst(results) : results
  }

  /** A pack as the create flow lists it: what runs it, whether it can, and whether the plan does. */
  #hit(hit: CatalogHit, plan: Entitlements, refusal: string | null): ModpackHit {
    const loader = loaderOfPack(hit.categories ?? []) ?? 'fabric'
    return {
      projectId: hit.projectId,
      name: hit.name,
      summary: hit.summary,
      iconUrl: hit.iconUrl,
      downloads: hit.downloads,
      gameVersion:
        (hit.gameVersions ?? [])
          .filter((id) => packRuns(id, loader))
          .sort((a, b) => compareVersions(b, a))[0] ?? null,
      runsOnServers: packEnvironment(hit.environments) !== 'client',
      refusal,
      // The smallest party, as a card is judged: whether this plan runs the pack at all.
      // Its server type comes with the pack's version, found when it is picked; a pack is
      // mods whatever it runs on, and that is what a plan is asked first.
      fits: planFit(plan, hit.name, {
        tier: sizeOf('5', packTier(hit.categories)),
        loader: 'fabric',
        modded: true,
        modpack: true,
      }),
    }
  }

  /**
   * A link pasted where packs are searched: the pack it points at, at the version it names if it
   * names one, or the sentence that says what to do instead.
   */
  async packFromLink(actor: Actor & { kind: 'user' }, url: string): Promise<PackLinkView> {
    const found = await this.#packs.linkOf(url)
    if (found.kind === 'refused') return found
    const project = await this.#catalog.project(found.projectId)
    if (project === null)
      return {
        kind: 'refused',
        message: 'Cubepals couldn’t find that pack. Check the link, or search for it by name.',
        page: null,
      }
    const standing = await loadStanding(this.#db, actor.userId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const checks = await loadPackChecks(this.#db, this.#catalog.id, [project.projectId])
    const hit = this.#hit(project, plan, checks.get(project.projectId)?.refusal ?? null)
    if (found.versionRef === null) return { kind: 'pack', hit, versionId: null, versionLabel: null }
    const versions = await this.#packs.versions(project.projectId)
    const version =
      versions.find((v) => v.versionId === found.versionRef) ??
      versions.find((v) => v.label === found.versionRef)
    if (version === undefined)
      return {
        kind: 'refused',
        message: `That version of ${project.name} doesn’t run as a server Cubepals can make. Search for ${project.name} to get the newest one that does.`,
        page: null,
      }
    return { kind: 'pack', hit, versionId: version.versionId, versionLabel: version.label }
  }

  /** The versions of a pack a server can run, newest first. */
  packVersions(projectId: string): Promise<PackVersionView[]> {
    return this.#packs.versions(projectId)
  }

  /** The releases a template runs on, each with why not where it doesn't, before anyone picks one. */
  setupReleases(key: string): Promise<TemplateReleases> {
    return this.#setups.releases(key)
  }

  /**
   * What a setup would make: the release it lands on, the server type, the mods that come with
   * it and the size it needs. Everything the create flow shows before anyone commits.
   */
  async setupPreview(
    actor: Actor & { kind: 'user' },
    from: SetupSource,
    /** The party the person picked, so the preview is the server they would get. */
    partySize: PartySize = '5',
  ): Promise<SetupPreview> {
    const resolved = await this.#setups.resolve(from, actor)
    const standing = await loadStanding(this.#db, actor.userId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const size = sizeOf(partySize, resolved.tier)
    const fit = planFit(plan, resolved.from, {
      tier: size,
      loader: resolved.loader,
      modded: isModded(resolved),
      datapacks: hasDatapacks(resolved),
      modpack: resolved.modpack !== null,
    })
    return {
      from: resolved.from,
      copying:
        resolved.copying === null
          ? null
          : { name: resolved.copying.name, icon: resolved.copying.icon as ServerView['icon'] },
      gameVersion: resolved.gameVersion,
      loader: resolved.loader,
      loaderLabel: LOADER_LABELS[resolved.loader],
      joins: joinRange({
        ...resolved,
        settings: { otherVersions: resolved.setup.settings.otherVersions },
      }),
      mods: resolved.mods.map((mod) => mod.name),
      modpack:
        resolved.modpack === null
          ? null
          : {
              name: resolved.modpack.name,
              version: resolved.modpack.versionLabel,
              page: resolved.modpack.page,
              environment: resolved.modpack.environment,
              notes: resolved.notes,
            },
      size: { label: sizeLabel(size), ...fit },
    }
  }

  async suggestAddress(
    actor: Actor,
    input: { name: string; slug?: string | undefined; serverId?: string | undefined },
  ): Promise<AddressSuggestion> {
    const server = input.serverId ? authorize(actor, await findServer(this.#db, input.serverId)) : null
    const suggestion = await this.#service.suggestAddress(actor, input.name, input.slug, server?.id)
    return {
      ...suggestion,
      joinAddress: suggestion.slug === '' ? '' : formatJoinAddress(this.#addressing.primary(suggestion.slug)),
    }
  }

  /**
   * An operation as the server's page follows it. An `apply` says what it changes, from what the
   * server last booted to what it should run, so the page's wait fits the change.
   */
  async #operationView(
    op: OperationRecord,
    server: MinecraftServer,
    applied: { revisionId: string; worldId: string } | null,
  ): Promise<OperationView> {
    if (op.kind !== 'apply' || applied === null) return operationView(op, null)
    const ran = await loadChangeFacts(this.#db, applied.revisionId)
    const desired = await loadChangeFacts(this.#db, server.desiredRevisionId)
    return operationView(
      op,
      changeKind(describeChanges(ran, desired), applied.worldId === server.activeWorldId),
    )
  }

  /**
   * While it wakes, how long its last wake the same way took: from sleep with its memory kept while
   * it resumes, and from a boot otherwise, a resume its provider turned into a boot included. A
   * first resume expects what resumes measured. Read only while it wakes, since nothing else shows it.
   */
  async #wakeEstimate(server: MinecraftServer, operation: OperationRecord | null): Promise<number | null> {
    if (operation?.kind !== 'start') return null
    const path = await wakePathOf(this.#db, operation.id)
    const last = await lastWakeSeconds(this.#db, server.id, path)
    return last ?? (path === 'resumed' ? FIRST_RESUME_SECONDS : null)
  }

  /**
   * When a running server sleeps if nobody joins, by the rule the idle check stops it by. Said only
   * while nobody is on: the idle check skips a server in use.
   */
  async #sleepsAt(
    server: MinecraftServer,
    online: readonly unknown[] | null,
    played: Date | null,
    idleMinutes: number | null,
  ): Promise<string | null> {
    if (server.lifecycle.status !== 'running' || (online?.length ?? 0) > 0) return null
    return bedtime(await openRun(this.#db, server.id), played, idleMinutes)?.at.toISOString() ?? null
  }

  async #view(server: MinecraftServer, online: Online, shown: Shown): Promise<ServerView> {
    const revision = await loadRevisionCard(this.#db, server.desiredRevisionId)
    const operation = await activeOperation(this.#db, server.id)
    const binding = await loadRuntime(this.#db, server.id, this.#providers)
    const lastChange = await latestOfKind(this.#db, server.id, 'apply')
    const running = server.lifecycle.status === 'running'
    const standing = await loadStanding(this.#db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const sessionStart =
      running && plan.maxSessionMinutes !== null ? await openIntervalStart(this.#db, server.id) : null
    const played = await lastActivity(this.#db, server.id)
    const today = await playToday(this.#db, standing, plan, new Date())
    const total = await playTotal(this.#db, standing, plan, new Date())
    // A size the plan no longer offers keeps running; the owner's next change moves it.
    const movesTo = plan.allowedMemoryTiers.includes(server.memoryTier)
      ? null
      : closestTier(server.memoryTier, plan.allowedMemoryTiers)
    const applied = binding.applied
    const pendingRestart =
      server.lifecycle.status === 'stopped' &&
      applied !== null &&
      (applied.revisionId !== server.desiredRevisionId ||
        applied.memoryTier !== server.memoryTier ||
        applied.worldId !== server.activeWorldId)
    return {
      id: server.id,
      name: server.name,
      description: server.description,
      ...pictureOf(server),
      tags: [...server.tags],
      slug: server.slug,
      joinAddress: formatJoinAddress(this.#addressing.primary(server.slug)),
      status: shown(server),
      stopReason: server.lifecycle.stopReason,
      crash:
        server.lifecycle.status === 'stopped' && server.lifecycle.stopReason === 'crash'
          ? {
              outOfMemory: binding.observed?.detail === OUT_OF_MEMORY,
              detail: binding.observed?.detail ?? null,
              at: binding.observed?.at ?? null,
            }
          : null,
      failure: server.lifecycle.failure
        ? {
            during: server.lifecycle.failure.during,
            message: server.lifecycle.failure.message,
            remedy: server.lifecycle.failure.remedy ?? null,
          }
        : null,
      notLoaded: [...server.notLoaded],
      gameVersion: revision.gameVersion,
      ...(await this.#setups.compat.joins(this.#db, revision, { running, applied })),
      loader: revision.loader,
      loaderVersion: revision.loaderVersion,
      maxPlayers: revision.settings.maxPlayers,
      playStyle: revision.settings.defaultGameMode,
      region: { key: server.regionKey, label: this.#regions.label(server.regionKey) ?? server.regionKey },
      memoryTier: server.memoryTier,
      activeOperation: operation ? await this.#operationView(operation, server, applied) : null,
      lastWakeSeconds: await this.#wakeEstimate(server, operation),
      players: running
        ? { online: online?.length ?? 0, people: (online ?? []).map((p) => ({ name: p.name, uuid: p.uuid })) }
        : null,
      createdAt: server.createdAt.toISOString(),
      version: server.version,
      settings: revision.settings,
      partySize: partySizeOf(server.memoryTier),
      sessionEndsAt:
        sessionStart === null || plan.maxSessionMinutes === null
          ? null
          : new Date(sessionStart.getTime() + plan.maxSessionMinutes * MINUTE_MS).toISOString(),
      sleepsAt: await this.#sleepsAt(server, online, played, await idleMinutesFor(this.#db, plan)),
      playToday: todayView(today, server.memoryTier),
      playTotal: totalView(total, server.memoryTier),
      cameBy: await cameByView(this.#db, server),
      movesToSize: movesTo === null ? null : { tier: movesTo, label: sizeLabel(movesTo) },
      roomier: roomier(server.memoryTier, plan.allowedMemoryTiers),
      pendingRestart,
      onlyServer: (await countLive(this.#db, server.ownerId)) === 1,
      expiresAt: server.expiresAt?.toISOString() ?? null,
      deletesAt: await this.#deletesAt(server, plan),
      modCount: revision.mods.length,
      modpack: packView(this.#catalog, revision),
      everPlayed: played !== null,
      lastChange: lastChange
        ? {
            status: lastChange.status,
            error: lastChange.error,
            at: (lastChange.finishedAt ?? lastChange.createdAt).toISOString(),
          }
        : null,
    }
  }
}

function operationView(op: OperationRecord, change: OperationView['change']): OperationView {
  return {
    id: op.id,
    kind: op.kind,
    change,
    status: op.status,
    step: (op.step as OperationView['step']) ?? null,
    error: op.error,
    createdAt: op.createdAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
  }
}

/**
 * What a server's first resume is told to expect: Fly resumed in under a second, and a player was in
 * the world within 2 s.
 */
const FIRST_RESUME_SECONDS = 2

/** How long the access page mentions an IP ban Blockly lifted. */
const LIFTED_SHOWN_MS = 7 * DAY_MS

/** How many of the people who have played on a server the access page offers to name. */
const KNOWN_PLAYERS_OFFERED = 50

/** How long a template's worked-out size is trusted before it is worked out again. */
const TEMPLATE_SIZES_KEPT_MS = HOUR_MS

/** The party size selling a server's size; a legacy size shows as the smallest. */
const partySizeOf = (tier: MinecraftServer['memoryTier']): PartySize =>
  (Object.keys(PARTY) as PartySize[]).find((size) => PARTY[size].tier === tier) ?? '5'

/**
 * The next size up this plan sells, so a server that ran out of memory can be given more room in
 * one press instead of sending its owner to a settings page to work out which size that is.
 */
function roomier(
  tier: MinecraftServer['memoryTier'],
  offered: readonly MemoryTier[],
): { partySize: PartySize; label: string } | null {
  const bigger = (Object.keys(PARTY) as PartySize[])
    .filter((size) => memoryMb(PARTY[size].tier) > memoryMb(tier) && offered.includes(PARTY[size].tier))
    .sort((a, b) => memoryMb(PARTY[a].tier) - memoryMb(PARTY[b].tier))[0]
  return bigger === undefined ? null : { partySize: bigger, label: sizeLabel(PARTY[bigger].tier) }
}
