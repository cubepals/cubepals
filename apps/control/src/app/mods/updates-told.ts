// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The updates Cubepals found for a server's mods (`updates.ts`), said in the game to its operators
 * as they join, with a link that opens the update on its Mods page, planned and one click from done.
 * A mod's own word that it is out of date goes to the same people (VeinMiner's tells operators as
 * they join) and says only where to download it; this says Cubepals checked the newer version runs
 * with the rest, and does it for them.
 *
 * Said in the pass that reads who is on (`operations/schedules/presence.ts`), so within a minute of
 * the join; once a join, to an operator who wasn't on at the last reading; nothing when nothing is
 * newer, or to anyone who isn't an operator. The first reading of a server after the control plane
 * starts only notes who is on, so a restart never says it again to whoever is already playing. The
 * check runs apart from the pass, which never waits on the catalog; a failure is only logged.
 *
 * Not for finding the updates (`updates.ts`), or for the words, which the website says too
 * (`updatesSaid` in `@blockly/contracts`).
 */
import { updatesSaid } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { tellWithLink } from '../../minecraft/console.ts'
import { projectTypesFor } from '../../minecraft/mods.ts'
import type { ConsoleTarget, ServerConsole } from '../ports/minecraft.ts'
import { loadRevision } from '../servers/persistence.ts'
import type { PresentPlayer } from '../servers/usage.ts'
import { identity } from './service.ts'
import type { ModUpdates } from './updates.ts'

const entries = schema.serverAccessEntries

/** What the link says. */
const LINK = 'Update on Cubepals'

export class UpdatesTold {
  readonly #db: Db
  readonly #console: Pick<ServerConsole, 'run'>
  readonly #updates: Pick<ModUpdates, 'whenFound'>
  readonly #webOrigin: string
  /** Who was on each server at its last reading; a server not here hasn't been read since the start. */
  readonly #seen = new Map<string, ReadonlySet<string>>()

  constructor(deps: {
    db: Db
    console: Pick<ServerConsole, 'run'>
    updates: Pick<ModUpdates, 'whenFound'>
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#console = deps.console
    this.#updates = deps.updates
    this.#webOrigin = deps.webOrigin
  }

  /**
   * A reading of who is on `server`: tells each operator who has just joined of the updates found.
   * Settles once they are told, or once there is nobody to tell; never rejects.
   */
  async heard(
    server: { id: string; desiredRevisionId: string },
    target: ConsoleTarget,
    players: readonly PresentPlayer[],
  ): Promise<void> {
    const before = this.#seen.get(server.id)
    this.#seen.set(server.id, new Set(players.map((p) => p.uuid)))
    if (before === undefined) return
    const joined = players.filter((p) => !before.has(p.uuid))
    if (joined.length === 0) return
    try {
      const operators = await this.#operators(server.id)
      const told = joined.filter((p) => operators.has(p.uuid))
      if (told.length === 0) return
      const revision = await loadRevision(this.#db, server.desiredRevisionId)
      const line = await this.#line(revision)
      if (line === null) return
      const url = `${this.#webOrigin}/servers/${server.id}/mods?update=all`
      for (const player of told)
        await this.#console.run(
          target,
          tellWithLink(player.name, line, { text: LINK, url }, revision.gameVersion),
        )
    } catch (error) {
      console.warn('mod updates told', server.id, error instanceof Error ? error.message : error)
    }
  }

  /** The server's operators, by UUID: the people a mod tells it is out of date. */
  async #operators(serverId: string): Promise<ReadonlySet<string>> {
    const rows = await this.#db
      .select({ uuid: entries.playerUuid })
      .from(entries)
      .where(and(eq(entries.serverId, serverId), eq(entries.list, 'operator'), eq(entries.state, 'active')))
    return new Set(rows.map((r) => r.uuid))
  }

  /** What is newer, in the website's words (`updatesSaid`); null when nothing is. */
  async #line(revision: ServerRevision): Promise<string | null> {
    const found = await this.#updates.whenFound(revision)
    const updated = revision.mods.flatMap((mod) => {
      const version = found.versions.get(identity(mod))
      return version === undefined ? [] : [{ name: mod.name, version }]
    })
    const [type] = projectTypesFor(revision.loader)
    return updatesSaid(updated, type === 'plugin' ? 'plugins' : type === 'datapack' ? 'datapacks' : 'mods')
  }
}
