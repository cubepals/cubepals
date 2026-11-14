// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the island's worker does (island.worker.ts): the page hands it a canvas and says what it
 * wants (`Told`); it answers with what the server is doing, where the scene's marks are and when
 * the lit print first shows (`Answer`). It draws only while the picture is on the screen and
 * something moves, and rests otherwise. A WebGL context taken away (a busy graphics card, a tab
 * evicted) is said at once, so the page shows its still again, and the drawing is made again on
 * the same canvas if the context comes back. The worker's global and the drawing are given to it,
 * so a test can stand in for both. Not the page's side, which is drawing.ts.
 */
import type { Input, Marks, Power, Stepped } from './scene'

/** What the page tells the worker. */
export type Told =
  | { kind: 'start'; canvas: OffscreenCanvas; width: number; height: number; ratio: number; input: Input }
  | { kind: 'size'; width: number; height: number; ratio: number }
  | { kind: 'input'; input: Input }
  | { kind: 'seen'; seen: boolean }

/** What the worker answers. */
export type Answer =
  | { kind: 'state'; power: Power; players: number }
  | { kind: 'marks'; marks: Marks }
  | { kind: 'shown' }
  | { kind: 'lost' }
  | { kind: 'failed' }

/** The worker's own global, as much of it as is used here (the page's types don't include a worker's). */
export interface Scope {
  postMessage(message: Answer): void
  onmessage: ((event: MessageEvent<Told>) => void) | null
  requestAnimationFrame?: (draw: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

/** What the worker needs of the drawing (scene.ts's `Island`). */
export interface Drawn {
  readonly lit: boolean
  frame(now: number): Stepped
  marks(): Marks
  resize(width: number, height: number, ratio: number): void
  set(input: Input): void
  dispose(): void
}

/** A mark's place rounded to a tenth of a CSS pixel's worth, so a still picture says nothing more. */
const placeOf = (marks: Marks) =>
  JSON.stringify(marks, (_, value) => (typeof value === 'number' ? Math.round(value * 2000) / 2000 : value))

/** Serves the page from `scope`, making the drawing on a canvas with `make`. */
export function serve(scope: Scope, make: (canvas: OffscreenCanvas) => Drawn): void {
  const serving = new Serving(scope, make)
  scope.onmessage = (event) => serving.told(event.data)
}

class Serving {
  private island: Drawn | null = null
  /** What the drawing was last told, so it can be made again on its canvas when the context comes back. */
  private size = { width: 1, height: 1, ratio: 1 }
  private input: Input | null = null
  private seen = true
  private scheduled = 0
  private shown = false
  private said = ''
  private placed = ''
  private readonly began = performance.now()
  private readonly scope: Scope
  private readonly make: (canvas: OffscreenCanvas) => Drawn

  constructor(scope: Scope, make: (canvas: OffscreenCanvas) => Drawn) {
    this.scope = scope
    this.make = make
  }

  told(told: Told): void {
    try {
      if (told.kind === 'start') {
        this.size = { width: told.width, height: told.height, ratio: told.ratio }
        this.input = told.input
        this.watchContext(told.canvas)
        this.build(told.canvas)
      } else if (told.kind === 'size') {
        this.size = { width: told.width, height: told.height, ratio: told.ratio }
        this.island?.resize(told.width, told.height, told.ratio)
      } else if (told.kind === 'input') {
        this.input = told.input
        this.island?.set(told.input)
      } else this.seen = told.seen
    } catch {
      this.fail()
      return
    }
    this.wake()
  }

  private say(answer: Answer) {
    this.scope.postMessage(answer)
  }

  private readonly draw = () => {
    this.scheduled = 0
    const island = this.island
    if (!island || !this.seen) return
    let stepped: Stepped
    try {
      stepped = island.frame(performance.now() - this.began)
    } catch {
      this.fail()
      return
    }
    const state = `${stepped.power}:${stepped.players}`
    if (state !== this.said) {
      this.said = state
      this.say({ kind: 'state', power: stepped.power, players: stepped.players })
    }
    const marks = island.marks()
    const place = placeOf(marks)
    if (place !== this.placed) {
      this.placed = place
      this.say({ kind: 'marks', marks })
    }
    if (!this.shown && island.lit) {
      this.shown = true
      this.say({ kind: 'shown' })
    }
    // Still busy, or still waiting for the lit print: another frame. Otherwise rest until told.
    if (stepped.busy || !this.shown) this.wake()
  }

  /** The next frame, on the worker's own frame clock where it has one. */
  private wake() {
    if (this.scheduled || !this.island || !this.seen) return
    const { requestAnimationFrame } = this.scope
    this.scheduled = requestAnimationFrame
      ? requestAnimationFrame(this.draw)
      : (setTimeout(this.draw, 16) as unknown as number)
  }

  private stop() {
    if (this.scheduled) {
      if (this.scope.cancelAnimationFrame) this.scope.cancelAnimationFrame(this.scheduled)
      else clearTimeout(this.scheduled)
    }
    this.scheduled = 0
    this.island = null
    this.shown = false
    this.said = ''
    this.placed = ''
  }

  private fail() {
    this.island?.dispose()
    this.stop()
    this.say({ kind: 'failed' })
  }

  /** The drawing, made on the canvas as last told: at the start, and when a lost context comes back. */
  private build(on: OffscreenCanvas) {
    const island = this.make(on)
    island.resize(this.size.width, this.size.height, this.size.ratio)
    if (this.input) island.set(this.input)
    this.island = island
  }

  /** Listens for the canvas's context being taken away, and given back. */
  private watchContext(on: OffscreenCanvas) {
    on.addEventListener('webglcontextlost', (event) => {
      // Said to be handled, so the browser may give it back; nothing can be drawn until it does.
      event.preventDefault()
      this.stop()
      this.say({ kind: 'lost' })
    })
    on.addEventListener('webglcontextrestored', () => {
      try {
        this.build(on)
      } catch {
        this.fail()
        return
      }
      this.wake()
    })
  }
}
