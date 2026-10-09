/**
 * The platform's audit log: who did what to which subject, and when.
 */
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_subject').on(t.subjectType, t.subjectId, t.at),
    // Rate limits count an actor's recent actions; the admin log filters by actor.
    index('audit_log_actor').on(t.actor, t.action, t.at),
    // The platform-wide log, newest first.
    index('audit_log_at').on(t.at),
  ],
)
