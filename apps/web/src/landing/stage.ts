// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the landing page's chunk is doing right now, shared between the canvas that draws it and
 * the demonstrations that drive it. One small store outside React, so a demonstration anywhere on
 * the page can wake the server on the surface without anything in between re-rendering.
 */
import { useSyncExternalStore } from 'react'
import type { RoomKey } from './engine/chunk'

/** The four things the demo server can be doing, in the product's own order. */
type Power = 'asleep' | 'waking' | 'awake' | 'saving'

export interface Stage {
  power: Power
  /** Players standing in the world on the surface. */
  players: number
  /** Minecraft Y in the middle of the view, as the gauge reads it. */
  y: number
  /** The room the page is talking about, lit while it is. */
  room: RoomKey | null
  /** A demonstration's own say over a room's light, 0–1. Rooms not named follow `room`. */
  glow: Partial<Record<RoomKey, number>>
  /**
   * What the pointer is on, of the chunk: a block a click would dig out, one that is kept (the
   * story needs it, or it is bedrock), water, or nothing.
   */
  aim: Aim
  /** How many blocks have been dug out of the chunk so far. */
  dug: number
  /** The last thing the chunk said in the game's voice, as a line of chat. */
  said: { id: number; text: string } | null
  /**
   * The ledger's lines as the server under the house is told them: a pair of letters a line, the
   * group it is in (g, a, m, u) and whether it is absent (0), there (1) or changed by the last
   * choice (2). Empty until the ledger has said.
   */
  ledger: string
  /**
   * How many demonstrations on screen have been paused. While any is, nothing on the chunk moves
   * by itself either: the pause button is the page's way to hold everything still.
   */
  held: number
  /**
   * What each room's demonstration is showing just now, in a few plain values, so the scene drawn
   * in that room can show the same thing. A room not named has nothing to follow, and plays by
   * itself.
   */
  rooms: Partial<Record<RoomKey, Showing>>
}

/** A demonstration's state as its room's scene needs it: a few named numbers, words or switches. */
export type Showing = Readonly<Record<string, string | number | boolean>>

export type Aim = 'dig' | 'kept' | 'water' | null

let state: Stage = {
  power: 'asleep',
  players: 0,
  y: 64,
  room: null,
  glow: {},
  aim: null,
  dug: 0,
  said: null,
  ledger: '',
  held: 0,
  rooms: {},
}
let lines = 0
const listeners = new Set<() => void>()

export const stage = {
  get: (): Stage => state,
  set(change: Partial<Stage>): void {
    const next = { ...state, ...change }
    const same = (Object.keys(next) as (keyof Stage)[]).every((key) => next[key] === state[key])
    if (same) return
    state = next
    for (const listener of listeners) listener()
  },
  /** Turns one room's light to a level of a demonstration's choosing; `null` hands it back. */
  glow(room: RoomKey, level: number | null): void {
    // Saying what is already so tells nobody anything: a demonstration may call this on every
    // scroll, and everything that listens to the stage would be woken for nothing.
    if (level === null ? !(room in state.glow) : state.glow[room] === level) return
    const glow = { ...state.glow }
    if (level === null) delete glow[room]
    else glow[room] = level
    stage.set({ glow })
  },
  /**
   * Says what a room's demonstration is showing; `null` when it stops (it has left the page).
   * Saying what is already so tells nobody anything.
   */
  show(room: RoomKey, showing: Showing | null): void {
    const was = state.rooms[room]
    if (showing === null) {
      if (!was) return
      const rooms = { ...state.rooms }
      delete rooms[room]
      stage.set({ rooms })
      return
    }
    const keys = Object.keys(showing)
    if (was && keys.length === Object.keys(was).length && keys.every((key) => was[key] === showing[key]))
      return
    stage.set({ rooms: { ...state.rooms, [room]: showing } })
  },
  /** Says a line in the game's voice, the way the game's chat would. */
  say(text: string): void {
    lines += 1
    stage.set({ said: { id: lines, text } })
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

const SERVER: Stage = {
  power: 'asleep',
  players: 0,
  y: 64,
  room: null,
  glow: {},
  aim: null,
  dug: 0,
  said: null,
  ledger: '',
  held: 0,
  rooms: {},
}

/** One value from the stage, re-rendering only when that value changes. */
export function useStage<T>(pick: (stage: Stage) => T): T {
  return useSyncExternalStore(
    stage.subscribe,
    () => pick(state),
    () => pick(SERVER),
  )
}
