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

import {
  ADDRESS_MAX_LENGTH,
  ADDRESS_MIN_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  isGamertag,
  NAME_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
  SEED_MAX_LENGTH,
  typedAsBedrock,
} from '@blockly/contracts'
import { offensive, PICK_ANOTHER_NAME } from '@blockly/contracts/names'
import { sealProblem } from '@blockly/contracts/seal'

export type Rule = (value: string) => string | null

const blank = (value: string) => value.trim().length === 0

/** Mirrors zod's `z.email()`, which is what the API checks: something@something.something. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const email: Rule = (value) =>
  blank(value) || EMAIL.test(value.trim()) ? null : 'That doesn’t look like an email address.'

export const password: Rule = (value) =>
  blank(value) || value.length >= PASSWORD_MIN_LENGTH
    ? null
    : `A password needs at least ${PASSWORD_MIN_LENGTH} characters.`

export const serverName: Rule = (value) => {
  if (blank(value)) return null
  if (value.trim().length > NAME_MAX_LENGTH) return `A name can be up to ${NAME_MAX_LENGTH} characters.`
  return offensive(value) ? PICK_ANOTHER_NAME : sealProblem(value, 'Names')
}

/** The address people type in Minecraft: a DNS label, which is what the slug becomes. */
export const address: Rule = (value) => {
  const wanted = value.trim().toLowerCase()
  if (blank(wanted)) return null
  if (wanted.length < ADDRESS_MIN_LENGTH) return `An address needs at least ${ADDRESS_MIN_LENGTH} characters.`
  if (wanted.length > ADDRESS_MAX_LENGTH) return `An address can be up to ${ADDRESS_MAX_LENGTH} characters.`
  if (!/^[a-z0-9-]+$/.test(wanted)) return 'Addresses use letters, numbers and hyphens.'
  if (wanted.startsWith('-') || wanted.endsWith('-') || wanted.includes('--'))
    return 'Hyphens go between words, not at either end.'
  return offensive(wanted) ? PICK_ANOTHER_NAME : null
}

/** A Minecraft name, as Mojang allows them, or a Bedrock player's gamertag with a dot ahead of it. */
export const playerName: Rule = (value) => {
  const wanted = value.trim()
  if (blank(wanted)) return null
  if (typedAsBedrock(wanted) || wanted.includes(' '))
    return isGamertag(wanted) ? null : 'A gamertag is up to 15 letters, numbers or spaces, after a dot.'
  if (wanted.length < PLAYER_NAME_MIN_LENGTH || wanted.length > PLAYER_NAME_MAX_LENGTH)
    return `A Minecraft name is ${PLAYER_NAME_MIN_LENGTH} to ${PLAYER_NAME_MAX_LENGTH} characters.`
  return /^[A-Za-z0-9_]+$/.test(wanted) ? null : 'Minecraft names use letters, numbers and underscores.'
}

export const worldName: Rule = (value) =>
  blank(value) || value.trim().length <= NAME_MAX_LENGTH
    ? null
    : `A world’s name can be up to ${NAME_MAX_LENGTH} characters.`

export const seed: Rule = (value) =>
  value.trim().length <= SEED_MAX_LENGTH ? null : `A seed can be up to ${SEED_MAX_LENGTH} characters.`

export const description: Rule = (value) =>
  value.trim().length <= DESCRIPTION_MAX_LENGTH
    ? sealProblem(value, 'Descriptions')
    : `That’s longer than ${DESCRIPTION_MAX_LENGTH} characters.`

/**
 * A note left on a server's page. Unlike the fields above it is asked only as the note is sent,
 * never while it is typed, so an empty one does have something to say.
 */
export const note: Rule = (value) => {
  const wanted = value.trim()
  if (wanted.length === 0) return 'Write something first.'
  return wanted.length <= NOTE_MAX_LENGTH
    ? sealProblem(wanted, 'Notes')
    : `A note is up to ${NOTE_MAX_LENGTH} characters.`
}

/**
 * A count, where a field takes one as text rather than a stepper: the admin forms that set a
 * cap or override a plan's. Blank is the absence of an override, which those fields allow.
 */
export const wholeNumber: Rule = (value) =>
  blank(value) || /^\d{1,6}$/.test(value.trim()) ? null : 'A whole number.'
