// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * One picture of the chunk on the phone's page. Until it is printed, and on a device that can't
 * print it, the frame is the picture's own ground. It is printed once the page has loaded and the
 * frame is nearly on screen, and again only if the frame changes width (a phone turned on its
 * side). The printing is done in a worker (still.worker.ts), started with the first picture and
 * shared by both.
 */
import { useEffect, useRef, useState } from 'react'
import type { Printed, Still as Which } from './printer'

/** What the worker answers: which picture, at what width, and the picture itself or null. */
interface Answer {
  still: Which
  width: number
  printed: Printed | null
}

let worker: Worker | null = null
const printer = () => {
  worker ??= new Worker(new URL('./still.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

export function Still({ still, className }: { still: Which; className?: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [chimney, setChimney] = useState<Printed['chimney']>(null)

  useEffect(() => {
    const box = frame.current
    if (!box || typeof OffscreenCanvas === 'undefined') return
    let near = false
    let loaded = document.readyState === 'complete'
    let asked = 0
    const ask = () => {
      const size = box.getBoundingClientRect()
      const width = Math.round(size.width)
      if (!near || !loaded || width === 0 || width === asked) return
      asked = width
      printer().postMessage({ still, width, height: Math.round(size.height) })
    }
    const answered = (event: MessageEvent<Answer>) => {
      const { printed } = event.data
      const shown = canvas.current
      if (event.data.still !== still || event.data.width !== asked || !printed || !shown) return
      shown.width = printed.bitmap.width
      shown.height = printed.bitmap.height
      shown.getContext('bitmaprenderer')?.transferFromImageBitmap(printed.bitmap)
      shown.dataset.printed = ''
      setChimney(printed.chimney)
    }
    // After the page has loaded, so its first screen is never kept waiting for a picture.
    const onLoad = () => {
      loaded = true
      ask()
    }
    if (!loaded) window.addEventListener('load', onLoad, { once: true })
    const seen = new IntersectionObserver(
      ([entry]) => {
        near = entry?.isIntersecting ?? false
        if (near) printer().addEventListener('message', answered)
        ask()
      },
      { rootMargin: '50% 0px' },
    )
    seen.observe(box)
    const sized = new ResizeObserver(ask)
    sized.observe(box)
    return () => {
      window.removeEventListener('load', onLoad)
      worker?.removeEventListener('message', answered)
      seen.disconnect()
      sized.disconnect()
    }
  }, [still])

  return (
    <div ref={frame} className={className} data-still={still} aria-hidden>
      <canvas ref={canvas} width={0} height={0} />
      {chimney && (
        <span
          className="bl-snore bl-game"
          style={{
            opacity: 1,
            left: `${(chimney[0] * 100).toFixed(2)}%`,
            top: `${(chimney[1] * 100).toFixed(2)}%`,
          }}
        >
          <i>z</i>
          <i>z</i>
          <i>Z</i>
        </span>
      )}
    </div>
  )
}
