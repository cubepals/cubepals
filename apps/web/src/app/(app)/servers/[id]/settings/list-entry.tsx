// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server as Minecraft's multiplayer list draws it, in the game's own pixels: its icon, its
 * name, the message on the lines the game breaks it into (`motdLayout`), the player count and the
 * signal bars, on the list's dark ground. Each character sits where the game's widths put it, so
 * the lines break and stop where they do in the game; what the game would leave off is drawn
 * faded and struck through below. Not for the message as words in a sentence: that is
 * `StyledMessage`.
 */
import { glyphAdvance, type MotdGlyph, motdLayout, motdText, type ServerView } from '@blockly/contracts'
import { iconSrc } from '../../../../../lib/present'

/**
 * Where `ServerSelectionList.OnlineServerEntry` draws each part, in the Java Edition 26.3 client:
 * a row 305 wide and 36 high, its content 2 in, the icon 32 square, the name at 35 across and 1
 * down, the message's lines from 12 down, 9 apart, the signal bars 10 by 8 at 15 from the right,
 * and the player count 5 left of them.
 */
const ROW = { width: 305, height: 36, inset: 2 }
const ICON = 32
const TEXT_X = ROW.inset + ICON + 3
const NAME_Y = ROW.inset + 1
const MESSAGE_Y = ROW.inset + 12
const LINE = 9
const BARS_X = ROW.width - ROW.inset - 15
/** A glyph's baseline is 7 below the top of its cell (`ascent` in the font's bitmaps). */
const ASCENT = 7

/** The game's colours for the name, the message's own grey, and the player count. */
const WHITE = '#FFFFFF'
const GREY = '#AAAAAA'
const DARK_GREY = '#555555'

/** The list's ground: dark whatever the page's theme. */
export const GROUND = '#1b1b1b'

/** The game shadows its text 1 pixel down and right, in its colour at a quarter of the light. */
const shadowOf = (colour: string) =>
  `#${[1, 3, 5]
    .map((at) =>
      Math.floor(Number.parseInt(colour.slice(at, at + 2), 16) / 4)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** The game draws obfuscated text as ever-changing letters; the preview shows some, still. */
const SCRAMBLE = 'Ξ#%&@?§¥ÆØ'
export const scrambled = (text: string) =>
  [...text].map((c, i) => (c === ' ' ? c : (SCRAMBLE[(c.charCodeAt(0) + i) % SCRAMBLE.length] ?? c))).join('')

export function ListEntry({
  view,
  motd,
  maxPlayers,
}: {
  view: ServerView
  motd: string
  maxPlayers: number
}) {
  const { lines, cut } = motdLayout(motd)
  const count = [
    { char: '0', colour: GREY },
    { char: '/', colour: DARK_GREY },
    ...[...String(maxPlayers)].map((char) => ({ char, colour: GREY })),
  ]
  const countWidth = count.reduce((width, { char }) => width + glyphAdvance(char, false), 0)
  const height = ROW.height + (cut.length > 0 ? cut.length * LINE + ROW.inset : 0)
  return (
    <svg
      viewBox={`0 0 ${ROW.width} ${height}`}
      role="img"
      aria-label={`${view.name}: ${motdText(motd)}`}
      style={{ display: 'block', width: '100%', maxWidth: ROW.width * 2, height: 'auto', background: GROUND }}
    >
      <image
        href={iconSrc(view.icon, view.ownIcon)}
        x={ROW.inset}
        y={ROW.inset}
        width={ICON}
        height={ICON}
        style={{ imageRendering: 'pixelated' }}
      />
      <Text x={TEXT_X} y={NAME_Y} glyphs={plain([...view.name].map((char) => ({ char, colour: WHITE })))} />
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are the message in order
        <Text key={i} x={TEXT_X} y={MESSAGE_Y + LINE * i} glyphs={line} />
      ))}
      <Text x={BARS_X - countWidth - 5} y={NAME_Y} glyphs={plain(count)} />
      <Bars x={BARS_X} y={ROW.inset} />
      {cut.length > 0 && (
        <g opacity={0.45}>
          {cut.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are the message in order
            <Text key={i} x={TEXT_X} y={ROW.height + LINE * i} glyphs={line} struck />
          ))}
        </g>
      )}
    </svg>
  )
}

/** Characters in one look, placed as the game's widths place them. */
function plain(chars: Array<{ char: string; colour: string }>): MotdGlyph[] {
  let x = 0
  return chars.map(({ char, colour }) => {
    const advance = glyphAdvance(char, false)
    x += advance
    return { char, colour, styles: [], x: x - advance, advance }
  })
}

/** One line of text, each character at its place, over the game's shadow of it. */
function Text({
  x,
  y,
  glyphs,
  struck = false,
}: {
  x: number
  y: number
  glyphs: MotdGlyph[]
  struck?: boolean
}) {
  const layer = (dx: number, shadow: boolean) =>
    glyphs.map((glyph, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the characters are the line in order
      <Glyph key={i} glyph={glyph} left={x + glyph.x + dx} top={y + dx} shadow={shadow} struck={struck} />
    ))
  return (
    <g
      style={{
        fontFamily: 'var(--font-pixel), var(--font-plex-mono), ui-monospace, monospace',
        fontSize: 9,
        whiteSpace: 'pre',
      }}
      shapeRendering="crispEdges"
    >
      {layer(1, true)}
      {layer(0, false)}
    </g>
  )
}

/**
 * One character as the game draws it: bold is the glyph twice, a pixel apart; underline and
 * strikethrough are one-pixel lines, 8 and 3.5 below the top of the line, from a pixel before it.
 */
function Glyph({
  glyph,
  left,
  top,
  shadow,
  struck,
}: {
  glyph: MotdGlyph
  left: number
  top: number
  shadow: boolean
  struck: boolean
}) {
  const has = (style: MotdGlyph['styles'][number]) => glyph.styles.includes(style)
  const char = has('obfuscated') ? scrambled(glyph.char) : glyph.char
  const lines = [has('underlined') ? 8 : null, has('strikethrough') || struck ? 3.5 : null]
  return (
    <g fill={shadow ? shadowOf(glyph.colour) : glyph.colour}>
      {(has('bold') ? [0, 1] : [0]).map((dx) => (
        <text key={dx} x={left + dx} y={top + ASCENT} fontStyle={has('italic') ? 'italic' : 'normal'}>
          {char}
        </text>
      ))}
      {lines.map(
        (at) =>
          at !== null && <rect key={at} x={left - 1} y={top + at} width={glyph.advance + 1} height={1} />,
      )}
    </g>
  )
}

/** Full signal: five bars a pixel wide, each a pixel taller, with a darker pixel beside each. */
function Bars({ x, y }: { x: number; y: number }) {
  return (
    <g shapeRendering="crispEdges">
      {[0, 1, 2, 3, 4].map((bar) => (
        <g key={bar}>
          <rect x={x + bar * 2} y={y + 5 - bar} width={1} height={2 + bar} fill="#00FF21" />
          <rect x={x + bar * 2 + 1} y={y + 6 - bar} width={1} height={2 + bar} fill="#00870F" />
        </g>
      ))}
    </g>
  )
}
