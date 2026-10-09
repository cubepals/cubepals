/**
 * One audit row about a curated release, written in the transaction that changed it.
 *
 * It doesn't decide what is audited or when: ingestion (`ingest.ts`) and an admin's moves
 * (`moves.ts`) write one beside the change each makes.
 */
import { schema, type Tx } from '@blockly/db'

export async function audit(
  tx: Tx,
  actor: string,
  action: string,
  subject: string,
  data: Record<string, unknown>,
) {
  await tx
    .insert(schema.auditLog)
    .values({ actor, action, subjectType: 'curated_release', subjectId: subject, data })
}
