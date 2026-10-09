/**
 * The beat the page is resting on, as far as the scrolling and the canvas need to know it. A beat
 * plays by itself, at its own pace, and the reader's scrolling moves it: scrolling on hurries
 * its story along, and scrolling back plays it backwards. While it is still playing the page
 * stays on it; it is left downward only once it has finished, and upward only once it is back
 * at its start. The canvas plays its scene at the same pace.
 *
 * It is one small thing outside React, like stage.ts, because it changes on every frame.
 */

/** The most a reader's scrolling can add to the pace: with it, a beat goes at eight times its own. */
const MOST = 7
/** How much a turn of the wheel adds, for each pixel it asked for. */
const GAIN = 1 / 90

const heard = new Set<() => void>()

export const playing = {
  /** A beat is on and has not finished: scrolling on hurries it, and doesn't leave it. */
  busy: false,
  /** How far into its story the beat is, in seconds: past 0, scrolling back plays it backwards. */
  at: 0,
  /** How fast the picture is going: 1 at its own pace. */
  pace: 1,
  /**
   * How hard the reader is scrolling just now, and which way: on is more than 0, back is less.
   * It dies away by itself (the beat sees to that).
   */
  push: 0,
  /** Which way the page was going when it came to this beat: 1 down, -1 up. */
  heading: 1 as 1 | -1,
  /** True while a beat is being played backwards: what is said aloud is not said again. */
  back: false,
  /** The reader scrolled by this much, down or up, while the beat held the page. */
  hurry(pixels: number): void {
    playing.push = Math.min(MOST, Math.max(-MOST, playing.push + pixels * GAIN))
  },
  /** A beat begins, or ends: whoever is listening is told. */
  set(busy: boolean): void {
    if (busy === playing.busy) return
    playing.busy = busy
    playing.tell()
  },
  /** The beat has come to one of its ends under a hand that may still be scrolling. */
  tell(): void {
    for (const tell of heard) tell()
  },
  listen(tell: () => void): () => void {
    heard.add(tell)
    return () => heard.delete(tell)
  },
}
