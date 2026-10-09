'use client'

import { useEffect } from 'react'

/**
 * When the system theme flips, every colour transition would fire at once and the page would
 * smear. Suspend transitions for the swap, force the new colours in, then restore them.
 */
export function ThemeTransitions() {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const style = document.createElement('style')
      style.append(document.createTextNode('*,*::before,*::after{transition:none !important}'))
      document.head.append(style)
      void document.body.offsetHeight
      requestAnimationFrame(() => requestAnimationFrame(() => style.remove()))
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return null
}
