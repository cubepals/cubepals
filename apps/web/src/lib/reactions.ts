import type { ReactionsView } from '@blockly/contracts'

/**
 * A server's stars with the reader's own set on or off, as the page shows it before the API
 * answers. The API sets a star rather than toggling it, and so does this: asking for the state it
 * is already in changes nothing, so a double click can't count twice, and a count never drops
 * below none.
 */
export const starred = (view: ReactionsView, on: boolean): ReactionsView =>
  view.starred === on ? view : { ...view, starred: on, stars: Math.max(0, view.stars + (on ? 1 : -1)) }

/** A server's reactions with the number of notes the API last gave, unchanged when it's the same. */
export const noted = (view: ReactionsView, total: number): ReactionsView =>
  view.notes === total ? view : { ...view, notes: total }

/** A count beside an icon, short enough for a card: 12, 940, 1.2K. */
export const shortCount = (count: number): string => SHORT.format(count)

const SHORT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
