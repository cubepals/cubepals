// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where the island is drawn (scene.ts), off the page's own thread: building the chunk, stepping
 * the friends and printing each frame never holds up a scroll, a tap or a key. The page hands it a
 * canvas and says what it wants (`Told`); it answers with what the server is doing, where the
 * scene's marks are and when the lit print first shows (`Answer`). It draws only while the picture
 * is on the screen and something moves, and rests otherwise. A WebGL context taken away (a busy
 * graphics card, a tab evicted) is said at once, so the page shows its still again, and the
 * drawing is made again on the same canvas if the context comes back. Not the page's side, which
 * is drawing.ts.
 */
import { type Input, Island, type Marks, type Power } from './scene'

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
interface Scope {
  postMessage(message: Answer): void
  onmessage: ((event: MessageEvent<Told>) => void) | null
  requestAnimationFrame?: (draw: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

const scope = self as unknown as Scope
const say = (answer: Answer) => scope.postMessage(answer)

let island: Island | null = null
/** What the drawing was last told, so it can be made again on its canvas when the context comes back. */
let size = { width: 1, height: 1, ratio: 1 }
let input: Input | null = null
let seen = true
let scheduled = 0
let shown = false
let said = ''
let placed = ''
const began = performance.now()

/** The next frame, on the worker's own frame clock where it has one. */
const next = (draw: () => void): number =>
  scope.requestAnimationFrame
    ? scope.requestAnimationFrame(draw)
    : (setTimeout(draw, 16) as unknown as number)

const cancel = (handle: number) => {
  if (scope.cancelAnimationFrame) scope.cancelAnimationFrame(handle)
  else clearTimeout(handle)
}

/** A mark's place rounded to a tenth of a CSS pixel's worth, so a still picture says nothing more. */
const placeOf = (marks: Marks) =>
  JSON.stringify(marks, (_, value) => (typeof value === 'number' ? Math.round(value * 2000) / 2000 : value))

function draw() {
  scheduled = 0
  if (!island || !seen) return
  let stepped: ReturnType<Island['frame']>
  try {
    stepped = island.frame(performance.now() - began)
  } catch {
    fail()
    return
  }
  const state = `${stepped.power}:${stepped.players}`
  if (state !== said) {
    said = state
    say({ kind: 'state', power: stepped.power, players: stepped.players })
  }
  const marks = island.marks()
  const place = placeOf(marks)
  if (place !== placed) {
    placed = place
    say({ kind: 'marks', marks })
  }
  if (!shown && island.lit) {
    shown = true
    say({ kind: 'shown' })
  }
  // Still busy, or still waiting for the lit print: another frame. Otherwise rest until told.
  if (stepped.busy || !shown) wake()
}

function wake() {
  if (!scheduled && island && seen) scheduled = next(draw)
}

function stop() {
  if (scheduled) cancel(scheduled)
  scheduled = 0
  island = null
  shown = false
  said = ''
  placed = ''
}

function fail() {
  island?.dispose()
  stop()
  say({ kind: 'failed' })
}

/** The drawing, made on the canvas as last told: at the start, and when a lost context comes back. */
function build(on: OffscreenCanvas) {
  island = new Island(on)
  island.resize(size.width, size.height, size.ratio)
  if (input) island.set(input)
}

/** Listens for the canvas's context being taken away, and given back. */
function watchContext(on: OffscreenCanvas) {
  on.addEventListener('webglcontextlost', (event) => {
    // Said to be handled, so the browser may give it back; nothing can be drawn until it does.
    event.preventDefault()
    stop()
    say({ kind: 'lost' })
  })
  on.addEventListener('webglcontextrestored', () => {
    try {
      build(on)
    } catch {
      fail()
      return
    }
    wake()
  })
}

scope.onmessage = (event: MessageEvent<Told>) => {
  const told = event.data
  try {
    if (told.kind === 'start') {
      size = { width: told.width, height: told.height, ratio: told.ratio }
      input = told.input
      watchContext(told.canvas)
      build(told.canvas)
    } else if (told.kind === 'size') {
      size = { width: told.width, height: told.height, ratio: told.ratio }
      island?.resize(told.width, told.height, told.ratio)
    } else if (told.kind === 'input') {
      input = told.input
      island?.set(told.input)
    } else seen = told.seen
  } catch {
    fail()
    return
  }
  wake()
}
