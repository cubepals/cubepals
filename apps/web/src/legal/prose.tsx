// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A policy's words on the page: its blocks, and in each sentence its links, its emphasis, the
 * operator's details and its references to other sections, each said by number and linked to it.
 * A detail not given yet is a marked placeholder, never a guess.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { OutLink } from '../ui/out-link'
import { type Piece, piecesOf, plainOf, sectionCalled, type Token } from './inline'
import styles from './legal.module.css'
import { OPERATOR, PLACEHOLDERS } from './operator'
import type { Block } from './policy'

/** `ids` are the policy's section ids in order, which its references are numbered by. */
export function Blocks({ blocks, ids }: { blocks: readonly Block[]; ids: readonly string[] }) {
  return blocks.map((block, i) => {
    const key = `${i}`
    if (typeof block === 'string')
      return (
        <p key={key}>
          <Sentence text={block} ids={ids} />
        </p>
      )
    if ('list' in block)
      return (
        <ul key={key}>
          {block.list.map((item) => (
            <li key={item}>
              <Sentence text={item} ids={ids} />
            </li>
          ))}
        </ul>
      )
    if ('steps' in block)
      return (
        <ol key={key}>
          {block.steps.map((item) => (
            <li key={item}>
              <Sentence text={item} ids={ids} />
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
                    <Sentence text={cell} ids={ids} />
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

/** One sentence, with its markup read; `ids` as for `Blocks`. */
export function Sentence({ text, ids = [] }: { text: string; ids?: readonly string[] }) {
  return piecesOf(text).map((piece, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a sentence's pieces keep their order
    <PieceOf key={i} piece={piece} ids={ids} />
  ))
}

function PieceOf({ piece, ids }: { piece: Piece; ids: readonly string[] }): ReactNode {
  switch (piece.kind) {
    case 'text':
      return piece.text
    case 'strong':
      return (
        <strong>
          <Sentence text={piece.text} ids={ids} />
        </strong>
      )
    case 'link':
      return piece.href.startsWith('/') ? (
        <Link href={piece.href}>{piece.text}</Link>
      ) : (
        <OutLink href={piece.href}>{piece.text}</OutLink>
      )
    case 'token':
      return <TokenOf token={piece.token} />
    case 'section':
      return <a href={`#${piece.id}`}>{sectionCalled(ids, piece.id)}</a>
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
