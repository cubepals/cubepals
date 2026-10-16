// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document every page is set in: the faces, the site-wide title and link preview, the light
 * theme, and whether the site says it is in beta (lib/beta.ts), asked before the first paint.
 */
import type { Metadata, Viewport } from 'next'
import { Figtree, IBM_Plex_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import { display } from '../landing/fonts'
import { BETA_UNREAD, betaOn } from '../lib/beta'
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

const DESCRIPTION = 'A Minecraft server that starts when your friends join. Start with a free trial.'

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
    // The script below marks a browser that hasn't read the beta letter before React sees the
    // page, so `<html>` is allowed to differ from what the server sent by that one attribute.
    <html
      lang="en"
      data-theme="light"
      data-beta={betaOn() ? '' : undefined}
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      {betaOn() && (
        <head>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant of our own (lib/beta.ts), run before paint */}
          <script dangerouslySetInnerHTML={{ __html: BETA_UNREAD }} />
        </head>
      )}
      <body>
        <ThemeTransitions />
        <Insight />
        {children}
      </body>
    </html>
  )
}
