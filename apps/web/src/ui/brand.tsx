// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' mark and lockup, drawn rather than set in type, so every place the product says its
 * own name says it the same way. The shapes and the proportions come from `brand/README.md`:
 * four shapes of equal optical weight, the mark at 85% of the word, a gap of 14 to the word's 66,
 * tracking −0.070em, and the mark nudged a pixel down so the two sit level.
 *
 * Both take their colour from the text around them (`currentColor`), which is the only way the
 * one mark can be ink on paper in the pages and paper on ink in the app's own navigation without
 * a second file. Nothing here recolours or reshapes it.
 */

/** Where Cubepals' code is: it is open source, and the pages say so. */
export const SOURCE_URL = 'https://github.com/cubepals/cubepals'

/** The mark alone. Give it a label where it stands for the name; leave it out where the word is beside it. */
export function Mark({ className, label }: { className?: string; label?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: titled below where it carries the name, aria-hidden where the word is beside it
    <svg
      viewBox="-1.39 -1.39 602.78 602.78"
      fill="currentColor"
      className={className}
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img' })}
    >
      {/* Titled where the mark stands for the name; silent where the word is already beside it. */}
      {label === undefined ? null : <title>{label}</title>}
      <rect x="15.84" y="15.84" width="268.33" height="268.33" />
      <circle cx="450" cy="150" r="151.39" />
      <circle cx="150" cy="450" r="151.39" />
      <path d="M301.35 301.35C421.91 301.35 406.36 409.12 462.77 409.12H557.51A41.14 41.91 0 0 1 598.65 451.03V598.65H301.35Z" />
    </svg>
  )
}

/**
 * The mark and the word together: the primary lockup. The word is set lowercase, as it is drawn
 * in `brand/lockup-horizontal.svg`, in Figtree 700 whatever the page is set in: the product's
 * type is Geologica, and the wordmark is not the product's type. The name is still Cubepals
 * wherever the product says it in a sentence, and that is what a screen reader is given. It
 * sizes itself from the font size it inherits, so a caller sets the size the way it sets any
 * other text.
 */
export function Lockup({ className }: { className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.212em' }}>
      {/* 56 to the word's 66, and down a pixel at that size: the sizing lives in `.bk-mark`. */}
      <Mark className="bk-mark" />
      {/* The word is the brand's own drawing, so it keeps its face whatever the page around it is set in. */}
      <span
        style={{
          fontFamily: 'var(--font-figtree), sans-serif',
          fontVariationSettings: 'normal',
          fontWeight: 700,
          letterSpacing: '-0.07em',
        }}
      >
        cubepals
      </span>
    </span>
  )
}
