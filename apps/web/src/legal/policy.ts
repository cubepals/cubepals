// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a policy is made of, for the pages that show one. A policy is sections of blocks; a block
 * is a paragraph, a list, numbered steps or a small table, and each sentence in one may use the
 * markup `inline.ts` reads. A section's number is its place in the policy, never typed. Not for
 * the words themselves: each policy is its own file.
 */
export type Block =
  | string
  | { list: readonly string[] }
  | { steps: readonly string[] }
  | { table: { head: readonly string[]; rows: readonly (readonly string[])[] } }

interface Section {
  /** The anchor the section is linked by: `/legal/terms#plans`. */
  id: string
  /** Its heading without a number: the page puts the number in front (`numbered`). */
  heading: string
  blocks: readonly Block[]
}

export interface Policy {
  /** Its path under /legal. */
  slug: string
  title: string
  /** One sentence for the index, the footer's title attribute and the page's description. */
  description: string
  /** The few things a player most needs to know, read before the whole of it. */
  summary: readonly string[]
  sections: readonly Section[]
}

/** A section's heading as the page shows it, numbered by its place (from 0) in its policy. */
export const numbered = (heading: string, at: number): string => `${at + 1}. ${heading}`
