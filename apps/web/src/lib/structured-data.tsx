// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the pages tell search engines Cubepals is, as schema.org JSON-LD. Prices come from the same
 * plan table the page shows, so the markup can't disagree with it. Left out until they exist: the
 * operator's legal name, a contact email, and any profile that doesn't resolve yet. No rating or review: Cubepals has none and makes none up.
 */
import type { PublicPlan } from '@blockly/contracts'
import { planPoints } from '../ui/plans'

/** The official profiles that resolved when the markup last changed: Modrinth's. */
const PROFILES = ['https://modrinth.com/user/cubepals']

const DESCRIPTION = 'A Minecraft server that starts when your friends join. For Minecraft: Java Edition.'

/** Who Cubepals is, and the site: on the home page. */
export function siteSchema(origin: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'Cubepals',
        url: `${origin}/`,
        logo: `${origin}/logo.png`,
        sameAs: PROFILES,
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name: 'Cubepals',
        url: `${origin}/`,
        publisher: { '@id': `${origin}/#organization` },
      },
    ],
  }
}

/** The product and what each plan costs: on the home and pricing pages. No offers without a plan table. */
export function appSchema(plans: readonly PublicPlan[], origin: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${origin}/#app`,
    name: 'Cubepals',
    url: `${origin}/`,
    applicationCategory: 'GameApplication',
    operatingSystem: 'Web',
    description: DESCRIPTION,
    publisher: { '@id': `${origin}/#organization` },
    ...(plans.length === 0
      ? {}
      : {
          offers: plans.map((plan) => {
            const price = String(plan.monthlyPriceCents / 100)
            return {
              '@type': 'Offer',
              name: plan.name,
              price,
              priceCurrency: 'USD',
              url: `${origin}/pricing`,
              description: `${planPoints(plan).join('. ')}.`,
              ...(plan.monthlyPriceCents === 0
                ? {}
                : {
                    priceSpecification: {
                      '@type': 'UnitPriceSpecification',
                      price,
                      priceCurrency: 'USD',
                      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
                    },
                  }),
            }
          }),
        }),
  }
}

/** A guide, and where it sits under /guides. Its dates are the ones the page shows. */
export function guideSchema(
  guide: { title: string; description: string; published: string; modified: string; path: string },
  origin: string,
) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: guide.title,
        description: guide.description,
        datePublished: guide.published,
        dateModified: guide.modified,
        author: { '@id': `${origin}/#organization` },
        publisher: { '@id': `${origin}/#organization` },
        mainEntityOfPage: `${origin}${guide.path}`,
        image: `${origin}/opengraph-image.png`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Guides', item: `${origin}/guides` },
          { '@type': 'ListItem', position: 2, name: guide.title },
        ],
      },
    ],
  }
}

/** Markup as its script tag holds it: `<` escaped, so no text in it can close the tag. */
export const jsonLd = (schema: object): string => JSON.stringify(schema).replace(/</g, '\\u003c')

/** One piece of markup in the page. Written raw: React would escape the JSON as if it were text. */
export function JsonLd({ schema }: { schema: object }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: our own JSON, with `<` escaped by jsonLd.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(schema) }} />
}
