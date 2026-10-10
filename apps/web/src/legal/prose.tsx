// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A policy's words on the page: its blocks, and in each sentence its links, its emphasis and the
 * operator's details. A detail not given yet is a marked placeholder, never a guess.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { type Piece, piecesOf, plainOf, type Token } from './inline'
import styles from './legal.module.css'
import { OPERATOR, PLACEHOLDERS } from './operator'
import type { Block } from './policy'

export function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return blocks.map((block, i) => {
    const key = `${i}`
    if (typeof block === 'string')
      return (
        <p key={key}>
          <Sentence text={block} />
        </p>
      )
    if ('list' in block)
      return (
        <ul key={key}>
          {block.list.map((item) => (
            <li key={item}>
              <Sentence text={item} />
            </li>
          ))}
        </ul>
      )
    if ('steps' in block)
      return (
        <ol key={key}>
          {block.steps.map((item) => (
            <li key={item}>
              <Sentence text={item} />
            </li>
          ))}
        </ol>
      )
    return (
      <div key={key} className={styles.table}>
        <table>
          <thead>
            <tr>
              {block.table.head.map((cell) => (
                <th key={cell} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.table.rows.map((row) => (
              <tr key={row.join('|')}>
                {row.map((cell, c) => (
                  <td key={block.table.head[c] ?? cell} data-label={block.table.head[c]}>
                    <Sentence text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  })
}

/** One sentence, with its markup read. */
export function Sentence({ text }: { text: string }) {
  return piecesOf(text).map((piece, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a sentence's pieces keep their order
    <PieceOf key={i} piece={piece} />
  ))
}

function PieceOf({ piece }: { piece: Piece }): ReactNode {
  switch (piece.kind) {
    case 'text':
      return piece.text
    case 'strong':
      return <strong>{piece.text}</strong>
    case 'link':
      return piece.href.startsWith('/') ? (
        <Link href={piece.href}>{piece.text}</Link>
      ) : (
        <a href={piece.href} rel="noopener noreferrer">
          {piece.text}
        </a>
      )
    case 'token':
      return <TokenOf token={piece.token} />
  }
}

function TokenOf({ token }: { token: Token }): ReactNode {
  switch (token) {
    case 'brand':
    case 'domain':
    case 'playDomain':
      return OPERATOR[token]
    case 'support':
    case 'privacy':
    case 'legal': {
      const address = OPERATOR.emails[token]
      return <a href={`mailto:${address}`}>{address}</a>
    }
    case 'name':
    case 'country':
    case 'law':
    case 'emailProvider':
    case 'emailProviderWhere':
      return OPERATOR[token] ?? <Placeholder>{PLACEHOLDERS[token]}</Placeholder>
  }
}

/** A detail not given yet, marked so it can't be read as given. */
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <mark className={styles.placeholder} title="Not yet published">
      [{children}]
    </mark>
  )
}

/** A sentence as plain text, with the operator's details said as they stand (a gap in brackets). */
export const plain = (sentence: string): string =>
  plainOf(sentence, (token) => {
    if (token === 'support' || token === 'privacy' || token === 'legal') return OPERATOR.emails[token]
    if (token === 'brand' || token === 'domain' || token === 'playDomain') return OPERATOR[token]
    return OPERATOR[token] ?? `[${PLACEHOLDERS[token]}]`
  })
