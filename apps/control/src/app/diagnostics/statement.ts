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

/** Where a literal was, until every literal is out: a character no statement holds. */
const LITERAL = '\u0000'

/**
 * A query's literals taken out, whatever their quoting: dollar quotes (`$$…$$`, `$tag$…$tag$`;
 * a parameter like `$1` is none, as a tag can't start with a digit), escape strings (`E'…'`, where
 * a backslash escapes a quote) and plain strings (`'…'`, where `''` does). A quote left after them
 * is one this couldn't match: the text is cut there, so what follows it is never kept.
 */
function withoutLiterals(statement: string): string {
  const out = statement
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, LITERAL)
    .replace(/\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'/g, LITERAL)
    .replace(/'(?:[^']|'')*'/g, LITERAL)
  const stray = out.indexOf("'")
  return (stray === -1 ? out : `${out.slice(0, stray)}${LITERAL}`).replaceAll(LITERAL, "'?'")
}

/** Literals and lists of parameters, as what varies between runs of one query. */
function normalized(statement: string): string {
  return (
    withoutLiterals(statement.replace(/\s+/g, ' ').trim())
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
