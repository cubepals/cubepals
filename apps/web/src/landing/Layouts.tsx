// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * Which of the landing page's two forms is on screen: the film, or the phone's own page
 * (phone/Phone.tsx). Under 1024 pixels wide it is the phone's page. Every phone is narrower than
 * that whichever way it is held, and so is a tablet held upright; a tablet on its side and a
 * computer are as wide or wider, and get the film. It is the width the film already changed its
 * shape at, and landing.css hides one form by it before anything has run.
 *
 * Both are sent, and the screen picks. Once the page is running the form follows the width: turn a
 * tablet or narrow a window and the other form takes its place, and the one it replaced stops
 * with nothing left running. A phone is sent its page alone, from another route (app/phone), and
 * never loads the film; it is narrower than this whichever way it is held.
 */
import { type ReactNode, useEffect, useState } from 'react'

/** The phone's page, by width: one pixel under where the film begins (landing.css says the same). */
const PHONE = '(max-width: 1023px)'

export function Layouts({ film, page }: { film: ReactNode; page: ReactNode }) {
  const [shown, setShown] = useState<'film' | 'page' | 'both'>('both')
  useEffect(() => {
    const media = window.matchMedia(PHONE)
    const fit = () => setShown(media.matches ? 'page' : 'film')
    fit()
    media.addEventListener('change', fit)
    return () => media.removeEventListener('change', fit)
  }, [])
  return (
    <>
      {shown !== 'page' && film}
      {shown !== 'film' && page}
    </>
  )
}
