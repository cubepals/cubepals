/**
 * The realtime endpoint's own state: the self-signed certificate browsers pin, where the
 * deployment pins one.
 */
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core'
import { ts, updatedAt } from './columns.ts'

// ─── Realtime endpoint ──────────────────────────────────────────────────────────────────────

/**
 * The realtime role's current self-signed certificate, when the deployment pins one. The api
 * role hands its hash to browsers; the two roles may be different processes.
 */
export const realtimeCertificate = pgTable(
  'realtime_certificate',
  {
    id: integer('id').primaryKey().default(1),
    sha256: text('sha256').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /**
     * In `acme` mode, the issued certificate itself, so a restart reuses it rather than asking the
     * CA again: its hostname, PEM chain, and private key sealed under the deployment's key.
     */
    hostname: text('hostname'),
    certificatePem: text('certificate_pem'),
    privateKeySealed: text('private_key_sealed'),
    issuedAt: ts('issued_at'),
    updatedAt: updatedAt(),
  },
  (t) => [check('realtime_certificate_singleton', sql`${t.id} = 1`)],
)
