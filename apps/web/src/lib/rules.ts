// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly says when what somebody typed can't work (§15.6).
 *
 * A browser already knows an email address is malformed, but it says so in a bubble that fades,
 * in a developer's words, and only when it feels like it. These are the same rules in Blockly's
 * voice, shown under the field and marked for a screen reader. Each one says what to do, not
 * which pattern failed, and each returns null when there is nothing to say — including for an
 * empty field, since "you haven't finished yet" is not an error.
 *
 * The bounds here are the ones the API enforces (`packages/contracts`), and `rules.test.ts`
 * checks they still agree, so a rule can't drift into promising something the server refuses.
 */

import { NOTE_MAX_LENGTH } from '@blockly/contracts'

export type Rule = (value: string) => string | null

const blank = (value: string) => value.trim().length === 0

/** Mirrors zod's `z.email()`, which is what the API checks: something@something.something. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const email: Rule = (value) =>
  blank(value) || EMAIL.test(value.trim()) ? null : 'That doesn’t look like an email address.'

export const password: Rule = (value) =>
  blank(value) || value.length >= 10 ? null : 'A password needs at least 10 characters.'

export const serverName: Rule = (value) =>
  blank(value) || value.trim().length <= 40 ? null : 'A name can be up to 40 characters.'

/** The address people type in Minecraft: a DNS label, which is what the slug becomes. */
export const address: Rule = (value) => {
  const wanted = value.trim().toLowerCase()
  if (blank(wanted)) return null
  if (wanted.length < 3) return 'An address needs at least 3 characters.'
  if (wanted.length > 40) return 'An address can be up to 40 characters.'
  if (!/^[a-z0-9-]+$/.test(wanted)) return 'Addresses use letters, numbers and hyphens.'
  if (wanted.startsWith('-') || wanted.endsWith('-') || wanted.includes('--'))
    return 'Hyphens go between words, not at either end.'
  return null
}

/** A Minecraft name, as Mojang allows them. */
export const playerName: Rule = (value) => {
  const wanted = value.trim()
  if (blank(wanted)) return null
  if (wanted.length < 3 || wanted.length > 16) return 'A Minecraft name is 3 to 16 characters.'
  return /^[A-Za-z0-9_]+$/.test(wanted) ? null : 'Minecraft names use letters, numbers and underscores.'
}

export const worldName: Rule = (value) =>
  blank(value) || value.trim().length <= 40 ? null : 'A world’s name can be up to 40 characters.'

export const seed: Rule = (value) => (value.trim().length <= 32 ? null : 'A seed can be up to 32 characters.')

export const description: Rule = (value) =>
  value.trim().length <= 1000 ? null : 'That’s longer than 1000 characters.'

/**
 * A note left on a server's page. Unlike the fields above it is asked only as the note is sent,
 * never while it is typed, so an empty one does have something to say.
 */
export const note: Rule = (value) => {
  const wanted = value.trim()
  if (wanted.length === 0) return 'Write something first.'
  return wanted.length <= NOTE_MAX_LENGTH ? null : `A note is up to ${NOTE_MAX_LENGTH} characters.`
}

/**
 * A count, where a field takes one as text rather than a stepper: the admin forms that set a
 * cap or override a plan's. Blank is the absence of an override, which those fields allow.
 */
export const wholeNumber: Rule = (value) =>
  blank(value) || /^\d{1,6}$/.test(value.trim()) ? null : 'A whole number.'
