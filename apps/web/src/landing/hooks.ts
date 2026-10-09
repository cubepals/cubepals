'use client'

import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** True for someone who asked their device for less motion: a demonstration then shows its end state. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(QUERY)
      media.addEventListener('change', changed)
      return () => media.removeEventListener('change', changed)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}

/** True while the element is on screen, so a demonstration only runs its timers when it can be seen. */
export function useInView(ref: RefObject<Element | null>, margin = '0px'): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      rootMargin: margin,
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, margin])
  return inView
}
