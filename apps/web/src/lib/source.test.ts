import { describe, expect, test } from 'bun:test'
import { sourceOf, withSource } from './source.ts'

const only = (source: string) => ({ source, medium: null, campaign: null, content: null, term: null })

// Where an account came from rides on the links into sign-up, never on a cookie.
describe('where someone came from', () => {
  test('utm_source first, then ref, only as a short plain word', () => {
    expect(sourceOf({ utm_source: 'Reddit', ref: 'discord' })).toEqual(only('reddit'))
    expect(sourceOf({ ref: 'yt.creator_1' })).toEqual(only('yt.creator_1'))
    expect(sourceOf({ ref: ['discord', 'x'] })).toEqual(only('discord'))
    expect(sourceOf({ ref: '<script>' })).toBeNull()
    expect(sourceOf({ ref: 'a'.repeat(41) })).toBeNull()
    expect(sourceOf({})).toBeNull()
  })

  test('a campaign keeps its medium, name, content and term, each only as a plain word', () => {
    expect(
      sourceOf({
        utm_source: 'tiktok',
        utm_medium: 'Paid',
        utm_campaign: 'launch-test+oct',
        utm_content: 'clip_2',
        utm_term: '<b>',
      }),
    ).toEqual({
      source: 'tiktok',
      medium: 'paid',
      campaign: 'launch-test+oct',
      content: 'clip_2',
      term: null,
    })
    // Tags without a source say nothing about where someone came from.
    expect(sourceOf({ utm_campaign: 'launch' })).toBeNull()
  })

  test('carried on a path without disturbing what is already there', () => {
    expect(withSource('/servers/new', only('reddit'))).toBe('/servers/new?ref=reddit')
    expect(withSource('/servers/new?template=survival', only('reddit'))).toBe(
      '/servers/new?template=survival&ref=reddit',
    )
    expect(withSource('/servers', { ...only('tiktok'), campaign: 'launch' })).toBe(
      '/servers?ref=tiktok&utm_campaign=launch',
    )
    expect(withSource('/servers', null)).toBe('/servers')
  })
})
