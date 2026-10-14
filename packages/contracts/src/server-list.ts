// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Minecraft's multiplayer list shows of a server, as both the control plane and the pages
 * read it: the owner's own picture, and the formatting codes of the message under the name. The
 * fixed icons are `SERVER_ICONS`, in server.ts; the message's length is the settings' bound.
 */

/** The picture Minecraft's list wants: a PNG this many pixels square. */
export const OWN_ICON_SIZE = 64

/**
 * The most a picture may weigh as it is sent, once the page has made it 64 square. A 64 square
 * PNG with every pixel different stays under a quarter of this; anything heavier isn't one.
 */
export const OWN_ICON_MAX_BYTES = 64 * 1024

/** Where pages fetch a server's own picture: named by its bytes, so a new one is a new address. */
export const ownIconPath = (serverId: string, sha256: string): string =>
  `/api/public/icons/${serverId}/${sha256}.png`

/**
 * Minecraft's formatting codes, by the character after the section sign, with each colour as the
 * game draws it: https://minecraft.wiki/w/Formatting_codes (Java Edition).
 */
export const MOTD_COLOURS: Readonly<Record<string, string>> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
}

/** The styles, from the same page: obfuscated, bold, strikethrough, underlined, italic, reset. */
const MOTD_STYLES = { k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' } as const
type MotdStyle = (typeof MOTD_STYLES)[keyof typeof MOTD_STYLES]

/** The colour the multiplayer list draws a message in where it sets none: 0x808080. */
export const MOTD_DEFAULT_COLOUR = '#808080'

/**
 * A code as people type it, with `&` as most hosts and plugins take it, or with the section sign
 * the game itself reads. Any other `&` is just an ampersand.
 */
const CODE = /[&§]([0-9a-fk-or])/gi

/** The message as the game reads it: each `&` code becomes the section sign's. */
export const motdForGame = (motd: string): string => motd.replace(CODE, (_, code: string) => `§${code}`)

/** What the list shows of the message, without its codes: what its length is counted in. */
export const motdText = (motd: string): string => motd.replace(CODE, '')

/** A stretch of the message drawn the same way. */
export interface MotdRun {
  text: string
  colour: string
  styles: MotdStyle[]
}

/**
 * The message as the list draws it, stretch by stretch. As in the game, a colour clears the
 * styles before it, and `r` clears everything.
 */
export function motdRuns(motd: string): MotdRun[] {
  const runs: MotdRun[] = []
  let colour = MOTD_DEFAULT_COLOUR
  let styles: MotdStyle[] = []
  let at = 0
  const push = (text: string) => {
    if (text.length === 0) return
    const last = runs.at(-1)
    if (last !== undefined && last.colour === colour && last.styles.join() === styles.join())
      last.text += text
    else runs.push({ text, colour, styles })
  }
  for (const match of motd.matchAll(CODE)) {
    push(motd.slice(at, match.index))
    at = match.index + match[0].length
    const code = (match[1] ?? '').toLowerCase()
    const named = MOTD_COLOURS[code]
    if (named !== undefined) {
      colour = named
      styles = []
    } else if (code === 'r') {
      colour = MOTD_DEFAULT_COLOUR
      styles = []
    } else {
      const style = MOTD_STYLES[code as keyof typeof MOTD_STYLES]
      if (!styles.includes(style)) styles = [...styles, style]
    }
  }
  push(motd.slice(at))
  return runs
}
