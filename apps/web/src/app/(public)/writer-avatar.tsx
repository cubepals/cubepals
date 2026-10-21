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
import Boring from 'boring-avatars'
import { minidenticon } from 'minidenticons'
import { useEffect, useState } from 'react'
import { random } from '../../ui/face'
import { COLOURS, INK, PAPER } from './avatar-colours'
import { WriterMark } from './writer-mark'

/**
 * DiceBear and its identicon style, fetched the first time an identicon is on screen and kept: most
 * of what the pictures weigh, so a page without one never loads it.
 */
let identicon: Promise<(seed: string, colour: string) => string> | undefined

/** An identicon's drawing, once DiceBear has loaded. */
export function identiconSvg(seed: string, colour: string): Promise<string> {
  identicon ??= Promise.all([import('@dicebear/core'), import('@dicebear/styles/identicon.json')]).then(
    ([{ Avatar, Style }, definition]) => {
      const style = new Style(definition.default)
      return (seed, colour) =>
        new Avatar(style, { seed, size: SIZE, rowColor: [colour], backgroundColor: [PAPER] }).toString()
    },
  )
  return identicon.then((draw) => draw(seed, colour))
}

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
      return <Identicon seed={seed} colour={first} className={className} />
    case 'minidenticon':
      // minidenticons colours a picture from a wheel of its own; it is given one of ours instead,
      // and none of its own margin, so its 5×5 cells fill the frame on whole pixels as identicon's do.
      return asImage(
        minidenticon(seed)
          .replace(/viewBox="[^"]*"/, 'viewBox="0 0 5 5"')
          .replace(/fill="[^"]*"/, `fill="${first}"`)
          .replace(/(<svg[^>]*>)/, `$1<rect width="5" height="5" fill="${PAPER}"/>`),
        className,
      )
    case 'pixel':
      // Sand twice, so the ground stays sand and ink is one small accent among the pixels.
      return (
        <span className={className}>
          <Boring
            name={seed}
            variant="pixel"
            square
            size={SIZE}
            colors={[PAPER, first, PAPER, second, INK]}
          />
        </span>
      )
    case 'bauhaus':
      // Sand first, as the ground; ink only as one colour among several, never on its own.
      return (
        <span className={className}>
          <Boring
            name={seed}
            variant="bauhaus"
            square
            size={SIZE}
            colors={[PAPER, first, second, INK, third]}
          />
        </span>
      )
  }
}

/** An identicon, drawn once DiceBear has loaded; until then, the sand it will be drawn on. */
function Identicon({ seed, colour, className }: { seed: string; colour: string; className?: string }) {
  const [drawn, setDrawn] = useState<{ key: string; svg: string } | null>(null)
  const key = `${seed}:${colour}`
  useEffect(() => {
    let current = true
    void identiconSvg(seed, colour).then((svg) => {
      if (current) setDrawn({ key, svg })
    })
    return () => {
      current = false
    }
  }, [seed, colour, key])
  return asImage(drawn?.key === key ? drawn.svg : SAND, className)
}

/** The sand alone, shown where a picture is still on its way. */
const SAND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${PAPER}"/></svg>`
