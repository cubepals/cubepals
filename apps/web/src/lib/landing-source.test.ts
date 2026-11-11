// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a signup came from when its link named no source: the website that sent the tab's first
 * page, never Cubepals itself, and kept from that first page to sign-up.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { OWN_DOMAIN } from '@blockly/contracts'
import { BACK_FROM, forgetLanding, landingSource, noteLanding, withLanding } from './landing-source.ts'

const HERE = OWN_DOMAIN
const landing = (search: string, referrer: string, host = HERE) => ({ search, referrer, host })
const sent = (source: string, medium: string) => ({
  source,
  medium,
  campaign: null,
  content: null,
  term: null,
})

describe('where a visit came from', () => {
  test('the website that sent it, by host, when the address names no source', () => {
    expect(landingSource(landing('', 'https://www.google.com/'))).toEqual(sent('google.com', 'organic'))
    expect(landingSource(landing('', 'https://www.reddit.com/r/admincraft/'))).toEqual(
      sent('reddit.com', 'referral'),
    )
    expect(landingSource(landing('', 'https://m.youtube.com/watch'))).toEqual(sent('youtube.com', 'referral'))
    expect(landingSource(landing('', 'https://chatgpt.com/'))).toEqual(sent('chatgpt.com', 'referral'))
    expect(landingSource(landing('', 'https://www.google.co.uk/'))).toEqual(sent('google.co.uk', 'organic'))
  })

  test('the address’s own source wins over the website that sent it', () => {
    expect(
      landingSource(
        landing('?utm_source=tiktok&utm_medium=paid&utm_campaign=launch', 'https://www.google.com/'),
      ),
    ).toEqual({ ...sent('tiktok', 'paid'), campaign: 'launch' })
    expect(landingSource(landing('?ref=discord', 'https://www.reddit.com/'))).toEqual({
      ...sent('discord', 'referral'),
      medium: null,
    })
  })

  test('Cubepals’ own addresses, and this one, are never a source', () => {
    expect(landingSource(landing('', `https://${OWN_DOMAIN}/pricing`))).toBeNull()
    expect(landingSource(landing('', `https://staging.${OWN_DOMAIN}/`))).toBeNull()
    expect(landingSource(landing('', 'http://localhost:3000/guides', 'localhost'))).toBeNull()
  })

  test('no referrer and no source stays empty, as does one that is not a website', () => {
    expect(landingSource(landing('', ''))).toBeNull()
    expect(landingSource(landing('?utm_campaign=launch', ''))).toBeNull()
    expect(landingSource(landing('', 'android-app://com.google.android.gm/'))).toBeNull()
    expect(landingSource(landing('', 'not an address'))).toBeNull()
  })
})

describe('the first landing in a tab', () => {
  beforeEach(forgetLanding)

  test('is kept across the pages after it, and rides into sign-up', () => {
    noteLanding(landing('', 'https://www.google.com/search'))
    // A later page in the tab came from Cubepals itself, then from somewhere else entirely.
    noteLanding(landing('', `https://${OWN_DOMAIN}/`))
    noteLanding(landing('?utm_source=reddit', 'https://reddit.com/'))
    expect(withLanding('/servers/new')).toBe('/servers/new?ref=google.com&utm_medium=organic')
  })

  test('leaves a path that already carries a source as it is', () => {
    noteLanding(landing('', 'https://www.google.com/'))
    expect(withLanding('/servers/new?ref=discord')).toBe('/servers/new?ref=discord')
  })

  test('adds nothing when the first page had no source', () => {
    noteLanding(landing('', ''))
    noteLanding(landing('', 'https://www.google.com/'))
    expect(withLanding('/servers/new')).toBe('/servers/new')
  })

  test('adds nothing before any page is noted', () => {
    expect(withLanding('/account?get=plus')).toBe('/account?get=plus')
  })

  test('survives a sign-in provider round trip that comes back without an account', () => {
    noteLanding(landing('', 'https://www.reddit.com/r/admincraft/'))
    // Sign-up sends the provider this address to come back to when it is cancelled or fails.
    const back = `${withLanding('/sign-up?next=%2Fservers%2Fnew')}&${BACK_FROM}=google`
    expect(back).toBe(`/sign-up?next=%2Fservers%2Fnew&ref=reddit.com&utm_medium=referral&${BACK_FROM}=google`)
    // The page it comes back to is a new document, whose referrer is the provider.
    forgetLanding()
    noteLanding(landing(new URL(back, `https://${HERE}`).search, 'https://accounts.google.com/'))
    expect(withLanding('/servers/new')).toBe('/servers/new?ref=reddit.com&utm_medium=referral')
  })

  test('takes no source from the provider a round trip came back from', () => {
    expect(landingSource(landing(`?${BACK_FROM}=github`, 'https://github.com/'))).toBeNull()
  })
})
