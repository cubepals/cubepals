// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player types, as plain text: a name or a seed on one line, a description in lines of
 * text. Control characters show nothing, and each place the text goes reads them its own way, so
 * the API's inputs take them out before anything else sees the text. Nothing else changes: a
 * name that is valid without them stays exactly as typed.
 */

/** Control characters and the line and paragraph separators, with the spaces around them. */
const BREAKS = /\s*[\p{Cc}\p{Zl}\p{Zp}]+\s*/gu

/** Text on one line: each run of control characters, line breaks among them, becomes one space. */
export const oneLine = (text: string): string => text.replace(BREAKS, ' ')

/** Every control character but the line break, which a description keeps between its lines. */
const INVISIBLE = /(?!\n)\p{Cc}/gu

/**
 * Text in lines: any line break, the Windows one and the separators included, becomes `\n`; a
 * tab becomes a space, and every other control character goes.
 */
export const plainLines = (text: string): string =>
  text
    .replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE, '')
