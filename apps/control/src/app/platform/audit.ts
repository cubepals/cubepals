import type { AuditEntryView, AuditPage } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import type { Actor } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { namesFor, searchAudit, usersByEmail } from './persistence.ts'

const PAGE = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The platform's audit log for admins: everything, newest first, narrowed by what or who. */
export class AuditQueries {
  readonly #db: Db

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  async search(
    actor: Actor,
    query: { action: string; who: string; subject: string; cursor?: string | null | undefined },
  ): Promise<AuditPage> {
    if (actor.kind !== 'admin') throw new NotFound('Audit log')
    const rows = await searchAudit(this.#db, {
      action: query.action || null,
      actors: query.who ? await this.#actors(query.who) : null,
      subjectId: query.subject || null,
      after: cursorOf(query.cursor ?? null),
      limit: PAGE + 1,
    })
    const page = rows.slice(0, PAGE)
    const people = new Set<string>()
    const servers = new Set<string>()
    for (const row of page) {
      const person = personOf(row.actor)
      if (person) people.add(person)
      if (row.subjectType === 'account') people.add(row.subjectId)
      if (row.subjectType === 'server') servers.add(row.subjectId)
    }
    const names = await namesFor(this.#db, { users: [...people], servers: [...servers] })
    const entries: AuditEntryView[] = page.map((row) => {
      const person = personOf(row.actor)
      return {
        id: row.id,
        at: row.at.toISOString(),
        actor: row.actor,
        actorEmail: person ? (names.users.get(person) ?? null) : null,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        subjectName:
          row.subjectType === 'account'
            ? (names.users.get(row.subjectId) ?? null)
            : row.subjectType === 'server'
              ? (names.servers.get(row.subjectId) ?? null)
              : null,
        data: row.data,
      }
    })
    const last = page.at(-1)
    return {
      entries,
      next: rows.length > PAGE && last ? `${last.at.toISOString()}|${last.id}` : null,
    }
  }

  /** An actor as the log writes it (`system:billing`), or a person by email or id, in either role. */
  async #actors(who: string): Promise<string[]> {
    if (who.includes(':')) return [who]
    const ids = who.includes('@') ? await usersByEmail(this.#db, who) : [who]
    return ids.flatMap((id) => [`user:${id}`, `admin:${id}`])
  }
}

const personOf = (actor: string): string | null => {
  const [kind, id] = actor.split(':', 2)
  return (kind === 'user' || kind === 'admin') && id ? id : null
}

function cursorOf(after: string | null): { at: Date; id: string } | null {
  if (after === null) return null
  const [at, id] = after.split('|')
  const date = new Date(at ?? '')
  return id && UUID.test(id) && !Number.isNaN(date.getTime()) ? { at: date, id } : null
}
