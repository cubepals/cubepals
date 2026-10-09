import { type Db, schema, type Tx } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { copying, eligibility, trust } from '../../domain/listing/trust.ts'
import { catalogOfId } from '../../domain/mods/catalog.ts'
import { emailOf, loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import type { CatalogSync, CatalogTransition } from '../catalog/sync.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { CatalogUnavailable, type ModCatalog } from '../ports/catalog.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Mailer } from '../ports/platform.ts'
import { findServer, loadRevision, loadRuntime, lockServer } from '../servers/persistence.ts'
import { catalogViewOf, trustOf } from './judge.ts'
import {
  allowlisted,
  insertReport,
  listedPinning,
  listedServers,
  loadListing,
  loadReport,
  openReportBy,
  saveEligibility,
  setCopyable,
  setModeration,
  settleReports,
  setVisibility,
  trustProject,
  untrustProject,
} from './persistence.ts'

/** What each reason a mod isn't trusted means to its server's owner. */
const UNTRUSTED_COPY: Record<string, string> = {
  project_revoked: 'taken down by its author or the catalog',
  version_revoked: 'this version was taken down',
  not_allowlisted: 'no longer one Cubepals vouches for',
  upload: 'uploaded by hand, which the directory doesn’t list',
  unknown: 'the catalog no longer knows it',
}

/**
 * Public listings (§15.3): whether the owner wants the server public, what admins removed, and
 * whether it may be shown at all, kept as a read model re-evaluated whenever one of its inputs
 * moves. What a server is called and says lives on the server itself (its identity).
 */
export class ListingService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #events: EventBus
  readonly #jobs: JobQueue
  readonly #catalog: ModCatalog
  readonly #sync: CatalogSync
  readonly #mailer: Mailer
  readonly #webOrigin: string
  readonly #providers: readonly string[]

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    events: EventBus
    jobs: JobQueue
    catalog: ModCatalog
    sync: CatalogSync
    /** The runtimes this deployment runs: a binding to another is foreign. */
    providers: readonly string[]
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#events = deps.events
    this.#jobs = deps.jobs
    this.#catalog = deps.catalog
    this.#sync = deps.sync
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#providers = deps.providers
  }

  /**
   * Public means two things at once: a page anyone can open, and, while the server is eligible,
   * a place in the directory. Private means neither; an invite link still works either way.
   */
  async setPublic(actor: Actor, serverId: string, wanted: boolean): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (wanted) await this.#policy.require(tx, server.ownerId, { kind: 'list_publicly' })
      await setVisibility(tx, server.id, wanted ? 'published' : 'unpublished')
      await this.#audit(tx, actor, wanted ? 'listing.published' : 'listing.unpublished', server.id, {})
      await this.#changed(tx, server.id, server.ownerId)
    })
    await this.reevaluate([serverId])
  }

  /**
   * Whether others may make a server like this one. Only a setup Blockly vouches for can be
   * offered, judged as the directory judges it, so turning it on for one it can't is refused.
   */
  async setCopyable(actor: Actor, serverId: string, wanted: boolean): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (wanted) {
        const { applied } = await loadRuntime(tx, server.id, this.#providers)
        const revision = await loadRevision(tx, applied?.revisionId ?? server.desiredRevisionId)
        if (!copying(await trustOf(tx, revision), true).allowed)
          throw new AppError(
            'invalid_choice',
            'It runs something Cubepals hasn’t checked, so others can’t copy it.',
          )
      }
      await setCopyable(tx, server.id, wanted)
      await this.#audit(
        tx,
        actor,
        wanted ? 'listing.copies_offered' : 'listing.copies_withdrawn',
        server.id,
        {},
      )
      await this.#changed(tx, server.id, server.ownerId)
    })
  }

  /** Anyone signed in can flag a listing they see; once, until an admin looks at it. */
  async report(actor: Actor, serverId: string, reason: string): Promise<void> {
    if (actor.kind === 'system') throw new NotFound('Listing')
    const why = reason.trim()
    if (why.length < 3 || why.length > 500)
      throw new AppError('invalid_choice', 'Say what is wrong in 3 to 500 characters.')
    const listing = await loadListing(this.#db, serverId)
    const server = await findServer(this.#db, serverId)
    const visible =
      listing !== null &&
      listing.visibility === 'published' &&
      listing.moderation === 'clear' &&
      listing.eligible
    if (!visible || server === null || server.deletedAt !== null) throw new NotFound('Listing')
    if (server.ownerId === actor.userId) throw new AppError('invalid_choice', 'This is your own server.')
    if (await openReportBy(this.#db, serverId, actor.userId))
      throw new AppError('invalid_choice', 'You reported this listing already; an admin will look at it.')
    await insertReport(this.#db, { serverId, reporterId: actor.userId, reason: why })
  }

  /**
   * An admin's decision: removed from the directory with a note its owner sees, or restored.
   * Open reports about it are settled by the decision.
   */
  async moderate(actor: Actor, serverId: string, action: 'remove' | 'restore', note: string): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Listing')
    const said = note.trim()
    if (action === 'remove' && said.length === 0) throw new AppError('invalid_choice', 'Tell the owner why.')
    await this.#db.transaction(async (tx) => {
      const server = await lockServer(tx, serverId)
      if (server === null || (await loadListing(tx, serverId)) === null) throw new NotFound('Listing')
      await setModeration(tx, serverId, action === 'remove' ? 'removed' : 'clear', said || null)
      await settleReports(tx, { serverId }, action === 'remove' ? 'actioned' : 'dismissed')
      await this.#audit(tx, actor, action === 'remove' ? 'listing.removed' : 'listing.restored', serverId, {
        note: said,
      })
      await this.#changed(tx, serverId, server.ownerId)
    })
  }

  async dismissReport(actor: Actor, reportId: string): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Report')
    const report = await loadReport(this.#db, reportId)
    if (report === null) throw new NotFound('Report')
    await this.#db.transaction(async (tx) => {
      await settleReports(tx, { id: reportId }, 'dismissed')
      await this.#audit(tx, actor, 'listing.report_dismissed', report.serverId, { reportId })
    })
  }

  /**
   * A catalog project Blockly vouches for (§15.3), found by its id or slug. The allowlist is
   * necessary, not sufficient: the catalog's own state can still take trust back, so the state
   * seen now is recorded and the project joins the tracked set.
   */
  async trustProject(actor: Actor, idOrSlug: string, note: string | null): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Allowlist')
    let project: Awaited<ReturnType<ModCatalog['project']>>
    try {
      project = await this.#catalog.project(idOrSlug.trim())
    } catch (error) {
      if (error instanceof CatalogUnavailable)
        throw new AppError(
          'catalog_unavailable',
          `${error.catalog} isn't answering right now. Try again in a minute.`,
        )
      throw error
    }
    if (project === null) throw new NotFound('Project')
    await this.#sync.recordObserved({
      projects: new Map([[project.projectId, project.state]]),
      versions: new Map(),
    })
    const entry = {
      catalog: catalogOfId(project.projectId, this.#catalog.id),
      projectId: project.projectId,
      displayName: project.name,
      note: note?.trim() || null,
    }
    await this.#db.transaction(async (tx) => {
      await trustProject(tx, { ...entry, addedBy: requestedBy(actor) })
      await this.#audit(tx, actor, 'allowlist.added', `${entry.catalog}:${entry.projectId}`, entry, 'project')
    })
    await this.#jobs.enqueueEligibility(await listedPinning(this.#db, entry))
  }

  async untrustProject(actor: Actor, catalog: string, projectId: string): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Allowlist')
    await this.#db.transaction(async (tx) => {
      await untrustProject(tx, catalog, projectId)
      await this.#audit(tx, actor, 'allowlist.removed', `${catalog}:${projectId}`, {}, 'project')
    })
    await this.#jobs.enqueueEligibility(await listedPinning(this.#db, { catalog, projectId }))
  }

  /** Catalog states moved (§15.3): the listings pinning what moved are looked at again. */
  async catalogMoved(transitions: readonly CatalogTransition[]): Promise<void> {
    const affected = new Set<string>()
    for (const moved of transitions) {
      const pin = moved.kind === 'project' ? { projectId: moved.id } : { versionId: moved.id }
      for (const serverId of await listedPinning(this.#db, { catalog: moved.catalog, ...pin }))
        affected.add(serverId)
    }
    await this.#jobs.enqueueEligibility([...affected])
  }

  /** `listing-eligibility-sweep`: every listing, to catch a trigger that was missed. */
  async sweep(): Promise<void> {
    await this.reevaluate(await listedServers(this.#db))
  }

  /**
   * The read model, materialized (§15.3): trust of the revision the server last booted, the
   * owner's standing and restrictions, and whether the plan lists. Owners hear when it moves.
   */
  async reevaluate(serverIds: readonly string[], now = new Date()): Promise<void> {
    const vouched = await allowlisted(this.#db)
    for (const serverId of new Set(serverIds)) {
      const listing = await loadListing(this.#db, serverId)
      if (listing === null) continue
      const server = await findServer(this.#db, serverId)
      if (server === null) continue
      const { applied } = await loadRuntime(this.#db, serverId, this.#providers)
      const revision = applied === null ? null : await loadRevision(this.#db, applied.revisionId)
      const standing = await loadStanding(this.#db, server.ownerId, now)
      const verdict =
        revision === null
          ? null
          : trust(revision.mods, await catalogViewOf(this.#db, revision.mods, vouched), revision.modpack)
      const result = eligibility({
        trust: verdict,
        standing,
        entitlements: entitlementsFor(standing.plan, standing.limitOverrides),
        deleted: server.deletedAt !== null,
      })
      const changed = await saveEligibility(this.#db, serverId, {
        eligible: result.eligible,
        reasons: result.reasons,
        revisionId: revision?.id ?? null,
        at: now,
      })
      if (changed) await this.#db.transaction((tx) => this.#changed(tx, serverId, server.ownerId))
      // A listing the owner wants shown just left the directory over its mods (§15.3): say so.
      const shown = listing.visibility === 'published' && listing.moderation === 'clear' && listing.eligible
      const mods = result.reasons.filter((r) => r.code === 'untrusted_mods')
      if (shown && !result.eligible && mods.length > 0) await this.#tellOwner(server, server.name, mods)
    }
  }

  async #tellOwner(
    server: { id: string; name: string; ownerId: string },
    title: string,
    reasons: readonly { detail?: string }[],
  ): Promise<void> {
    const to = await emailOf(this.#db, server.ownerId)
    if (to === null) return
    const lines = reasons.map((r) => {
      const [name, why] = (r.detail ?? '').split(/: (?=[a-z_]+$)/)
      return `- ${name}: ${UNTRUSTED_COPY[why ?? ''] ?? 'no longer one Cubepals can vouch for'}`
    })
    await this.#mailer.send({
      to,
      subject: `“${title}” left the Cubepals directory`,
      text: [
        `Your server ${server.name} is no longer shown in the Cubepals directory, because of a mod it runs:`,
        '',
        ...lines,
        '',
        'Your server keeps running as it is. Update or remove the mod, and the listing comes back on its own:',
        `${this.#webOrigin}/servers/${server.id}/mods`,
      ].join('\n'),
    })
  }

  async #changed(tx: Tx, serverId: string, ownerId: string): Promise<void> {
    await this.#events.publish(tx, { type: 'listing_changed', serverId, ownerId })
  }

  async #audit(
    tx: Tx,
    actor: Actor,
    action: string,
    subjectId: string,
    data: Record<string, unknown>,
    subjectType = 'server',
  ) {
    await tx
      .insert(schema.auditLog)
      .values({ actor: requestedBy(actor), action, subjectType, subjectId, data })
  }
}
