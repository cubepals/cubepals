// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A query's shape: its text with what varies between runs of the same query taken out (the
 * number of values in a list, literals, comments, spacing), and a short name for that shape, so every run
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

const word = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c)

/** Where a string that opened before `from` ends, `''` doubling a quote, and with `backslash` a backslash escaping one. */
function endOfString(sql: string, from: number, backslash: boolean): number {
  for (let i = from; i < sql.length; i++) {
    if (backslash && sql[i] === '\\') i++
    else if (sql[i] === "'") {
      if (sql[i + 1] !== "'") return i + 1
      i++
    }
  }
  return sql.length
}

/** Where a block comment that opened before `from` ends: Postgres nests them. */
function endOfComment(sql: string, from: number): number {
  let depth = 1
  for (let i = from; i < sql.length; i++) {
    if (sql.startsWith('/*', i)) {
      depth++
      i++
    } else if (sql.startsWith('*/', i)) {
      depth--
      i++
      if (depth === 0) return i + 1
    }
  }
  return sql.length
}

/** A token read at a place in a statement: where it ends, and what stands for it. */
type Read = { to: number; text: string } | null
type Reader = (sql: string, at: number) => Read

const comments: Reader = (sql, at) => {
  if (sql.startsWith('--', at)) {
    const line = sql.indexOf('\n', at)
    return { to: line === -1 ? sql.length : line, text: ' ' }
  }
  return sql.startsWith('/*', at) ? { to: endOfComment(sql, at + 2), text: ' ' } : null
}

/** A quoted name stays as it is, `""` doubling a quote in it. */
const quotedName: Reader = (sql, at) => {
  if (sql[at] !== '"') return null
  let close = sql.indexOf('"', at + 1)
  while (close !== -1 && sql[close + 1] === '"') close = sql.indexOf('"', close + 2)
  const to = close === -1 ? sql.length : close + 1
  return { to, text: sql.slice(at, to) }
}

const strings: Reader = (sql, at) => {
  if (sql[at] === "'") return { to: endOfString(sql, at + 1, false), text: "'?'" }
  const escaped = (sql[at] === 'E' || sql[at] === 'e') && sql[at + 1] === "'" && !word(sql[at - 1])
  return escaped ? { to: endOfString(sql, at + 2, true), text: "'?'" } : null
}

const dollarQuotes: Reader = (sql, at) => {
  if (sql[at] !== '$' || word(sql[at - 1])) return null
  const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(at, at + 64))?.[0]
  if (tag === undefined) return null
  const close = sql.indexOf(tag, at + tag.length)
  return { to: close === -1 ? sql.length : close + tag.length, text: "'?'" }
}

const READERS = [comments, quotedName, strings, dollarQuotes]

/**
 * A statement read as Postgres reads it, with its comments dropped and each literal one `'?'`:
 * plain strings (`''` doubles a quote), escape strings (`E'…'`, where a backslash escapes one) and
 * dollar quotes (`$$…$$`, `$tag$…$tag$`; a parameter like `$1` is none, as a tag can't start with
 * a digit). A quoted name stays as it is. Whatever is never closed runs to the end, so nothing
 * after an opening quote is ever kept.
 */
function withoutLiterals(sql: string): string {
  let out = ''
  for (let at = 0; at < sql.length; ) {
    let read: Read = null
    for (const reader of READERS) read ??= reader(sql, at)
    out += read?.text ?? sql[at]
    at = read?.to ?? at + 1
  }
  return out
}

/** Comments, literals, spacing and lists of parameters: what varies between runs of one query. */
function normalized(statement: string): string {
  return (
    withoutLiterals(statement)
      .replace(/\s+/g, ' ')
      .trim()
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
