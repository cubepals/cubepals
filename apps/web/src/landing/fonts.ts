import { Geologica, Instrument_Serif, Pixelify_Sans } from 'next/font/google'
import localFont from 'next/font/local'

/**
 * The landing page's faces of its own (the product's Figtree and Plex Mono come from the root
 * layout). Geologica carries a sharpness axis: turned up, its corners are cut square, like blocks.
 * Pixelify Sans is the game's voice: the server list, the depth gauge. Instrument Serif's italic is
 * for the asides only, a note in the margin that never competes with what it qualifies.
 *
 * Pixelify's digits are its weak point: at these sizes a 5 reads as an S and a 6 as a G. So the
 * digits, and only the digits, are set in Press Start 2P (type/press-start-2p.woff2, under the
 * Open Font License beside it), sized to stand as tall as Pixelify's capitals. Every letter is
 * still Pixelify.
 */
export const display = Geologica({
  subsets: ['latin'],
  axes: ['SHRP'],
  variable: '--font-geologica',
  display: 'swap',
})

export const aside = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
  variable: '--font-aside',
  display: 'swap',
})

export const pixel = Pixelify_Sans({
  subsets: ['latin'],
  variable: '--font-pixel',
  display: 'swap',
})

export const digits = localFont({
  src: './type/press-start-2p.woff2',
  variable: '--font-digits',
  display: 'swap',
  // No stand-in face while it loads: a stand-in would cover every character, and the letters
  // would be taken from it instead of from Pixelify.
  adjustFontFallback: false,
  declarations: [
    { prop: 'unicode-range', value: 'U+0030-0039' },
    { prop: 'size-adjust', value: '62%' },
  ],
})
