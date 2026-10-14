// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A picture the owner chose, made into what Minecraft's server list shows: the largest square from
 * its centre, drawn 64 pixels square as a PNG. The browser reads every common picture (a GIF gives
 * its first frame), so nothing about the file is asked of the owner; the control plane draws it
 * again from its pixels before keeping it.
 */
import { OWN_ICON_SIZE } from '@blockly/contracts'

/** The most a picked file may weigh before it is read: past any photo a phone takes. */
const PICKED_MAX_BYTES = 50 * 1024 * 1024

/** The largest square from the centre of a picture. */
export function centreSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height)
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side }
}

/** The picture as the page shows it straight away, and as a save sends it. */
export interface OwnIconPicked {
  src: string
  base64: string
}

/** Refused with words for the owner: a file the browser can't read as a picture, or one too big. */
export async function squareIcon(file: File): Promise<OwnIconPicked> {
  if (file.size > PICKED_MAX_BYTES) throw new Error('That picture is too large. Try a smaller one.')
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file isn’t a picture Cubepals can read. Try another.')
  })
  const { x, y, side } = centreSquare(bitmap.width, bitmap.height)
  // Halved a step at a time, so a big photo shrinks smoothly rather than in one jagged jump.
  let canvas = draw(side, (context, size) => context.drawImage(bitmap, x, y, side, side, 0, 0, size, size))
  bitmap.close()
  while (canvas.width > OWN_ICON_SIZE) {
    const from = canvas
    const size = Math.max(OWN_ICON_SIZE, Math.floor(from.width / 2))
    canvas = draw(size, (context) => context.drawImage(from, 0, 0, size, size))
  }
  const src = canvas.toDataURL('image/png')
  return { src, base64: src.slice(src.indexOf(',') + 1) }
}

/** A square canvas that size, or the icon's if smaller, painted. */
function draw(size: number, paint: (context: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(size, OWN_ICON_SIZE)
  canvas.height = canvas.width
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('This browser can’t make the picture. Try another browser.')
  context.imageSmoothingQuality = 'high'
  paint(context, canvas.width)
  return canvas
}
