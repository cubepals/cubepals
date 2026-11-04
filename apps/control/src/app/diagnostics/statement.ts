// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A query's shape: its text with what varies between runs of the same query taken out (the
 * number of values in a list, literals, spacing), and a short name for that shape, so every run
 * of one query in the code is counted as one however its values differ. The text is the
 * statement as the code wrote it, with its parameters as `$1`, `$2`: the values never reach it.
 */
import { createHash } from 'node:crypto'

/** The most of a statement's text a record keeps. */
export const STATEMENT_CHARS = 2000

export interface Shape {
  /** `q:` and 12 hex characters of a hash of `text`. */
  name: string
  /** The opening word, upper-cased (`SELECT`, `INSERT`, `WITH`, …). */
  operation: string
  /** The statement with what varies taken out, at most `STATEMENT_CHARS`. */
  text: string
}

/** Literals and lists of parameters, as what varies between runs of one query. */
function normalized(statement: string): string {
  return (
    statement
      .replace(/\s+/g, ' ')
      .trim()
      // A quoted literal, which a query built by hand may carry: never kept.
      .replace(/'(?:[^']|'')*'/g, "'?'")
      // `in ($1, $2, $3)` and `values ($1, $2), ($3, $4)` are one query whatever their length.
      .replace(/\(\s*\$\d+(?:\s*,\s*\$\d+)*\s*\)(?:\s*,\s*\(\s*\$\d+(?:\s*,\s*\$\d+)*\s*\))*/g, '($n)')
      .replace(/\$\d+/g, '$n')
      .replace(/\b\d+(?:\.\d+)?\b/g, '?')
  )
}

/** The shape of `statement`; null for one with no text, such as a cursor's. */
export function shapeOf(statement: unknown): Shape | null {
  if (typeof statement !== 'string' || statement.trim() === '') return null
  const text = normalized(statement)
  const name = `q:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
  const operation = /^([a-z]+)/i.exec(text)?.[1]?.toUpperCase() ?? '_OTHER'
  return { name, operation, text: text.slice(0, STATEMENT_CHARS) }
}
