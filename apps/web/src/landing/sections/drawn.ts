// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The server the landing's drawings show, the same in each of them: the ways to play the first
 * step offers, its address, and one example day of its hours. Not a measurement of any server.
 */
import { TEMPLATE_CARDS } from '@blockly/contracts'
import { OPERATOR } from '../../legal/operator'

/** The ways to play the drawings show, of the create page's own: the short names, survival first. */
const SHOWN_KEYS = ['survival', 'creative', 'hardcore', 'skyblock', 'oneblock', 'lifesteal']
export const SHOWN = TEMPLATE_CARDS.filter((way) => SHOWN_KEYS.includes(way.key))

/** The drawn server's address: one Cubepals keeps, so typing it leads somewhere good. */
export const ADDRESS = `sunset-valley.${OPERATOR.playDomain}`

/**
 * One example day of a server, in the hours of a clock: when it was on, and when it slept. Not a
 * measurement: the shape of an evening's play, with the quarter of an hour it stays up after.
 */
export const DAY = [
  { from: 17.5, to: 19.25, on: true },
  { from: 20.5, to: 23.25, on: true },
] as const

/** The hours the example day ran. */
export const hoursOn = DAY.reduce((sum, part) => sum + (part.to - part.from), 0)
