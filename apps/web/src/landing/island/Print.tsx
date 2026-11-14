// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * One of the island's stills, shown dot for dot: the print made for the screen's density, at
 * exactly two or three device pixels a dot, centred in its box and cropped by it rather than
 * scaled (a scaled dither shimmers). Until the page knows the screen's density, its size comes from
 * the stylesheet's own guess for the common ones.
 */
import { useEffect, useState } from 'react'
import { unitOf } from './dots'
import styles from './island.module.css'
import { STILLS } from './stills'

export function Print({
  which,
  className = '',
  children,
}: {
  which: keyof typeof STILLS
  className?: string
  /** What is set on the print, in fractions of its own width and height: its measurements, a snore. */
  children?: React.ReactNode
}) {
  const { fine, coarse } = STILLS[which]
  const [unit, setUnit] = useState<number | null>(null)
  useEffect(() => {
    const measure = () => setUnit(unitOf(window.devicePixelRatio || 1))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const sized = unit === null ? undefined : ({ '--unit': `${unit}px` } as React.CSSProperties)
  return (
    <span className={`${styles.print} ${className}`} style={sized}>
      <picture>
        <source media="(min-resolution: 1.5dppx)" srcSet={fine.src} width={fine.width} height={fine.height} />
        <img src={coarse.src} width={coarse.width} height={coarse.height} alt="" decoding="async" />
      </picture>
      {children}
    </span>
  )
}
