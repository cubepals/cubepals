// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How the stack moves as it is read. The step being read says where every part goes: the parts over
 * the read plate rise so its whole top shows, the plate rises a little and is pulled out toward its
 * words, and the world rises a little when it is read; for the join the stack closes and a friend's
 * way is drawn in at the door and up the stack, lighting each part as it passes. A move is eased in
 * and out from wherever things stand; a change of look is a dissolve through the dither, never a
 * fade, so nothing is ever grey but the dither; with less motion asked for, everything is at once
 * where it ends. It finds what it moves by the marks Drawing.tsx sets. Not where anything is, which
 * is geometry.ts.
 */
import { SIZE } from '../engine/chunk'
import { clamp, inOut, outQuart } from '../engine/curves'
import { LEVELS, tileOf } from './dither'
import {
  bottomOf,
  CORNERS,
  FLOOR,
  PARTS,
  type Part,
  PLATES,
  type Plate,
  type Spot,
  type Stack,
  topOf,
} from './geometry'

/** What can be read: a part, or a friend joining. */
export type Step = Part | 'join'
/** Where the parts can be: as a step has them, packed under the island before the stack is seen, or closed. */
type Pose = Step | 'packed' | 'closed'

/** Milliseconds: a move, the stack's first opening, a dissolve from nothing to all, the world waking, the join and its wait. */
const MOVE = 950
const OPENING = 1400
const DISSOLVE = 520
const WAKE = 760
const JOIN = 2800
const JOIN_AFTER = 750
/** The share of the join spent coming to the door; the rest is the climb. */
const AT_DOOR = 0.3
/** How many dots in 16 of the world's print still show while another part is read. */
const DIMMED = 6

interface Placed {
  lift: number[]
  pull: number[]
}

/** Where every part goes for a pose: lifted, in pixels up, and pulled out, from 0 to all the way. */
export function poseOf(stack: Stack, pose: Pose): Placed {
  const lift = PARTS.map((_, i) => (pose === 'packed' ? stack.packed * i : 0))
  const pull = PARTS.map(() => 0)
  const k = PARTS.indexOf(pose as Part)
  if (k === 0) lift[0] = stack.world
  if (k > 0) {
    for (let i = 0; i < k; i++) lift[i] = (stack.open[k] ?? 0) + stack.rise - (k - 1 - i) * stack.closer
    lift[k] = stack.rise
    pull[k] = 1
  }
  return { lift, pull }
}

/** The part of a line travelled so far, and where its head is. */
export function travelled(line: readonly Spot[], fraction: number): { shown: Spot[]; head: Spot } {
  const shown: Spot[] = line.length ? [line[0] as Spot] : []
  let left =
    fraction *
    line.reduce(
      (sum, p, k) =>
        k ? sum + Math.hypot(p[0] - (line[k - 1] as Spot)[0], p[1] - (line[k - 1] as Spot)[1]) : 0,
      0,
    )
  for (let k = 1; k < line.length && left > 0; k++) {
    const [a, b] = [line[k - 1] as Spot, line[k] as Spot]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length <= left) {
      shown.push(b)
      left -= length
      continue
    }
    const f = length ? left / length : 0
    shown.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
    break
  }
  return { shown, head: shown.at(-1) ?? [0, 0] }
}

/** Something that dissolves: how many dots in 16 show now, where it is going, and how it is shown. */
interface Fade {
  level: number
  to: number
  from: number
  start: number
  ms: number
  apply: (level: number) => void
}

const drawn = (line: readonly Spot[]) => line.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')

export class Motion {
  private readonly now = { lift: PARTS.map(() => 0), pull: PARTS.map(() => 0), pan: 0 }
  /** Where the drawing sits across its window: in the middle, on whole device pixels of the page. */
  private across = 0
  private pose: Pose = 'packed'
  private moving = 0
  private joining = 0
  private fading = 0
  private readonly fades = new Set<Fade>()
  private readonly lit = new Map<Plate, Fade>()
  private readonly asleep: Fade
  private readonly awake: Fade
  private readonly q: <T extends Element>(selector: string) => T | null
  private readonly root: HTMLElement
  private readonly stack: Stack
  private readonly id: string
  /** How tall the window it is seen through is now. */
  private readonly room: () => number
  /** Less motion asked for: everything at once where it ends. */
  private readonly still: boolean

  constructor(root: HTMLElement, stack: Stack, id: string, room: () => number, still: boolean) {
    this.root = root
    this.stack = stack
    this.id = id
    this.room = room
    this.still = still
    this.q = <T extends Element>(selector: string) => root.querySelector<T>(selector)
    for (const { part } of PLATES) this.lit.set(part, this.plateFade(part))
    this.asleep = this.printFade('leave', LEVELS)
    this.awake = this.printFade('join', 0)
    this.place(poseOf(stack, still ? 'closed' : 'packed'), still ? 'closed' : 'packed')
    if (still) this.pose = 'closed'
  }

  /** The stack's first opening, from packed under the island, once it is seen. */
  open(): void {
    if (this.pose !== 'packed') return
    this.pose = 'closed'
    this.moveTo('closed', OPENING)
  }

  /** The step being read: the parts move to it, its plate comes in lit and the others go back to rest. */
  show(step: Step): void {
    if (step === this.pose) return
    this.pose = step
    for (const { part } of PLATES) this.light(part, part === step)
    this.dissolve(this.asleep, step === 'world' || step === 'join' ? LEVELS : DIMMED)
    for (const part of PARTS) this.q(`[data-name="${part}"]`)?.toggleAttribute('data-on', part === step)
    this.q('[data-players]')?.toggleAttribute('data-on', step === 'door' || step === 'join')
    this.stopJoin()
    this.moveTo(step === 'join' ? 'closed' : step)
    if (step === 'join') this.playJoin()
  }

  /** The window it is seen through changed: everything is put where it now goes, at once. */
  resized(): void {
    cancelAnimationFrame(this.moving)
    const pose = this.pose === 'join' ? 'closed' : this.pose
    this.place(poseOf(this.stack, pose), pose)
  }

  dispose(): void {
    cancelAnimationFrame(this.moving)
    cancelAnimationFrame(this.joining)
    cancelAnimationFrame(this.fading)
  }

  private offset(i: number): Spot {
    const { pull } = this.stack
    return [pull[0] * (this.now.pull[i] ?? 0), pull[1] * (this.now.pull[i] ?? 0) - (this.now.lift[i] ?? 0)]
  }

  private moved(i: number, place: readonly [number, number, number]): Spot {
    const [x, y] = this.stack.at(place)
    const [dx, dy] = this.offset(i)
    return [x + dx, y + dy]
  }

  /** Where the drawing sits in its window: in the middle if it fits, or else the part being read kept in the middle. */
  private panOf(pose: Pose, placed: Placed): number {
    const room = this.room()
    const { stack } = this
    if (stack.height <= room) return Math.round((room - stack.height) / 2)
    const k = PARTS.indexOf(pose as Part)
    const lift = (i: number) => placed.lift[i] ?? 0
    const [top, bottom] =
      k > 0
        ? [stack.at([0, topOf(k), 0])[1] - lift(k), stack.at([SIZE, bottomOf(k), SIZE])[1] - lift(k)]
        : [
            stack.print.y - lift(0),
            k === 0 ? stack.print.y + stack.print.height - lift(0) : stack.at([SIZE, FLOOR, SIZE])[1],
          ]
    return clamp(room / 2 - (top + bottom) / 2, room - stack.height, 0)
  }

  /** Everything put where `placed` says, at once. */
  private place(placed: Placed, pose: Pose): void {
    const box = this.root.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    this.across = Math.round((box.left + (box.width - this.stack.width) / 2) * ratio) / ratio - box.left
    this.now.lift = [...placed.lift]
    this.now.pull = [...placed.pull]
    this.now.pan = this.panOf(pose, placed)
    this.render()
  }

  private moveTo(pose: Pose, ms = MOVE): void {
    const target = poseOf(this.stack, pose)
    const pan = this.panOf(pose, target)
    const from = { lift: [...this.now.lift], pull: [...this.now.pull], pan: this.now.pan }
    const start = performance.now()
    cancelAnimationFrame(this.moving)
    const tick = (t: number) => {
      const p = this.still ? 1 : clamp((t - start) / ms)
      const e = inOut(p)
      PARTS.forEach((_, i) => {
        this.now.lift[i] = (from.lift[i] ?? 0) + ((target.lift[i] ?? 0) - (from.lift[i] ?? 0)) * e
        this.now.pull[i] = (from.pull[i] ?? 0) + ((target.pull[i] ?? 0) - (from.pull[i] ?? 0)) * e
      })
      this.now.pan = from.pan + (pan - from.pan) * e
      this.render()
      if (p < 1) this.moving = requestAnimationFrame(tick)
    }
    if (this.still) tick(start)
    else this.moving = requestAnimationFrame(tick)
  }

  /** The parts, the print and the rails where `now` has them, each on whole device pixels so the dither stays sharp. */
  private render(): void {
    const ratio = window.devicePixelRatio || 1
    const px = (v: number) => Math.round(v * ratio) / ratio
    const pan = this.q<HTMLElement>('[data-pan]')
    if (pan) pan.style.transform = `translate3d(${this.across}px, ${px(this.now.pan)}px, 0)`
    PARTS.forEach((_, i) => {
      const [dx, dy] = this.offset(i)
      const move = `translate(${px(dx)}px, ${px(dy)}px)`
      for (const node of this.root.querySelectorAll<HTMLElement | SVGElement>(
        `[data-under="${i}"], [data-over="${i}"]`,
      ))
        node.style.transform = move
      if (i === 0)
        for (const img of this.root.querySelectorAll<HTMLElement>('[data-print]')) img.style.transform = move
    })
    for (const line of this.root.querySelectorAll<SVGLineElement>('[data-rail]')) {
      const i = Number(line.dataset.rail)
      const [cx, cz] = CORNERS[Number(line.dataset.corner)] as readonly [number, number]
      const a = this.moved(i - 1, [cx, bottomOf(i - 1), cz])
      const b = this.moved(i, [cx, topOf(i), cz])
      line.setAttribute('x1', a[0].toFixed(2))
      line.setAttribute('y1', a[1].toFixed(2))
      line.setAttribute('x2', b[0].toFixed(2))
      line.setAttribute('y2', b[1].toFixed(2))
    }
  }

  private plateFade(part: Plate): Fade {
    const group = this.q<SVGGElement>(`[data-lit="${part}"]`)
    const rect = this.q<SVGRectElement>(`[data-mask="${part}"]`)
    return this.fade(0, (level) => {
      if (!group || !rect) return
      group.style.visibility = level === 0 ? 'hidden' : ''
      if (level === LEVELS) group.removeAttribute('mask')
      else {
        rect.setAttribute('fill', `url(#${this.id}-m${level})`)
        group.setAttribute('mask', `url(#${this.id}-mask-${part})`)
      }
    })
  }

  private printFade(which: 'leave' | 'join', level: number): Fade {
    const img = this.q<HTMLImageElement>(`[data-print="${which}"]`)
    const unit = this.stack.unit
    return this.fade(level, (to) => {
      if (!img) return
      img.style.visibility = to === 0 ? 'hidden' : ''
      const mask = to === LEVELS ? '' : tileOf(to)
      img.style.setProperty('mask-image', mask)
      img.style.setProperty('-webkit-mask-image', mask)
      img.style.setProperty('mask-size', `${4 * unit}px ${4 * unit}px`)
      img.style.setProperty('-webkit-mask-size', `${4 * unit}px ${4 * unit}px`)
    })
  }

  private fade(level: number, apply: (level: number) => void): Fade {
    const made: Fade = { level, to: level, from: level, start: 0, ms: 0, apply }
    apply(level)
    return made
  }

  private light(part: Plate, on: boolean): void {
    const fade = this.lit.get(part)
    if (fade) this.dissolve(fade, on ? LEVELS : 0)
  }

  /** A dissolve to `to` dots in 16, eased out, taking as long as its share of a whole one. */
  private dissolve(item: Fade, to: number, ms = DISSOLVE): void {
    if (item.to === to) return
    item.to = to
    item.from = item.level
    item.start = performance.now()
    item.ms = (ms * Math.abs(to - item.level)) / LEVELS
    if (this.still || item.ms === 0) {
      item.level = to
      item.apply(to)
      this.fades.delete(item)
      return
    }
    this.fades.add(item)
    if (!this.fading) this.fading = requestAnimationFrame((t) => this.fadeStep(t))
  }

  private fadeStep(t: number): void {
    for (const item of this.fades) {
      const p = clamp((t - item.start) / item.ms)
      const level = Math.round(item.from + (item.to - item.from) * outQuart(p))
      if (level !== item.level) {
        item.level = level
        item.apply(level)
      }
      if (p >= 1) this.fades.delete(item)
    }
    this.fading = this.fades.size ? requestAnimationFrame((next) => this.fadeStep(next)) : 0
  }

  /** The join's ways, where the parts are now: each player's to the door's corner, then up the stack's left-hand corner. */
  private ways() {
    const door = PARTS.indexOf('door')
    const players = Object.fromEntries(
      this.stack.players.map((player) => [
        player.name,
        player.trace.map(([x, z]) => this.moved(door, [x, FLOOR, z])),
      ]),
    )
    const up: Spot[] = [this.moved(door, [0, FLOOR, SIZE])]
    const marks: Partial<Record<Part, number>> = {}
    for (const part of ['power', 'game'] as const) {
      const i = PARTS.indexOf(part)
      up.push(this.moved(i, [0, bottomOf(i), SIZE]), this.moved(i, [0, topOf(i), SIZE]))
      marks[part] = up.length - 1
    }
    up.push(this.moved(0, [0, bottomOf(0), SIZE]))
    marks.world = up.length - 1
    return { players, up, marks }
  }

  /** How far up the climb has come to point `index` of it, in pixels. */
  private static along(line: readonly Spot[], index: number): number {
    let sum = 0
    for (let k = 1; k <= index; k++)
      sum += Math.hypot(
        (line[k] as Spot)[0] - (line[k - 1] as Spot)[0],
        (line[k] as Spot)[1] - (line[k - 1] as Spot)[1],
      )
    return sum
  }

  private playJoin(): void {
    const start = performance.now() + (this.still ? 0 : JOIN_AFTER)
    const tick = (t: number) => {
      const p = this.still ? 1 : clamp((t - start) / JOIN)
      this.joinAt(p)
      if (p < 1) this.joining = requestAnimationFrame(tick)
    }
    if (this.still) tick(start)
    else this.joining = requestAnimationFrame(tick)
  }

  /**
   * The join `p` of the way through: the players come to the door (when they are drawn), then the
   * climb is drawn up the stack, and each part lights, and is named, once the climb has reached it.
   */
  private joinAt(p: number): void {
    const share = this.stack.players.length ? AT_DOOR : 0
    const way = this.ways()
    const toDoor = share ? inOut(clamp(p / share)) : 1
    const climbing = inOut(clamp((p - share) / (1 - share)))
    this.drawPlayers(way.players, toDoor, p)
    const climb = travelled(way.up, climbing)
    this.q('[data-way="up"]')?.setAttribute('points', climbing > 0 ? drawn(climb.shown) : '')
    if (toDoor >= 1) this.dot('java', climb.head, p < 1)
    const reach = Motion.along(way.up, way.up.length - 1) * climbing
    const reached = (part: Part) =>
      part === 'door' || reach >= Motion.along(way.up, way.marks[part] ?? 0) - 0.5
    for (const part of ['door', 'power', 'game', 'world'] as const) {
      const on = toDoor >= 1 && reached(part)
      if (part !== 'world') this.light(part, on)
      this.q(`[data-name="${part}"]`)?.toggleAttribute('data-on', on)
      if (part === 'world') this.dissolve(this.awake, on ? LEVELS : 0, WAKE)
    }
  }

  private drawPlayers(ways: Record<string, Spot[]>, toDoor: number, p: number): void {
    for (const [name, line] of Object.entries(ways)) {
      const { shown, head } = travelled(line, toDoor)
      this.q(`[data-way="${name}"]`)?.setAttribute('points', p > 0 ? drawn(shown) : '')
      this.dot(name, head, p > 0 && toDoor < 1)
    }
  }

  private dot(name: string, at: Spot, shown: boolean): void {
    const dot = this.q<SVGRectElement>(`[data-dot="${name}"]`)
    if (!dot) return
    dot.setAttribute('transform', `translate(${at[0].toFixed(2)},${at[1].toFixed(2)})`)
    dot.style.visibility = shown ? 'visible' : 'hidden'
  }

  private stopJoin(): void {
    cancelAnimationFrame(this.joining)
    for (const way of this.root.querySelectorAll('[data-way]')) way.setAttribute('points', '')
    for (const dot of this.root.querySelectorAll<SVGElement>('[data-dot]')) dot.style.visibility = 'hidden'
    this.dissolve(this.awake, 0, WAKE)
  }
}
