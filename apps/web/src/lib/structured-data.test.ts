/**
 * Tests for the markup's shape: every price from the plan
 * table, and nothing made up.
 */
import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { appSchema, guideSchema, jsonLd, siteSchema } from './structured-data.tsx'

const plan = (over: Partial<PublicPlan>): PublicPlan => ({
  key: 'free',
  name: 'Free',
  monthlyPriceCents: 0,
  includedHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  mods: false,
  downloads: 'daily',
  restsAfterDays: 14,
  deletedAfterDays: 365,
  ...over,
})
const PLANS = [
  plan({}),
  plan({
    key: 'plus',
    name: 'Plus',
    monthlyPriceCents: 1500,
    includedHours: 100,
    maxServers: 3,
    maxPlayers: 40,
    mods: true,
  }),
]
const ORIGIN = 'https://cubepals.com'

describe('structured data', () => {
  test('names Cubepals and the site, with no legal name, email or rating made up', () => {
    const [organization, website] = siteSchema(ORIGIN)['@graph']
    expect(organization).toMatchObject({
      '@type': 'Organization',
      '@id': `${ORIGIN}/#organization`,
      name: 'Cubepals',
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/logo.png`,
    })
    expect(organization).not.toHaveProperty('email')
    expect(organization).not.toHaveProperty('legalName')
    expect(website).toMatchObject({ '@type': 'WebSite', publisher: { '@id': `${ORIGIN}/#organization` } })
  })

  test('prices each plan from the table, the paid one by the month', () => {
    const app = appSchema(PLANS, ORIGIN)
    expect(app).toMatchObject({ '@type': 'SoftwareApplication', applicationCategory: 'GameApplication' })
    expect(app).not.toHaveProperty('aggregateRating')
    const [free, plus] = (app as { offers: Record<string, unknown>[] }).offers
    expect(free).toMatchObject({ name: 'Free', price: '0', priceCurrency: 'USD', url: `${ORIGIN}/pricing` })
    expect(free).not.toHaveProperty('priceSpecification')
    expect(free?.description).toBe(
      '1 server, up to 5 players. 20 hours of play each month. Vanilla or Paper. Daily backups and world downloads.',
    )
    expect(plus).toMatchObject({
      name: 'Plus',
      price: '15',
      priceSpecification: { price: '15', referenceQuantity: { value: 1, unitCode: 'MON' } },
    })
  })

  test('leaves offers out rather than publish no price', () => {
    expect(appSchema([], ORIGIN)).not.toHaveProperty('offers')
  })

  test('marks a guide up as an Article under Guides, with the dates it shows', () => {
    const [article, crumbs] = guideSchema(
      {
        title: 'How to make a Minecraft server for friends',
        description: 'Three decisions.',
        published: '2026-10-07',
        modified: '2026-10-08',
        path: '/guides/minecraft-server-for-friends',
      },
      ORIGIN,
    )['@graph']
    expect(article).toMatchObject({
      '@type': 'Article',
      headline: 'How to make a Minecraft server for friends',
      datePublished: '2026-10-07',
      dateModified: '2026-10-08',
      mainEntityOfPage: `${ORIGIN}/guides/minecraft-server-for-friends`,
    })
    expect(crumbs).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Guides', item: `${ORIGIN}/guides` },
        { '@type': 'ListItem', position: 2, name: 'How to make a Minecraft server for friends' },
      ],
    })
  })

  test('can never close its own script tag', () => {
    expect(jsonLd({ name: '</script><script>' })).not.toContain('<')
  })
})
