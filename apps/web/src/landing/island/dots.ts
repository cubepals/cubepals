// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How big one dot of the island's print is, so a print is never scaled: a dot is two device pixels
 * where a CSS pixel is one, and three where it is more, and a picture is a whole number of dots.
 * A scaled dither shimmers (brand/README.md, "pictures").
 */

/** Device pixels to a dot, at `ratio` device pixels to a CSS pixel. */
const dotOf = (ratio: number) => (ratio >= 1.5 ? 3 : 2)

/** CSS pixels to a dot. */
export const unitOf = (ratio: number) => dotOf(ratio) / ratio

/** The largest print that fits a box `width` by `height` CSS pixels: its size in dots and in CSS pixels. */
export function fitted(width: number, height: number, ratio: number) {
  const unit = unitOf(ratio)
  const across = Math.max(1, Math.floor(width / unit))
  const down = Math.max(1, Math.floor(height / unit))
  return { across, down, width: across * unit, height: down * unit, unit }
}
