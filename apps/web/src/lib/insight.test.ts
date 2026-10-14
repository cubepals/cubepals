// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a browser event carries on its way to PostHog: its environment, addresses cut to path and
 * campaign tags, and whether it is ours.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { ownEmail } from '@blockly/contracts'
import { asCode, ENVIRONMENT, rememberOurs, signedInAs, stamped } from './insight'

// Every event the browser sends passes through `stamped` on its way out (posthog-js's
// before_send): pageviews, web vitals, autocaptured errors and the ones boundaries report.
describe('browser events', () => {
  test('each carries the environment that built the page, and no address', () => {
    for (const event of ['$pageview', '$pageleave', '$web_vitals', '$exception']) {
      const out = stamped({
        event,
        properties: { $current_url: '/servers', $ip: '203.0.113.9', environment: 'x' },
      })
      expect(out?.properties as Record<string, unknown>).toEqual({
        $current_url: '/servers',
        environment: ENVIRONMENT,
      })
    }
    expect(ENVIRONMENT).toBe('development')
    expect(stamped(null)).toBeNull()
  })

  // A refusal's code can come from an address anyone types (a provider's `?error=`).
  test('a code a step carries is a code, or other', () => {
    expect(asCode('USER_ALREADY_EXISTS')).toBe('user_already_exists')
    expect(asCode('limit_reached')).toBe('limit_reached')
    expect(asCode('steve@example.com')).toBe('other')
    expect(asCode('That email is taken')).toBe('other')
    expect(asCode(null)).toBe('other')
  })

  test('page addresses leave without their query, so an email in one never does', () => {
    const out = stamped({
      event: '$pageview',
      properties: {
        $current_url: 'https://cubepals.com/check-email?email=steve%40example.test',
        $referrer: 'https://example.test/path?token=abc#top',
        $prev_pageview_url: 'https://cubepals.com/sign-up',
        utm_source: 'news',
      },
    })
    expect(out?.properties.$current_url).toBe('https://cubepals.com/check-email')
    expect(out?.properties.$referrer).toBe('https://example.test/path')
    expect(out?.properties.$prev_pageview_url).toBe('https://cubepals.com/sign-up')
    expect(out?.properties.utm_source).toBe('news')
    expect(JSON.stringify(out)).not.toContain('example.test?')
    expect(JSON.stringify(out)).not.toContain('steve')
  })

  test('campaign tags stay on a page address', () => {
    const tagged =
      'https://cubepals.com/?utm_source=news&utm_medium=email&utm_campaign=launch_2026&utm_content=hero-a&utm_term=minecraft.server'
    const out = stamped({ event: '$pageview', properties: { $current_url: tagged } })
    expect(out?.properties.$current_url).toBe(tagged)
  })

  test('every other query key is dropped, and the tags are kept', () => {
    const out = stamped({
      event: '$pageview',
      properties: {
        $current_url: 'https://cubepals.com/check-email?email=steve%40example.test&utm_source=news&token=abc',
        $referrer: 'https://example.test/path?session=xyz',
      },
    })
    expect(out?.properties.$current_url).toBe('https://cubepals.com/check-email?utm_source=news')
    expect(out?.properties.$referrer).toBe('https://example.test/path')
    expect(JSON.stringify(out)).not.toContain('steve')
    expect(JSON.stringify(out)).not.toContain('abc')
  })

  test('the fragment is dropped, tags or not', () => {
    const out = stamped({
      event: '$pageview',
      properties: {
        $current_url: 'https://cubepals.com/pricing?utm_source=news#access_token=secret',
        $prev_pageview_url: 'https://cubepals.com/sign-in#utm_source=news',
      },
    })
    expect(out?.properties.$current_url).toBe('https://cubepals.com/pricing?utm_source=news')
    expect(out?.properties.$prev_pageview_url).toBe('https://cubepals.com/sign-in')
  })

  test('a ref is kept, on the address and as its own property', () => {
    const out = stamped({
      event: '$pageview',
      properties: { $initial_referrer: 'https://cubepals.com/?ref=friend_42&other=1', ref: 'friend_42' },
    })
    expect(out?.properties.$initial_referrer).toBe('https://cubepals.com/?ref=friend_42')
    expect(out?.properties.ref).toBe('friend_42')
  })

  test('a tag whose value is long or more than a code is dropped, not sent', () => {
    const long = 'a'.repeat(65)
    const longest = 'b'.repeat(64)
    const out = stamped({
      event: '$pageview',
      properties: {
        $current_url: `https://cubepals.com/?utm_source=steve%40example.test&utm_medium=${long}&utm_campaign=a+b&ref=&utm_term=${longest}`,
        utm_source: 'steve@example.test',
        utm_medium: long,
        ref: 'two words',
        utm_term: longest,
      },
    })
    expect(out?.properties.$current_url).toBe(`https://cubepals.com/?utm_term=${longest}`)
    expect(out?.properties).not.toHaveProperty('utm_source')
    expect(out?.properties).not.toHaveProperty('utm_medium')
    expect(out?.properties).not.toHaveProperty('ref')
    expect(out?.properties.utm_term).toBe(longest)
    expect(JSON.stringify(out)).not.toContain('steve')
  })
})

// Our own visits are marked so every count can leave them out; a player's read as they always have.
describe('our own traffic', () => {
  const page = (): Record<string, unknown> | undefined =>
    stamped({ event: '$pageview', properties: { $current_url: '/servers' } })?.properties
  const kept = new Map<string, string>()
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  }

  afterEach(() => {
    signedInAs(false)
    kept.clear()
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  test('a player’s events carry no mark, not even false, with storage or without', () => {
    expect(page()).not.toHaveProperty('internal')
    Object.assign(globalThis, { localStorage: storage })
    expect(page()).not.toHaveProperty('internal')
  })

  test('an account of ours marks what this page sends, and only while it is signed in', () => {
    signedInAs(true)
    expect(page()?.internal).toBe(true)
    signedInAs(false)
    expect(page()).not.toHaveProperty('internal')
  })

  test('a browser that opened an admin page stays ours after signing out, until its storage is cleared', () => {
    Object.assign(globalThis, { localStorage: storage })
    rememberOurs()
    expect(page()?.internal).toBe(true)
    kept.clear()
    expect(page()).not.toHaveProperty('internal')
  })

  test('without storage, remembering does nothing and throws nothing', () => {
    expect(() => rememberOurs()).not.toThrow()
    expect(page()).not.toHaveProperty('internal')
  })

  test('our own domain is ours, under it too, and nobody else’s is', () => {
    expect(ownEmail('sre-check-1@cubepals.com')).toBe(true)
    expect(ownEmail('Someone@Staff.Cubepals.com')).toBe(true)
    expect(ownEmail('steve@example.test')).toBe(false)
    expect(ownEmail('steve@notcubepals.com')).toBe(false)
    expect(ownEmail('cubepals.com@example.test')).toBe(false)
  })
})
