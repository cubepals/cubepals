// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where the phone's pictures are printed (printer.ts), off the page's own thread: building the chunk
 * and drawing it never holds up a tap or a scroll. Asked for a picture and a size, it answers with
 * the picture, or with null where it can't draw.
 */
import { print, type Still } from './printer'

self.onmessage = (
  event: MessageEvent<{ still: Still; width: number; across: number; down: number; dot: number }>,
) => {
  const { still, width, across, down, dot } = event.data
  const printed = print(still, across, down, dot)
  self.postMessage({ still, width, printed }, printed ? { transfer: [printed.bitmap] } : {})
}
