/**
 * A short note on a public server's guestbook, as it is kept and shown: one line of plain text.
 * Nothing in it is markup, and nothing in it can hide or reorder what is around it.
 */

/** The most a note says, counted as a browser counts a text field (UTF-16 units). */
export const NOTE_MAX_LENGTH = 128

/**
 * Characters that show nothing but change what is around them: every control and format
 * character, which covers direction marks and overrides, zero-width spaces, tag characters and the
 * byte order mark. The zero-width joiner stays, and variation selectors aren't format characters,
 * so emoji built from several code points survive.
 */
const INVISIBLE = /(?!\u200d)[\p{Cc}\p{Cf}]/gu

/** More marks on one letter than any language stacks, which would spill over the notes around it. */
const STACKED = /(\p{M}{4})\p{M}+/gu

/**
 * A note cleaned to what is shown: normalised, on one line with single spaces, without invisible
 * characters or towers of marks, and trimmed. Refused, in one sentence, when nothing is left or it
 * is too long. Line breaks become spaces before the invisible characters go, and spaces left
 * doubled by what went are made single again.
 */
export function cleanNote(raw: string): { note: string } | { refused: string } {
  const note = raw
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(STACKED, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (note === '') return { refused: 'Write something first.' }
  if (note.length > NOTE_MAX_LENGTH) return { refused: `A note is up to ${NOTE_MAX_LENGTH} characters.` }
  return { note }
}

/**
 * What makes two notes the same one said again: the same words, whatever their case and spacing.
 */
export const sameNote = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase()
