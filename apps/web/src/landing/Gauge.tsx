'use client'

/**
 * The mark at the edge of the screen that says where in the film the page is: one square to a
 * beat, the current one filled, each a way straight to its beat, and under them the depth as
 * Minecraft's own Y.
 */
import { useEffect, useRef, useState } from 'react'
import { stage, useStage } from './stage'

/** A beat as the gauge lists it: where a link to it leads, and what it is called. */
interface Mark {
  id: string
  name: string
}

/**
 * The beats are read off the page, so the gauge always lists what the page has, in its order.
 * Which one is current is read off the scroll: the beat that holds the middle of the screen.
 */
export function Gauge() {
  const dug = useStage((now) => now.dug)
  const nav = useRef<HTMLElement>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [at, setAt] = useState(0)
  // The depth changes on every frame of a flight, so it is written straight onto the page: no
  // re-render of the gauge for a number.
  const depth = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const write = () => {
      const text = `Y ${stage.get().y}`
      if (depth.current && depth.current.textContent !== text) depth.current.textContent = text
    }
    write()
    return stage.subscribe(write)
  }, [])

  useEffect(() => {
    const root = nav.current?.closest('[data-landing]')
    if (!root) return
    const beats = [...root.querySelectorAll<HTMLElement>('.bl-dig > .bl-section[id]')]
    setMarks(beats.map((beat) => ({ id: beat.id, name: beat.dataset.name ?? beat.id })))
    const where = () => {
      const middle = window.innerHeight / 2
      // The last beat that begins above the middle of the screen is the one being looked at.
      const index = beats.findLastIndex((beat) => beat.getBoundingClientRect().top <= middle)
      setAt(Math.max(0, index))
    }
    where()
    window.addEventListener('scroll', where, { passive: true })
    window.addEventListener('resize', where)
    return () => {
      window.removeEventListener('scroll', where)
      window.removeEventListener('resize', where)
    }
  }, [])

  return (
    <nav ref={nav} className="bl-gauge" aria-label="Where you are">
      <ol className="bl-gauge__stops">
        {marks.map((mark, index) => (
          <li key={mark.id}>
            <a href={`#${mark.id}`} aria-current={index === at ? 'true' : undefined}>
              <span>{mark.name}</span>
            </a>
          </li>
        ))}
      </ol>
      <div ref={depth} className="bl-gauge__y bl-num" aria-hidden>
        Y 64
      </div>
      {/* Whoever has been digging gets a count of it, the way the game keeps statistics. */}
      {dug > 0 && (
        <div className="bl-gauge__y bl-gauge__dug bl-num" aria-hidden>
          {dug} dug
        </div>
      )}
    </nav>
  )
}
