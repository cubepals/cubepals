// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * Lights the chunk's rooms while the section it sits in holds the screen, one after another or
 * all together.
 */
import { useEffect, useRef } from 'react'
import { ROOMS } from '../engine/chunk'
import { stage } from '../stage'

/**
 * Lights the chunk's rooms while the section it sits in is on screen, for the two moments the
 * camera stands back far enough to see them all. `sequence` lights them one after another, top to
 * bottom, as the section is scrolled through, and marks each room's label as lit with it; `played`
 * does the same by the clock, once the section holds the screen, for a section that is one screen
 * and is not scrolled through; `all` lights them together. Leaving the section hands every lamp
 * back to the page.
 */
export function RoomLights({ how }: { how: 'sequence' | 'played' | 'all' }) {
  const marker = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const section = marker.current?.closest('section')
    if (!section) return
    let on = false
    // Which rooms are lit now, as bits, so that a scroll that changes nothing does nothing.
    let lit = -1
    // Played by the clock: how many rooms are lit so far, and what lights the next.
    let reached = 0
    let next: ReturnType<typeof setInterval> | undefined
    const light = () => {
      if (!on) return
      const box = section.getBoundingClientRect()
      // How far through the section the middle of the screen has come, 0 to 1.
      const through = (window.innerHeight / 2 - box.top) / Math.max(1, box.height)
      let now = 0
      ROOMS.forEach((_, index) => {
        const shown =
          how === 'all' ||
          (how === 'played' ? index < reached : through > (index + 1.5) / (ROOMS.length + 3.5))
        if (shown) now |= 1 << index
      })
      if (now === lit) return
      lit = now
      ROOMS.forEach((room, index) => {
        const shown = (now & (1 << index)) !== 0
        stage.glow(room.key, shown ? 1 : 0)
        // A room's name comes up with its lamps.
        section.querySelector(`[data-pin="${room.key}"]`)?.toggleAttribute('data-lit', shown)
      })
    }
    const release = () => {
      lit = -1
      reached = 0
      clearInterval(next)
      for (const room of ROOMS) stage.glow(room.key, null)
    }
    const seen = new IntersectionObserver(
      ([entry]) => {
        on = entry?.isIntersecting ?? false
        if (!on) return release()
        if (how === 'played') {
          clearInterval(next)
          next = setInterval(() => {
            reached += 1
            light()
            if (reached >= ROOMS.length) clearInterval(next)
          }, 380)
        }
        light()
      },
      // Only while the section holds the middle of the screen, where the camera is on it.
      { rootMargin: '-45% 0px -45% 0px' },
    )
    seen.observe(section)
    window.addEventListener('scroll', light, { passive: true })
    return () => {
      seen.disconnect()
      window.removeEventListener('scroll', light)
      release()
    }
  }, [how])

  return <span ref={marker} hidden />
}
