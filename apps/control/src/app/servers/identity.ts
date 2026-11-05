// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An owner's save of what their server is called, says and shows (`MinecraftServerService`). */
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, SERVER_ICONS, SERVER_TAGS } from '@blockly/contracts'
import type { Db, Tx } from '@blockly/db'
import { type RevisionDraft, welcome } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import { loadListing } from '../listings/persistence.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { draftOf } from '../revisions/service.ts'
import { keepSentIcon, type OwnIcon } from '../server-icons/persistence.ts'
import { redescribed, renamed } from './names.ts'
import { insertRevision, loadRevision, lockServer, saveIdentity, setDesired } from './persistence.ts'

/** What a save reads and writes outside its own transaction: the service's own. */
export interface IdentityDeps {
  db: Db
  jobs: Pick<JobQueue, 'enqueueEligibility'>
  changed: (tx: Tx, server: MinecraftServer) => Promise<void>
  audit: (tx: Tx, actor: Actor, action: string, id: string, data: Record<string, unknown>) => Promise<void>
}

/** What a save may change; whatever it leaves out stays as it is. */
export interface IdentityChange {
  name?: string
  description?: string
  icon?: string | null
  picture?: OwnIcon | null
  tags?: readonly string[]
}

export async function changeIdentity(
  deps: IdentityDeps,
  actor: Actor,
  serverId: string,
  identity: IdentityChange,
): Promise<MinecraftServer> {
  const name = identity.name?.trim()
  if (name !== undefined && (name.length === 0 || name.length > NAME_MAX_LENGTH))
    throw new AppError('invalid_name', `A name is 1 to ${NAME_MAX_LENGTH} characters.`)
  const description = identity.description?.trim()
  if (description !== undefined && description.length > DESCRIPTION_MAX_LENGTH)
    throw new AppError('invalid_choice', `A description is up to ${DESCRIPTION_MAX_LENGTH} characters.`)
  const icons: readonly string[] = SERVER_ICONS
  if (identity.icon !== undefined && identity.icon !== null && !icons.includes(identity.icon))
    throw new AppError('invalid_choice', 'Pick one of Cubepals’ icons.')
  const tags = identity.tags === undefined ? undefined : [...new Set(identity.tags)]
  const known: readonly string[] = SERVER_TAGS
  if (tags !== undefined && (tags.length > 5 || tags.some((tag) => !known.includes(tag))))
    throw new AppError('invalid_choice', `Pick up to 5 tags from: ${SERVER_TAGS.join(', ')}.`)

  const saved = await deps.db.transaction(async (tx) => {
    const server = authorize(actor, await lockServer(tx, serverId))
    const official = (await loadListing(tx, server.id))?.official === true
    const change = {
      ...renamed(server.name, name, official),
      ...redescribed(server.description, description, official),
      ...(identity.icon === undefined || identity.icon === server.icon ? {} : { icon: identity.icon }),
      ...(await keepSentIcon(tx, server, identity.picture)),
      ...(tags === undefined || tags.join() === server.tags.join() ? {} : { tags }),
    }
    if (Object.keys(change).length === 0) return server
    let next = await saveIdentity(tx, server, change)
    const desired = await loadRevision(tx, server.desiredRevisionId)
    const motd = welcome(next.name)
    const redraft = desired.settings.motd === welcome(server.name) && desired.settings.motd !== motd
    if (redraft) {
      const draft: RevisionDraft = {
        ...draftOf(desired),
        settings: { ...desired.settings, motd },
        reason: 'settings_changed',
        basedOnRevisionId: desired.id,
      }
      const revision = await insertRevision(tx, server.id, draft, requestedBy(actor))
      next = await setDesired(tx, next, { revisionId: revision.id })
    }
    await deps.changed(tx, next)
    await deps.audit(tx, actor, 'server.identity_changed', serverId, {
      ...change,
      ...(redraft ? { motd } : {}),
    })
    return next
  })
  // What a server is called and says is what the directory shows, so its listing follows it.
  if (saved.version !== undefined) await deps.jobs.enqueueEligibility([serverId])
  return saved
}
