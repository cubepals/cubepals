// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A note writer's picture, in the style the API kept for them, drawn here from their seed (a hash
 * of who they are), so the same writer always looks the same and nothing leaves Cubepals to draw
 * it. Five flat, square styles that sit with the site's cards: Cubepals' own mark
 * (`writer-mark.tsx`), DiceBear's identicon (CC0 1.0), Boring Avatars' pixel and bauhaus (MIT) and
 * minidenticons (MIT). All are held to the site's colours on the same sand (`avatar-colours.ts`).
 * Which style a writer gets is the API's; this only draws it.
 */

import type { AvatarView } from '@blockly/contracts'
import { Avatar, Style } from '@dicebear/core'
import identiconStyle from '@dicebear/styles/identicon.json'
import Boring from 'boring-avatars'
import { minidenticon } from 'minidenticons'
import { random } from '../../ui/face'
import { COLOURS, INK, PAPER } from './avatar-colours'
import { WriterMark } from './writer-mark'

const IDENTICON = new Style(identiconStyle)

/** Pictures are drawn at the size they are shown, so each library lays its shapes on whole pixels. */
const SIZE = 20

/**
 * Three of the site's colours for a writer, picked by their seed, so two writers in the same style
 * still differ in colour, as they do in the other styles.
 */
function colours(seed: string): [string, string, string] {
  const next = random(seed)
  const left = [...COLOURS]
  const take = () => left.splice(Math.floor(next() * left.length), 1)[0] as string
  return [take(), take(), take()]
}

/** One drawing as a picture: a library's SVG can carry ids that would clash with another's on the page. */
const asImage = (svg: string, className: string | undefined) => (
  // biome-ignore lint/performance/noImgElement: a 20px drawing made on the page; there is nothing to optimise
  <img className={className} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="" />
)

export function WriterAvatar({ avatar, className }: { avatar: AvatarView; className?: string }) {
  const { style, seed } = avatar
  const [first, second, third] = colours(seed)
  switch (style) {
    case 'mark':
      return <WriterMark seed={seed} className={className} />
    case 'identicon':
      return asImage(
        new Avatar(IDENTICON, { seed, size: SIZE, rowColor: [first], backgroundColor: [PAPER] }).toString(),
        className,
      )
    case 'minidenticon':
      // minidenticons colours a picture from a wheel of its own; it is given one of ours instead.
      return asImage(
        minidenticon(seed)
          .replace(/fill="[^"]*"/, `fill="${first}"`)
          .replace(/(<svg[^>]*>)/, `$1<rect x="-1.5" y="-1.5" width="8" height="8" fill="${PAPER}"/>`),
        className,
      )
    case 'pixel':
    case 'bauhaus':
      // Sand first, as the ground; ink only as one colour among several, never on its own.
      return (
        <span className={className}>
          <Boring
            name={seed}
            variant={style}
            square
            size={SIZE}
            colors={[PAPER, first, second, INK, third]}
          />
        </span>
      )
  }
}
