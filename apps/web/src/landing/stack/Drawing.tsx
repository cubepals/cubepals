// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The stack's picture: the plates under the island's print and their names over it, in the ink
 * section's own colours, each plate drawn twice, at rest and read, so that the read one can come in
 * through the dither. Every part that moves is a group of its own, marked with what it is
 * (`data-under`, `data-over`, `data-lit` and the rest) for motion.ts to find and move. Where things
 * are comes from geometry.ts, what a plate's top shows from tops.ts.
 */
import { PixelIcon } from '../../ui/pixel-icon'
import { SIZE } from '../engine/chunk'
import { BAYER, LEVELS } from './dither'
import {
  CARD,
  CORNERS,
  FLOOR,
  NAMES,
  nameAt,
  PARTS,
  type Part,
  PLATES,
  type PlateAt,
  planeOf,
  type Stack,
  slabOf,
  TYPE,
} from './geometry'
import styles from './stack.module.css'
import { type Mark, NOTES, type Told, topMarks } from './tops'

/** A plate at rest is a drawing in faint lines on the night; read, it is a plate of paper, its sides in dither. */
const LOOKS = {
  rest: {
    lid: styles.ink,
    sides: [3, 1],
    edge: styles.faint,
    mark: styles.markFaint,
    on: styles.markMuted,
    picked: 'p2',
    track: 'p1',
    sheets: [styles.faint, styles.rule],
  },
  read: {
    lid: styles.paper,
    sides: [9, 4],
    edge: styles.edge,
    mark: styles.markInk,
    on: styles.markPaper,
    picked: null,
    track: 'i5',
    sheets: [styles.edge, styles.muted],
  },
} as const
type Look = (typeof LOOKS)[keyof typeof LOOKS]

/** A point as SVG writes it. */
const spotOf = (spot: readonly [number, number]) => `${spot[0].toFixed(2)},${spot[1].toFixed(2)}`

/** The lines on a plate's top: ink on paper when it is read, faint on the night at rest. */
const strokeOf = (look: Look) => (look === LOOKS.read ? styles.lineInk : styles.faint)

/** The dither's tiles: paper dots for the night, ink dots for paper, and white ones for the dissolves' masks. */
function Patterns({ id, unit }: { id: string; unit: number }) {
  const tile = (name: string, level: number, className?: string) => (
    <pattern key={name} id={`${id}-${name}`} width={4 * unit} height={4 * unit} patternUnits="userSpaceOnUse">
      {BAYER.map((order, i) =>
        order < level ? (
          <rect
            key={order}
            className={className}
            fill={className ? undefined : '#fff'}
            x={(i % 4) * unit}
            y={Math.floor(i / 4) * unit}
            width={unit}
            height={unit}
          />
        ) : null,
      )}
    </pattern>
  )
  return (
    <defs>
      {[1, 2, 3, 4, 9].map((level) => tile(`p${level}`, level, styles.paper))}
      {tile('i5', 5, styles.ink)}
      {Array.from({ length: LEVELS + 1 }, (_, level) => tile(`m${level}`, level))}
      {PLATES.map(({ part }) => (
        <mask
          key={part}
          id={`${id}-mask-${part}`}
          maskUnits="userSpaceOnUse"
          x={-2000}
          y={-2000}
          width={6000}
          height={6000}
        >
          <rect data-mask={part} x={-2000} y={-2000} width={6000} height={6000} fill={`url(#${id}-m0)`} />
        </mask>
      ))}
    </defs>
  )
}

/** A plate's two sides and its lid, in a look. */
function Slab({
  stack,
  top,
  bottom,
  look,
  id,
  box,
}: {
  stack: Stack
  top: number
  bottom: number
  look: Look
  id: string
  box?: readonly [number, number, number, number]
}) {
  const faces = slabOf(stack, top, bottom, box)
  return (
    <>
      {[faces.left, faces.right].map((points, side) => (
        <g key={points}>
          <polygon className={styles.ink} points={points} />
          <polygon fill={`url(#${id}-p${look.sides[side]})`} points={points} />
          <polygon className={look.edge} fill="none" points={points} />
        </g>
      ))}
      <polygon className={`${look.lid} ${look.edge}`} points={faces.lid} />
    </>
  )
}

type Drawn<M> = { stack: Stack; y: number; mark: M; look: Look; id: string }

/** Words or an icon on a plate's top, laid on it. */
function Laid({ stack, y, mark, look }: Drawn<Extract<Mark, { kind: 'words' | 'icon' }>>) {
  return (
    <g transform={planeOf(stack, y, mark.u, mark.v)} className={mark.on ? look.on : look.mark}>
      {mark.kind === 'icon' ? (
        <PixelIcon name={mark.name} size={mark.size} />
      ) : (
        <text
          className={styles.words}
          fontSize={mark.size}
          textLength={mark.fit}
          lengthAdjust={mark.fit ? 'spacingAndGlyphs' : undefined}
        >
          {mark.text}
        </text>
      )}
    </g>
  )
}

/** A box on a plate's top: its outline, and its fill as what was picked or as a track. */
function Box({ stack, y, mark, look, id }: Drawn<Extract<Mark, { kind: 'box' }>>) {
  const [u0, v0, u1, v1] = mark.at
  const corners = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ] as const
  const points = corners.map(([u, v]) => spotOf(stack.at([u, y, v]))).join(' ')
  const tiles = { none: 'none', picked: look.picked, track: look.track } as const
  const tile = tiles[mark.fill]
  const solid = tile === null
  const outlined = mark.outline !== 'none'
  return (
    <polygon
      points={points}
      className={`${solid ? styles.ink : ''} ${outlined ? strokeOf(look) : ''}`}
      fill={solid ? undefined : tile === 'none' ? 'none' : `url(#${id}-${tile})`}
      stroke={outlined ? undefined : 'none'}
      strokeDasharray={mark.outline === 'dashed' ? '2 2' : undefined}
    />
  )
}

/** One mark on a plate's top, in a look. */
function TopMark(props: Drawn<Mark>) {
  const { stack, y, mark, look } = props
  if (mark.kind === 'words' || mark.kind === 'icon') return <Laid {...props} mark={mark} />
  if (mark.kind === 'box') return <Box {...props} mark={mark} />
  const [a, b] = [stack.at([mark.at[0], y, mark.at[1]]), stack.at([mark.at[2], y, mark.at[3]])]
  return <line className={strokeOf(look)} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
}

/** What tells two marks on a top apart: what they are and where. */
const keyOf = (mark: Mark) =>
  mark.kind === 'box' || mark.kind === 'tick'
    ? `${mark.kind}:${mark.at.join()}`
    : `${mark.kind}:${mark.kind === 'words' ? mark.text : mark.name}:${mark.u}:${mark.v}`

/** A plate in one look: its body (the backups' a stack of sheets) and what its top shows. */
function Plate({
  stack,
  plate,
  look,
  id,
  told,
}: {
  stack: Stack
  plate: PlateAt
  look: Look
  id: string
  told: Told
}) {
  const sheets = plate.part === 'backups' ? told.kept : 0
  const step = (plate.top - plate.bottom) / Math.max(1, sheets)
  return (
    <>
      {Array.from({ length: Math.max(0, sheets - 1) }, (_, k) => {
        const deep = sheets - 1 - k
        const t = plate.top - deep * step
        const edge = [stack.at([0, t, SIZE]), stack.at([SIZE, t, SIZE]), stack.at([SIZE, t, 0])]
        return (
          <polyline
            key={deep}
            className={look.sheets[deep < sheets / 2 ? 0 : 1]}
            fill="none"
            points={edge.map((p) => p.map((n) => n.toFixed(2)).join(',')).join(' ')}
          />
        )
      })}
      <Slab
        stack={stack}
        top={plate.top}
        bottom={sheets ? plate.top - step * 0.5 : plate.bottom}
        look={look}
        id={id}
      />
      {topMarks(plate.part, told).map((mark) => (
        <TopMark key={keyOf(mark)} stack={stack} y={plate.top} mark={mark} look={look} id={id} />
      ))}
    </>
  )
}

/** The players at the door, on its floor: each on a card, with their way to its corner and what they play on. */
function Players({ stack, id }: { stack: Stack; id: string }) {
  return (
    <g data-players className={styles.players}>
      {stack.players.map((player) => {
        const [half, across] = player.long === 'x' ? [CARD.long, CARD.short] : [CARD.short, CARD.long]
        const [x, z] = player.at
        const way = player.trace
          .map(([u, v]) =>
            stack
              .at([u, FLOOR, v])
              .map((n) => n.toFixed(2))
              .join(','),
          )
          .join(' ')
        const left = stack.at([x - half, FLOOR + CARD.high, z + across])
        const middle = stack.at([x, FLOOR, z])
        return (
          <g key={player.name}>
            <polyline className={styles.trace} points={way} />
            <Slab
              stack={stack}
              top={FLOOR + CARD.high}
              bottom={FLOOR}
              look={{ ...LOOKS.rest, edge: styles.muted }}
              id={id}
              box={[x - half, z - across, x + half, z + across]}
            />
            <g transform={planeOf(stack, FLOOR + CARD.high, x - 0.75, z - 0.75)} className={styles.markPaper}>
              <PixelIcon name="friends" size={1.5} />
            </g>
            {player.label.map((line, k) => (
              <text
                key={line}
                className={k ? styles.labelNote : styles.label}
                x={left[0] - 10}
                y={middle[1] - 3 + k * 15}
                textAnchor="end"
              >
                {line}
              </text>
            ))}
          </g>
        )
      })}
    </g>
  )
}

/** Each part's name at its right-hand corner, as a drawing numbers its parts, and what its top shows under it. */
function Names({ stack }: { stack: Stack }) {
  return (
    <>
      {PARTS.map((part: Part, index) => {
        const [x, y] = nameAt(stack.at, index)
        return (
          <g key={part} data-over={index}>
            {stack.named ? (
              <g data-name={part} className={styles.name}>
                <line className={styles.edge} x1={x + 4} y1={y} x2={x + TYPE.off - 6} y2={y} />
                <text className={styles.nameText} x={x + TYPE.off} y={y + 4}>
                  {NAMES[part]}
                </text>
                <text className={styles.note} x={x + TYPE.off} y={y + 4 + TYPE.line}>
                  {NOTES[part]}
                </text>
              </g>
            ) : null}
          </g>
        )
      })}
    </>
  )
}

/** The rails: each corner carried down from one part to the next, dashed, redrawn as the parts move. */
function Rails() {
  return (
    <g className={styles.rails}>
      {PARTS.slice(1).flatMap((part) =>
        CORNERS.map((corner, c) => (
          <line key={`${part}-${corner.join()}`} data-rail={PARTS.indexOf(part)} data-corner={c} />
        )),
      )}
    </g>
  )
}

export function Drawing({
  stack,
  told,
  id,
  prints,
}: {
  stack: Stack
  told: Told
  id: string
  prints: { leave: string; join: string }
}) {
  const placed = {
    left: stack.print.x,
    top: stack.print.y,
    width: stack.print.width,
    height: stack.print.height,
  }
  return (
    <div data-pan className={styles.drawing} style={{ width: stack.width, height: stack.height }}>
      <svg className={styles.svg} width={stack.width} height={stack.height} aria-hidden>
        <Patterns id={id} unit={stack.unit} />
        <Rails />
        {[...PLATES].reverse().map((plate) => (
          <g key={plate.part} data-under={plate.index}>
            {plate.part === 'door' && stack.players.length ? <Players stack={stack} id={id} /> : null}
            <Plate stack={stack} plate={plate} look={LOOKS.rest} id={id} told={told} />
            <g data-lit={plate.part} style={{ visibility: 'hidden' }}>
              <Plate stack={stack} plate={plate} look={LOOKS.read} id={id} told={told} />
            </g>
          </g>
        ))}
      </svg>
      {(['shade', 'leave', 'join'] as const).map((which) => (
        // biome-ignore lint/performance/noImgElement: a print shown dot for dot, at its own size.
        <img
          key={which}
          data-print={which}
          className={`${styles.print} ${which === 'shade' ? styles.shade : ''}`}
          src={which === 'join' ? prints.join : prints.leave}
          style={{ ...placed, visibility: which === 'join' ? 'hidden' : undefined }}
          width={Math.round(stack.print.width)}
          height={Math.round(stack.print.height)}
          alt=""
          decoding="async"
        />
      ))}
      <svg className={styles.svg} width={stack.width} height={stack.height} aria-hidden>
        <Names stack={stack} />
        {(['java', 'bedrock', 'up'] as const).map((way) => (
          <polyline key={way} data-way={way} className={styles.way} points="" />
        ))}
        {(['java', 'bedrock'] as const).map((dot) => (
          <rect key={dot} data-dot={dot} className={styles.dot} x={-4} y={-4} width={8} height={8} />
        ))}
      </svg>
    </div>
  )
}
