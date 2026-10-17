// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where the print keeps quiet: the words set on the picture (`data-over`) and the header
 * (`data-quiet`), the three of them most on screen, as rects in CSS pixels from the canvas's
 * corner, for the print to open to bare ground behind (engine/print-pass.ts). They are read only
 * after the page has moved, and at most four times a second while it is still: reading them on
 * every frame would have the browser lay the page out on every frame. Not the drawing (Chunk.tsx).
 */
export class Quiet {
  private words: HTMLElement[] = []
  private readonly rects = new Float32Array(12)
  private readAt = Number.NEGATIVE_INFINITY

  /** Finds the words again, after the page has been measured. */
  find(root: HTMLElement): void {
    this.words = [...root.querySelectorAll<HTMLElement>('[data-over], [data-quiet]')]
    this.readAt = Number.NEGATIVE_INFINITY
  }

  /** The page has moved: the rects are read again on the next frame. */
  moved(): void {
    this.readAt = Number.NEGATIVE_INFINITY
  }

  /** The rects at `time` (milliseconds), for a canvas at `box`. */
  at(time: number, box: DOMRect): Float32Array {
    if (time - this.readAt < 250) return this.rects
    this.readAt = time
    this.rects.fill(0)
    const seen = this.words
      .map((element) => element.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.bottom > box.top && r.top < box.bottom)
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, 3)
    seen.forEach((r, n) => {
      this.rects.set([r.left - box.left, r.top - box.top, r.width, r.height], n * 4)
    })
    return this.rects
  }
}
