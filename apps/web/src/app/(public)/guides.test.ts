// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the review step each guide goes through: an unapproved one
 * is a 404 in production, noindex elsewhere, and left out of the index and the footers.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { UNLISTED } from '../../lib/site.ts'
import { guideMetadata } from './guides/article.tsx'
import {
  draftGuides,
  footerGuides,
  GUIDES,
  type Guide,
  guidesIndexLive,
  liveGuide,
  publishedGuides,
} from './guides.ts'

const was = process.env.WEB_INDEXABLE
afterEach(() => {
  if (was === undefined) delete process.env.WEB_INDEXABLE
  else process.env.WEB_INDEXABLE = was
})
const production = () => {
  process.env.WEB_INDEXABLE = '1'
}
const preview = () => {
  delete process.env.WEB_INDEXABLE
}

/** Runs `check` with one guide's approval flipped, putting it back after. */
function withApproval(guide: Guide, approved: boolean, check: () => void) {
  const before = guide.approved
  ;(guide as { approved: boolean }).approved = approved
  try {
    check()
  } finally {
    ;(guide as { approved: boolean }).approved = before
  }
}

const first = GUIDES[0] as Guide

describe('guides', () => {
  test('are the plan’s eight how-to guides and the game modes, and no comparison', () => {
    expect(GUIDES.map((guide) => guide.slug)).toEqual([
      'minecraft-server-for-friends',
      'play-minecraft-java-with-friends',
      'minecraft-server-cost',
      'minecraft-server-that-sleeps',
      'minecraft-server-ram',
      'minecraft-server-without-port-forwarding',
      'play-a-modpack-with-friends',
      'minecraft-server-uk-europe',
      'lifesteal-manhunt-skyblock-with-friends',
    ])
    for (const guide of GUIDES) {
      expect(guide.description.length).toBeLessThanOrEqual(155)
      expect(`${guide.title} · Cubepals`.length).toBeLessThanOrEqual(70)
    }
  })

  test('each has its page, which production serves once the guide is approved', async () => {
    production()
    for (const guide of GUIDES) {
      const page = await import(`./guides/${guide.slug}/page.tsx`)
      if (guide.approved) expect(page.generateMetadata().alternates?.canonical).toBe(`/guides/${guide.slug}`)
      else expect(() => page.generateMetadata()).toThrow()
    }
  })
})

describe('an unapproved guide', () => {
  test('is a 404 in production', () => {
    production()
    withApproval(first, false, () => {
      expect(() => liveGuide(first.slug)).toThrow()
      expect(() => guideMetadata(first.slug)).toThrow()
    })
  })

  test('can be read off production, but says noindex', () => {
    preview()
    withApproval(first, false, () => {
      expect(liveGuide(first.slug)).toBe(first)
      expect(guideMetadata(first.slug).robots).toEqual(UNLISTED)
    })
  })

  test('is left out of the index and the footers everywhere, and listed as a draft only off production', () => {
    withApproval(first, false, () => {
      for (const where of [production, preview]) {
        where()
        expect(publishedGuides()).not.toContain(first)
        expect(footerGuides()).not.toContain(first)
      }
      production()
      expect(draftGuides()).toEqual([])
      preview()
      expect(draftGuides()).toContain(first)
    })
  })

  test('leaves production with no /guides until a guide is approved', () => {
    production()
    expect(guidesIndexLive()).toBe(GUIDES.some((guide) => guide.approved))
    preview()
    expect(guidesIndexLive()).toBe(true)
  })
})

describe('an approved guide', () => {
  test('is live in production, indexable, in the index, and in the footers if it is one of theirs', () => {
    production()
    withApproval(first, true, () => {
      expect(liveGuide(first.slug)).toBe(first)
      expect(guideMetadata(first.slug).robots).toBeUndefined()
      expect(guideMetadata(first.slug).alternates?.canonical).toBe(`/guides/${first.slug}`)
      expect(publishedGuides()).toContain(first)
      expect(footerGuides()).toContain(first)
      expect(guidesIndexLive()).toBe(true)
    })
  })

  test('only the first how-to guides are in the footers', () => {
    production()
    const ram = GUIDES.find((guide) => guide.slug === 'minecraft-server-ram') as Guide
    withApproval(ram, true, () => expect(footerGuides()).not.toContain(ram))
  })
})
