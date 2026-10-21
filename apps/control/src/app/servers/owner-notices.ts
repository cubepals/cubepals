// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling an owner, at once, what Cubepals changed on their server: an operator or an admin gave
 * it a new address, or took it out of Browse. Each is one email from the address nobody reads
 * (MAIL_NOTICE_FROM), sent after the change is stored. A change the owner makes to their own
 * server, an admin's included, sends nothing.
 *
 * A new address goes through `changeAddress` here, which the admin pages and the operators' API
 * share: the server service makes the change and this tells the owner. The listing service tells
 * of an unlisting itself, once its transaction has committed. `bun scripts/ops.ts notice` sends
 * either for a change made before notices existed. Not for anything the owner should answer:
 * nobody reads replies.
 */
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { formatJoinAddress } from '../../minecraft/address.ts'
import { emailOf } from '../accounts/persistence.ts'
import { type Actor, runsThePlatform } from '../actor.ts'
import { addressChanged, unlisted } from '../emails/notices.ts'
import type { Email } from '../emails.ts'
import { AppError, NotFound } from '../errors.ts'
import { loadListing } from '../listings/persistence.ts'
import type { Mailer, PlayAddressing } from '../ports/platform.ts'
import { findServer } from './persistence.ts'
import type { MinecraftServerService } from './service.ts'

export class OwnerNotices {
  readonly #db: Db
  readonly #mailer: Mailer
  readonly #addressing: PlayAddressing
  readonly #webOrigin: string
  readonly #servers: Pick<MinecraftServerService, 'changeAddress'>

  constructor(deps: {
    db: Db
    mailer: Mailer
    addressing: PlayAddressing
    webOrigin: string
    servers: Pick<MinecraftServerService, 'changeAddress'>
  }) {
    this.#servers = deps.servers
    this.#db = deps.db
    this.#mailer = deps.mailer
    this.#addressing = deps.addressing
    this.#webOrigin = deps.webOrigin
  }

  /**
   * A new address, as the server service gives it, then told to the owner when someone else gave
   * it. The change stands even if the email fails; that is logged, and `ops notice` sends it again.
   */
  async changeAddress(actor: Actor, serverId: string, slug: string): Promise<MinecraftServer> {
    const before = await findServer(this.#db, serverId)
    const moved = await this.#servers.changeAddress(actor, serverId, slug)
    if (before !== null && before.slug !== moved.slug)
      await this.addressChanged(actor, serverId, before.slug).catch((error) =>
        console.error(`address notice for ${serverId} failed`, error),
      )
    return moved
  }

  /** The server now has its own address, and had `from` before: said unless its owner moved it. */
  async addressChanged(actor: Actor, serverId: string, from: string): Promise<void> {
    const server = await this.#server(serverId)
    if (!byCubepals(actor, server.ownerId)) return
    if (server.slug === from) throw new AppError('invalid_choice', `The server's address is still ${from}.`)
    await this.#send(
      server.ownerId,
      addressChanged({
        server,
        slug: from,
        from: this.#join(from),
        to: this.#join(server.slug),
        origin: this.#webOrigin,
      }),
    )
  }

  /** The server is out of Browse: said unless its owner took it out. */
  async unlisted(actor: Actor, serverId: string): Promise<void> {
    const server = await this.#server(serverId)
    if (!byCubepals(actor, server.ownerId)) return
    if ((await loadListing(this.#db, serverId))?.visibility === 'published')
      throw new AppError('invalid_choice', 'The server is still listed in Browse.')
    await this.#send(
      server.ownerId,
      unlisted({ server, join: this.#join(server.slug), origin: this.#webOrigin }),
    )
  }

  async #server(serverId: string) {
    const server = await findServer(this.#db, serverId)
    if (server === null) throw new NotFound('Server')
    return server
  }

  #join(slug: string): string {
    return formatJoinAddress(this.#addressing.primary(slug))
  }

  async #send(ownerId: string, email: Email): Promise<void> {
    const to = await emailOf(this.#db, ownerId)
    if (to !== null)
      await this.#mailer.send({
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        notice: true,
      })
  }
}

/** Someone running the platform, on a server that isn't their own. */
function byCubepals(actor: Actor, ownerId: string): boolean {
  return runsThePlatform(actor) && !(actor.kind === 'admin' && actor.userId === ownerId)
}
