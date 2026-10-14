// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react'
import { pixel } from '../../../../../landing/fonts'

/** The settings draw the server list message in the landing page's pixel face, loaded for this page only. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={pixel.variable} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}
