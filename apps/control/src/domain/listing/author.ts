// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanNote } from './note.ts'

/**
 * Who left a note, as strangers read it: "Davi H." from "Davi Hernandez", "Davi" from "Davi". Never
 * the email or the whole last name, since notes are public, and nothing when the account has no name
 * to show: none at all, only invisible characters, or one that reads as an email. The name is
 * cleaned as a note is, so it can't hide anything or carry a check mark either.
 */
export function shownName(name: string): string | null {
  const cleaned = cleanNote(name)
  if ('refused' in cleaned || cleaned.note.includes('@')) return null
  const words = cleaned.note.split(' ')
  const first = words[0] as string
  if (words.length === 1) return first
  const [initial = ''] = words.at(-1) as string
  return `${first} ${initial.toLocaleUpperCase()}.`
}
