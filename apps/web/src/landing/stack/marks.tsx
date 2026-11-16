// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The marks the stack draws for who plays. A player's card shows which game it is: the Java coffee
 * cup on Java's, and the side of a grass block on Bedrock's, its grass dripping over a few dots of
 * dirt. The cup is the cup and steam of Oracle's Java logo, as Oracle publishes it, without its
 * wordmark, which can't be read at a card's size. The door shows each friend it let in by the
 * stand-in face the players page gives their name (`ui/face.tsx`). Each is drawn flat in the
 * drawing's one ink (`currentColor`). Not where a mark stands, which is geometry.ts and tops.ts.
 */
import { faceLetters } from '../../ui/face'

/** The Java logo's cup and steam, in its own coordinates. */
const CUP = [
  'M102.681,291.324c0,0-14.178,8.245,10.09,11.035c29.4,3.354,44.426,2.873,76.825-3.259c0,0,8.518,5.341,20.414,9.967C137.38,340.195,45.634,307.264,102.681,291.324',
  'M93.806,250.704c0,0-15.902,11.771,8.384,14.283c31.406,3.24,56.208,3.505,99.125-4.759c0,0,5.936,6.018,15.27,9.309C128.771,295.215,30.962,271.562,93.806,250.704',
  'M168.625,181.799c17.896,20.604-4.702,39.145-4.702,39.145s45.441-23.458,24.572-52.833c-19.491-27.394-34.438-41.005,46.479-87.934C234.974,80.177,107.961,111.899,168.625,181.799',
  'M264.684,321.369c0,0,10.492,8.645-11.555,15.333c-41.923,12.7-174.488,16.535-211.314,0.506c-13.238-5.759,11.587-13.751,19.396-15.428c8.144-1.766,12.798-1.437,12.798-1.437c-14.722-10.371-95.157,20.364-40.857,29.166C181.236,373.524,303.095,338.695,264.684,321.369',
  'M109.499,208.617c0,0-67.431,16.016-23.879,21.832c18.389,2.462,55.047,1.905,89.193-0.956c27.906-2.354,55.927-7.359,55.927-7.359s-9.84,4.214-16.959,9.075c-68.475,18.009-200.756,9.631-162.674-8.79C83.313,206.851,109.499,208.617,109.499,208.617',
  'M230.462,276.231c69.608-36.171,37.424-70.931,14.96-66.248c-5.506,1.146-7.961,2.139-7.961,2.139s2.044-3.202,5.948-4.588c44.441-15.624,78.619,46.081-14.346,70.52C229.063,278.055,230.14,277.092,230.462,276.231',
  'M188.495,4.399c0,0,38.55,38.563-36.563,97.862c-60.233,47.568-13.735,74.69-0.025,105.678c-35.159-31.722-60.961-59.647-43.651-85.637C133.663,84.151,204.049,65.654,188.495,4.399',
  'M116.339,374.246c66.815,4.277,169.417-2.373,171.847-33.988c0,0-4.671,11.985-55.219,21.503c-57.028,10.732-127.364,9.479-169.081,2.601C63.887,364.361,72.426,371.43,116.339,374.246',
].join('')

/** A card's mark, `size` blocks wide and tall, drawn from its top-left corner. */
export function CardMark({ game, size }: { game: 'java' | 'bedrock'; size: number }) {
  if (game === 'bedrock') return <GrassFace size={size} />
  return (
    <svg viewBox="14 0 290 380" width={size} height={size} fill="currentColor" aria-hidden>
      <path d={CUP} />
    </svg>
  )
}

/** The side of a grass block, in a 100-unit square: its edge, the grass line, and four dots of dirt. */
function GrassFace({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="currentColor" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth={5}>
        <rect x={14} y={14} width={72} height={72} />
        <path d="M14 34H26V44H36V34H50V48H62V34H72V42H86" />
      </g>
      <rect x={28} y={60} width={6} height={6} />
      <rect x={58} y={56} width={6} height={6} />
      <rect x={44} y={72} width={6} height={6} />
      <rect x={70} y={70} width={6} height={6} />
    </svg>
  )
}

/** The letters of a face (`ui/face.tsx`) that are inked: hair, headwear, eyes and mouth. */
const INKED = new Set(['H', 'h', 'A', 'a', 'E', 'M'])

/** A friend's face, `size` blocks wide and tall, drawn from its top-left corner. */
export function FaceMark({ name, size }: { name: string; size: number }) {
  const inked: string[] = []
  faceLetters(name).forEach((row, y) => {
    ;[...row].forEach((letter, x) => {
      if (INKED.has(letter)) inked.push(`M${x} ${y}h1v1h-1z`)
    })
  })
  return (
    <svg
      viewBox="0 0 8 8"
      width={size}
      height={size}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d={inked.join('')} />
    </svg>
  )
}
