// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What `ops.ts` and `ops-mcp.ts` check before they call the operators' API: a console command is
 * one line of plain text, as the console itself takes it, and an action that takes something away
 * from someone is named again first: a server by its name, an account by its address, the platform
 * by the word `platform`. The API checks what it is sent on its own; this stops a slip before then.
 */
import { z } from 'zod'
import { isPlainCommand } from '../../apps/control/src/minecraft/console.ts'

/** One line of plain text, as the console takes it. */
export const ConsoleCommand = z
  .string()
  .refine(isPlainCommand, 'A console command is one line of plain text, without control characters.')

/** Any other word or line an operator gives: no control characters. */
export const Line = z.string().regex(/^\P{Cc}*$/u, 'One line of plain text, without control characters.')

/** What a change to every player at once is confirmed with. */
export const PLATFORM = 'platform'

/** Whether `confirm` is the server's name exactly, as its page shows it. */
export async function namesServer(
  api: (method: 'GET', path: string) => Promise<unknown>,
  serverId: string,
  confirm: string,
): Promise<boolean> {
  const { name } = (await api('GET', `/servers/${encodeURIComponent(serverId)}`)) as { name: string }
  return confirm === name
}
