// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { JoinNeeds, PublicServerView, ReactionsView, ShareView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { copying, type Trust } from '../../domain/listing/trust.ts'
import { forPlayers, type PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { formatJoinAddress } from '../../minecraft/address.ts'
import { LOADER_LABELS } from '../../minecraft/versions.ts'
import { readAccess } from '../access/persistence.ts'
import { loadControls, loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { tally } from '../guestbook/persistence.ts'
import { trustOf } from '../listings/judge.ts'
import { loadListing } from '../listings/persistence.ts'
import { packView } from '../mods/pack.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { Limits } from '../ports/limits.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import {
  findByInvite,
  findLiveBySlug,
  findServer,
  loadRevision,
  loadRuntime,
} from '../servers/persistence.ts'
import { presenceFor } from '../servers/usage.ts'

/**
 * What one minute of honest use looks like on each public read. The page people open is counted
 * apart from the reads around it: the title an open page or a pasted link shows, the JSON, the
 * badge and the card. So an open counts once against the page, and nothing polling a server's
 * status can shut its page on the people opening it; the status has room for every open's title
 * and the bots besides. An invitation's two reads, its title and its page, can't be told apart
 * like that, so its limits count each open twice: thirty friends opening one link in a minute,
 * and six hundred invitations opened across every link.
 */
const PER_MINUTE = { page: 120, status: 240, invite: 60, invites: 1200 } as const

/**
 * What everyone but the owner sees (§15.6): a server's own page, the same page as an invitation,
 * and the Share sheet behind them. Nothing here says anything about machines, regions, sizes or
 * containers; it is what a player needs to decide to join and to actually get in.
 */
export class SharingQueries {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #catalog: ModCatalog
  readonly #webOrigin: string
  readonly #providers: readonly string[]
  readonly #limits: Limits

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    catalog: ModCatalog
    limits: Limits
    webOrigin: string
    /** The runtimes this deployment runs: a binding to another is foreign. */
    providers: readonly string[]
  }) {
    this.#db = deps.db
    this.#limits = deps.limits
    this.#addressing = deps.addressing
    this.#catalog = deps.catalog
    this.#webOrigin = deps.webOrigin
    this.#providers = deps.providers
  }

  /**
   * A server's public page. Null when it isn't public, so the page can say so without guessing.
   * Its stars and notes are counted only where asked for: the page people open shows them, while
   * the status, badge and card that bots fetch have no use for them.
   */
  async page(
    slug: string,
    viewer: Actor | null,
    options: { reactions?: boolean } = {},
  ): Promise<PublicServerView | null> {
    // The page people open is the read that shows its stars and notes.
    const opened = options.reactions === true
    await this.#within(
      opened ? `page:${slug}` : `status:${slug}`,
      opened ? PER_MINUTE.page : PER_MINUTE.status,
    )
    const server = await findLiveBySlug(this.#db, slug)
    if (server === null) return null
    const owner = viewer?.kind === 'user' && viewer.userId === server.ownerId
    const shown = await this.#shown(server)
    if (!owner && !shown) return null
    const reader =
      viewer === null || viewer.kind === 'system' || viewer.kind === 'operator' ? null : viewer.userId
    return this.#view(server, {
      invited: false,
      preview: owner && !shown,
      yours: owner,
      reactions:
        options.reactions === true && shown
          ? { serverId: server.id, ...(await tally(this.#db, server.id, reader)), yours: owner }
          : null,
    })
  }

  /** The same page, reached through an invite link: it works while the server is private. */
  async invite(code: string, viewer: Actor | null = null): Promise<PublicServerView | null> {
    // Per code, and across every code at once: one invitation being opened by the friends it
    // was sent to is ordinary; thousands of different codes in a minute is somebody guessing.
    await this.#within(`invite:${code}`, PER_MINUTE.invite)
    await this.#within('invites', PER_MINUTE.invites)
    const server = await findByInvite(this.#db, code)
    if (server === null) return null
    // An invitation is the owner's own link, so only a takedown stops it.
    const listing = await loadListing(this.#db, server.id)
    if (listing?.moderation === 'removed') return null
    if ((await loadStanding(this.#db, server.ownerId)).status !== 'active') return null
    const owner = viewer?.kind === 'user' && viewer.userId === server.ownerId
    return this.#view(server, { invited: true, preview: false, yours: owner, reactions: null })
  }

  /** Everything behind the owner's one Share action. */
  async share(actor: Actor, serverId: string): Promise<ShareView> {
    const server = await findServer(this.#db, serverId)
    if (server === null || (actor.kind === 'user' && server.ownerId !== actor.userId))
      throw new NotFound('Server')
    const listing = await loadListing(this.#db, server.id)
    const paused = !(await loadControls(this.#db)).publicListingEnabled
    const access = await readAccess(this.#db, server.id)
    const isPublic = listing?.visibility === 'published'
    const { applied } = await loadRuntime(this.#db, server.id, this.#providers)
    const verdict = await trustOf(
      this.#db,
      await loadRevision(this.#db, applied?.revisionId ?? server.desiredRevisionId),
    )
    const copies = copying(verdict, listing?.copyable ?? true)
    return {
      joinAddress: formatJoinAddress(this.#addressing.primary(server.slug)),
      inviteUrl: `${this.#webOrigin}/join/${server.inviteCode}`,
      pageUrl: `${this.#webOrigin}/server/${server.slug}`,
      public: isPublic,
      listed: isPublic && !paused && listing?.moderation === 'clear' && (listing?.eligible ?? false),
      reasons: (listing?.ineligibleReasons ?? []).map((reason) => ({
        code: reason.code,
        ...(reason.detail ? { detail: reason.detail } : {}),
      })),
      directoryPaused: paused,
      moderation: listing?.moderation ?? 'clear',
      moderationNote: listing?.moderationNote ?? null,
      whitelistOnly: access.record.whitelistEnabledPending ?? access.record.whitelistEnabled,
      copying: {
        on: copies.allowed,
        locked: copies.locked,
        why: copies.locked ? keptFromCopies(verdict) : null,
      },
    }
  }

  /**
   * What one minute of honest reading looks like. Nobody signs in to reach these, so there is no
   * account to count against; what is counted is the thing being asked about, which whoever is
   * asking cannot change. So a refusal is everyone's busy minute, never the reader's own doing,
   * and it says so.
   */
  async #within(key: string, limit: number): Promise<void> {
    if (!(await this.#limits.allow(key, limit)))
      throw new AppError('rate_limited', 'Cubepals is busy for a moment. Try again shortly.')
  }

  /** Whether anyone may open this server's page: the owner's choice, moderation and standing. */
  async #shown(server: MinecraftServer): Promise<boolean> {
    const listing = await loadListing(this.#db, server.id)
    if (listing === null || listing.visibility !== 'published' || listing.moderation !== 'clear') return false
    if (!(await loadControls(this.#db)).publicListingEnabled) return false
    return (await loadStanding(this.#db, server.ownerId)).status === 'active'
  }

  async #view(
    server: MinecraftServer,
    how: { invited: boolean; preview: boolean; yours: boolean; reactions: ReactionsView | null },
  ): Promise<PublicServerView> {
    // What it runs is what it last booted, where there is one: a page shouldn't promise a mod
    // that is only queued for the next start.
    const { applied } = await loadRuntime(this.#db, server.id, this.#providers)
    const revision = await loadRevision(
      this.#db,
      applied === null ? server.desiredRevisionId : applied.revisionId,
    )
    const access = await readAccess(this.#db, server.id)
    const online = (await presenceFor(this.#db, [server.id])).get(server.id) ?? []
    const listing = await loadListing(this.#db, server.id)
    const awake = server.lifecycle.status === 'running'
    return {
      slug: server.slug,
      name: server.name,
      description: server.description,
      icon: (server.icon as PublicServerView['icon']) ?? null,
      tags: [...server.tags],
      joinAddress: formatJoinAddress(this.#addressing.primary(server.slug)),
      awake,
      wakesSlowly: server.lifecycle.status === 'stored' || server.lifecycle.status === 'storing',
      online: awake ? online.length : 0,
      maxPlayers: revision.settings.maxPlayers,
      // Names are shown only where the server checked them (§15.1).
      players: awake && revision.settings.onlineMode ? online.map((player) => player.name) : [],
      checksAccounts: revision.settings.onlineMode,
      gameVersion: revision.gameVersion,
      loader: revision.loader,
      needs: this.#needs(revision),
      mods: revision.mods.filter((mod) => mod.origin === 'user').map((mod) => mod.name),
      whitelistOnly: access.record.whitelistEnabledPending ?? access.record.whitelistEnabled,
      invited: how.invited,
      public: listing?.visibility === 'published',
      preview: how.preview,
      // Only a configuration that has actually booted is worth offering to copy, only one Blockly
      // vouches for may be, and only while its owner offers it.
      copyable:
        applied !== null && copying(await trustOf(this.#db, revision), listing?.copyable ?? true).allowed,
      yours: how.yours,
      reactions: how.reactions,
    }
  }

  /**
   * What a player installs before joining. Plain Minecraft is enough unless a mod has to be in
   * their game too: a server-side mod is the server's business, not theirs.
   */
  #needs(revision: ServerRevision): JoinNeeds {
    // A pack the server runs on its own asks nothing of players: plain Minecraft joins.
    if (revision.modpack?.environment === 'server')
      return { gameVersion: revision.gameVersion, modpack: null, loader: null, mods: [] }
    // Otherwise the pack is the whole answer: installing it brings the loader and every mod.
    if (revision.modpack !== null)
      return {
        gameVersion: revision.gameVersion,
        modpack: packView(this.#catalog, revision),
        loader: null,
        mods: [],
      }
    const theirs = forPlayers(revision.mods)
    const loaderNeeded = theirs.length > 0 && revision.loader !== 'vanilla' && revision.loader !== 'paper'
    return {
      gameVersion: revision.gameVersion,
      modpack: null,
      loader: loaderNeeded
        ? { label: LOADER_LABELS[revision.loader], version: revision.loaderVersion }
        : null,
      mods: theirs.map((mod) => ({ name: mod.name, url: this.#page_(mod) })),
    }
  }

  #page_(mod: PinnedMod): string | null {
    return 'projectId' in mod.source && (this.#catalog.ids ?? [this.#catalog.id]).includes(mod.source.catalog)
      ? this.#catalog.projectPage(mod.source.projectId)
      : null
  }
}

/** Why a server can't be copied, in the owner's terms: the first thing that keeps it off. */
function keptFromCopies(verdict: Trust): string {
  const reasons = verdict.kind === 'untrusted' ? verdict.mods.map((mod) => mod.reason) : []
  if (reasons.includes('upload')) return 'It runs a mod you uploaded, which is yours alone.'
  if (reasons.includes('project_revoked') || reasons.includes('version_revoked'))
    return 'It runs a mod that was taken down where it was published.'
  if (reasons.includes('modpack')) return 'It plays a modpack, and Cubepals hasn’t checked every mod in it.'
  return 'It runs mods Cubepals hasn’t checked yet.'
}
