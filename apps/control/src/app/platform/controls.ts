import type { PlatformControlsView } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import type { PlatformControls } from '../../domain/policy/policy.ts'
import {
  countFreeAccounts,
  countServers,
  countWaitlist,
  loadControls,
  lockCapacity,
} from '../accounts/persistence.ts'
import { type Actor, requestedBy } from '../actor.ts'
import type { CatalogSync, CatalogTransition } from '../catalog/sync.ts'
import { AppError, NotFound } from '../errors.ts'
import { CatalogUnavailable } from '../ports/catalog.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import { onEarlierKeys } from '../servers/persistence.ts'
import { domainJoins } from '../servers/usage.ts'
import { controlsChangedBy, latestSpendDay, namesFor, saveControls } from './persistence.ts'

/**
 * The platform's kill switches and global caps, as admins change them (§4, abuse controls). The
 * policy reads them on every check, and the directory at read time, so a change takes effect
 * at the next request. Every change is audited with what it was before.
 */
export class PlatformControlsService {
  readonly #db: Db
  readonly #catalog: CatalogSync
  readonly #refresh: () => Promise<CatalogTransition[]>
  readonly #addressing: PlayAddressing
  readonly #serverCeiling: number | null
  readonly #runtimeKeys: () => { version: number; previousVersions: readonly number[] }

  constructor(deps: {
    db: Db
    catalog: CatalogSync
    refresh: () => Promise<CatalogTransition[]>
    addressing: PlayAddressing
    /** The most servers the provider can hold, when it has a limit (§19.12). */
    serverCeiling: number | null
    /** The runtime key versions: the current one, and earlier ones still accepted. */
    runtimeKeys: () => { version: number; previousVersions: readonly number[] }
  }) {
    this.#db = deps.db
    this.#catalog = deps.catalog
    this.#refresh = deps.refresh
    this.#addressing = deps.addressing
    this.#serverCeiling = deps.serverCeiling
    this.#runtimeKeys = deps.runtimeKeys
  }

  async view(actor: Actor): Promise<PlatformControlsView> {
    if (actor.kind !== 'admin') throw new NotFound('Platform')
    const controls = await loadControls(this.#db)
    const changed = await controlsChangedBy(this.#db)
    const heard = await this.#catalog.lastHeard()
    const person = changed.by?.match(/^(?:user|admin):(.+)$/)?.[1]
    const names = await namesFor(this.#db, { users: person ? [person] : [], servers: [] })
    return {
      ...pickControls(controls),
      updatedBy: changed.by,
      updatedByEmail: person ? (names.users.get(person) ?? null) : null,
      updatedAt: changed.at.toISOString(),
      usage: await countServers(this.#db),
      signups: { freeAccounts: await countFreeAccounts(this.#db), waitlist: await countWaitlist(this.#db) },
      spend: await this.#spend(),
      catalogHeardAt: heard?.toISOString() ?? null,
      playDomains: await this.#playDomains(),
      serverCeiling: this.#serverCeiling,
      runtimeKeys: await this.#keys(),
    }
  }

  /** Today's figure, as the watchdog last wrote it; an older day's only says when it last ran. */
  async #spend(): Promise<PlatformControlsView['spend']> {
    const day = await latestSpendDay(this.#db)
    if (day === null) return null
    return {
      day: day.day,
      cents: day.cents,
      computeCents: day.computeCents,
      strayCents: day.strayCents,
      storageCents: day.storageCents,
      strayMachines: day.strayMachines,
      runningServers: day.runningServers,
      computedAt: day.computedAt.toISOString(),
      trippedAt: day.trippedAt?.toISOString() ?? null,
    }
  }

  /** Where a rotation stands: servers holding compute on an earlier key keep it accepted. */
  async #keys(): Promise<PlatformControlsView['runtimeKeys']> {
    const { version, previousVersions } = this.#runtimeKeys()
    return {
      version,
      previousVersions: [...previousVersions],
      behind: await onEarlierKeys(this.#db, version),
    }
  }

  /** Each play domain with the joins the edge saw through it: an alias with none can go (§11). */
  async #playDomains(): Promise<PlatformControlsView['playDomains']> {
    const joins = await domainJoins(this.#db)
    return this.#addressing.domains().map(({ domain, alias }) => {
      const seen = joins.get(domain)
      return { domain, alias, joins: seen?.joins ?? 0, lastJoinAt: seen?.lastJoinAt.toISOString() ?? null }
    })
  }

  /**
   * `catalog-refresh` now, rather than at the next hour: after the catalog comes back, to clear
   * a stale alert and apply what changed meanwhile. A catalog still down refuses it.
   */
  async refreshCatalog(actor: Actor): Promise<{ changed: number }> {
    if (actor.kind !== 'admin') throw new NotFound('Platform')
    const transitions = await this.#refresh().catch((error: unknown) => {
      if (error instanceof CatalogUnavailable)
        throw new AppError('catalog_unavailable', "The mod catalog isn't answering yet. Nothing changed.")
      throw error
    })
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action: 'catalog.refreshed',
      subjectType: 'platform',
      subjectId: 'catalog',
      data: { changed: transitions.length },
    })
    return { changed: transitions.length }
  }

  async set(actor: Actor, next: PlatformControls): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Platform')
    if (this.#serverCeiling !== null && next.maxServers > this.#serverCeiling)
      throw new AppError(
        'invalid_choice',
        `The hosting provider's own limit holds this deployment to ${this.#serverCeiling} servers. Raise that limit with the provider first.`,
      )
    await this.#db.transaction(async (tx) => {
      // Caps are read under the capacity lock; changing them takes it too.
      await lockCapacity(tx)
      const before = pickControls(await loadControls(tx))
      const changes = Object.fromEntries(
        (Object.keys(before) as Array<keyof PlatformControls>)
          .filter((key) => before[key] !== next[key])
          .map((key) => [key, { from: before[key], to: next[key] }]),
      )
      if (Object.keys(changes).length === 0) return
      await saveControls(tx, pickControls(next), requestedBy(actor))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'platform.controls_changed',
        subjectType: 'platform',
        subjectId: 'controls',
        data: changes,
      })
    })
  }
}

/** The switches and caps alone, from anything that carries them and more (a controls row). */
export const pickControls = (c: PlatformControls): PlatformControls => ({
  provisioningEnabled: c.provisioningEnabled,
  startsEnabled: c.startsEnabled,
  publicListingEnabled: c.publicListingEnabled,
  uploadsEnabled: c.uploadsEnabled,
  storingEnabled: c.storingEnabled,
  expiringEnabled: c.expiringEnabled,
  maxServers: c.maxServers,
  maxRunningServers: c.maxRunningServers,
  maxFreeAccounts: c.maxFreeAccounts,
  dailySpendLimitCents: c.dailySpendLimitCents,
})
