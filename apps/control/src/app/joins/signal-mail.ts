// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signals a pass of the `signals` job just raised, emailed to the admin inbox where the
 * `SIGNALS` setting lists their kind under `notify`: one email a pass, whatever it raised. A
 * signal is raised once, by its key, and only what a pass wrote is sent, so each goes once; one
 * whose email failed is said in the log and stays in `ops.ts signals`.
 */
import type { Queryable } from '@blockly/db'
import { adminInbox } from '../accounts/persistence.ts'
import { type SignalLine, signalDigest } from '../emails/admins.ts'
import type { Mailer } from '../ports/platform.ts'

/** A signal as the pass wrote it. */
export interface Written {
  kind: string
  detail: Record<string, unknown>
}

/** What a signal found, in a line: its figures, and why where it says. */
function said(detail: Record<string, unknown>): string {
  const parts: string[] = []
  const { figure, limit, reasons, changed, operationKind, attempts, error, player, seconds } = detail
  if (operationKind !== undefined) parts.push(String(operationKind))
  if (player !== undefined) parts.push(`player ${String(player)}`)
  if (figure !== undefined) parts.push(limit === undefined ? `${figure}` : `${figure} (limit ${limit})`)
  if (seconds !== undefined) parts.push(`${seconds} s`)
  if (Array.isArray(reasons) && reasons.length > 0) parts.push(`because ${reasons.join(', ')}`)
  if (Array.isArray(changed) && changed.length > 0) parts.push(`changed ${changed.join(', ')}`)
  if (attempts !== undefined) parts.push(`${attempts} attempts`)
  if (typeof error === 'string' && error !== '') parts.push(`last error: ${error.slice(0, 200)}`)
  return parts.length === 0 ? 'raised' : parts.join('; ')
}

/** Emails what the setting asks of `written`; how many signals the email carried, 0 where none went. */
export async function tellSignals(
  deps: { db: Queryable; mailer: Mailer; inbox: readonly string[]; origin: string },
  notify: readonly string[] | undefined,
  written: readonly Written[],
): Promise<number> {
  const lines: SignalLine[] = written
    .filter((signal) => notify?.includes(signal.kind) === true)
    .map((signal) => ({
      kind: signal.kind,
      server: typeof signal.detail.server === 'string' ? signal.detail.server : null,
      said: said(signal.detail),
    }))
  if (lines.length === 0) return 0
  const email = signalDigest({ lines, origin: deps.origin })
  let sent = false
  for (const to of await adminInbox(deps.db, deps.inbox)) {
    try {
      await deps.mailer.send({ to, ...email })
      sent = true
    } catch (error) {
      console.error(`signals email to ${to} failed`, error)
    }
  }
  return sent ? lines.length : 0
}
