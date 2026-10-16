// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppErrorCode } from '@blockly/contracts'
import { ConsoleUnavailable } from './ports/minecraft.ts'
import { RuntimeFull } from './ports/runtime.ts'

/**
 * Refusals the application explains to people, by the codes the contracts list. Interfaces
 * translate them (tRPC error codes, edge wake denials); services never know which interface is
 * calling.
 */
export type { AppErrorCode }

export class AppError extends Error {
  readonly code: AppErrorCode

  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

/** The thing does not exist, or the actor may not know that it does. */
export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} was not found`)
    this.name = 'NotFound'
  }
}

/** A failure retrying cannot fix; the operation fails at once instead of backing off. */
export class PermanentFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PermanentFailure'
  }
}

/**
 * A failure told in owners' words that trying again may still get past: a server that didn't
 * finish loading, who can join that couldn't be restored. Unlike a `PermanentFailure`, it's retried.
 */
export class PlainFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlainFailure'
  }
}

/**
 * A failure Blockly recognised in the server's own output, carrying the one thing that fixes it
 * so the app can offer that instead of a stack trace (§15.6).
 */
export class DiagnosedFailure extends PermanentFailure {
  readonly remedy: string

  constructor(message: string, remedy: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DiagnosedFailure'
    this.remedy = remedy
  }
}

/**
 * An error's words for owners, where it has some: Blockly's own refusals and failures are written
 * for them, and a provider with no room or a console that didn't answer is told as that. What a
 * provider, the database or anything else said is not for them, and is null here; it stays on the
 * operation's record (`inFull`).
 */
export function ownersWords(error: unknown): string | null {
  if (error instanceof AppError || error instanceof PermanentFailure || error instanceof PlainFailure)
    return error.message
  if (error instanceof RuntimeFull)
    return 'There was no room for it where it runs just then. Try again in a few minutes.'
  if (error instanceof ConsoleUnavailable)
    return 'The server’s console didn’t answer just then. Try again in a moment.'
  return null
}

/** An error's own words for owners, as an aside in a sentence about it; nothing when it has none. */
export function aside(error: unknown): string {
  const said = ownersWords(error)
  return said === null ? '' : ` (${said.replace(/\.$/, '')})`
}

/** What an owner reads about an error: its own words, or whose side it was on and what to do. */
export const inPlainWords = (error: unknown): string =>
  ownersWords(error) ?? 'This one was on Cubepals’ side, not yours. Trying again usually works.'

/** Everything an error said, its causes included: for the platform's own record, never for owners. */
export function inFull(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : undefined
  return cause === undefined ? said : `${said} (${inFull(cause)})`
}
