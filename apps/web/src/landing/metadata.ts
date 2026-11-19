// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import type { Metadata } from 'next'

/**
 * The landing page's title and description, for both its routes.
 * "Minecraft" is what people search for and read first; it is never the first word of the name.
 * One address for the page, however a link to it was tagged (`?utm_source=…`), and whichever form
 * it was sent in.
 */
export function landingMetadata(): Metadata {
  const title = 'Cubepals · Minecraft server hosting for friends, Java and Bedrock'
  const description =
    'Minecraft server hosting for friends on PC, phones and tablets. Send them the address and they’re in, whenever they like. Start with a free trial, no card needed.'
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: { siteName: 'Cubepals', type: 'website', title, description, url: '/' },
    twitter: { card: 'summary_large_image', title, description },
  }
}
