// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata, Viewport } from 'next'
import { Figtree, IBM_Plex_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import { display } from '../landing/fonts'
import { Insight } from '../lib/insight'
import { canonicalOrigin, indexable, PRIVATE } from '../lib/site'
import { ThemeTransitions } from './theme-transitions'
import './globals.css'

const sans = Figtree({ subsets: ['latin'], variable: '--font-figtree', display: 'swap' })
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})

const DESCRIPTION = 'A Minecraft server that starts when your friends join. Free to start.'

// The icons and the link preview come from the files beside this one — `icon.svg`, `apple-icon.png`
// and `opengraph-image.png` — which are the brand's own (brand/README.md). Links resolve against the
// canonical origin, and every deployment but production asks search engines to leave it out.
export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin()),
  title: { default: 'Cubepals', template: '%s · Cubepals' },
  description: DESCRIPTION,
  applicationName: 'Cubepals',
  openGraph: { siteName: 'Cubepals', type: 'website' },
  twitter: { card: 'summary_large_image' },
  ...(indexable() ? {} : { robots: PRIVATE }),
}

// Light only for now. The dark theme stays in tokens.css; drop data-theme to follow the system.
export const viewport: Viewport = {
  themeColor: '#f8f7f5',
  colorScheme: 'light',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <ThemeTransitions />
        <Insight />
        {children}
      </body>
    </html>
  )
}
