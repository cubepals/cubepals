// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import type { ReactNode } from 'react'

/** The page reads the address from its link, so it renders in the browser; its title is set here. */
export const metadata: Metadata = { title: 'Check your email' }

export default function CheckEmailLayout({ children }: { children: ReactNode }) {
  return children
}
