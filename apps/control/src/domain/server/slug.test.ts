import { describe, expect, test } from 'bun:test'
import { checkSlug, slugCandidates, slugFromName } from './slug.ts'

describe('slugs', () => {
  test('names become the slug people expect', () => {
    expect(slugFromName('Sunset Valley!')).toBe('sunset-valley')
    expect(slugFromName('  Café  Crème ')).toBe('cafe-creme')
    expect(slugFromName('---')).toBe('')
  })

  test('slugs are DNS labels that avoid platform names', () => {
    expect(checkSlug('sunset-valley')).toMatchObject({ ok: true })
    expect(checkSlug('ab')).toEqual({ ok: false, problem: 'too_short' })
    expect(checkSlug('-edge')).toEqual({ ok: false, problem: 'bad_characters' })
    expect(checkSlug('a--b')).toEqual({ ok: false, problem: 'bad_characters' })
    expect(checkSlug('api')).toEqual({ ok: false, problem: 'reserved' })
  })

  test('candidates start with the plain slug and fall back to numbered ones', () => {
    const candidates = slugCandidates('Sunset Valley', () => 0.5)
    expect(candidates[0]).toBe('sunset-valley')
    expect(candidates[1]).toBe('sunset-valley-5500')
    expect(slugCandidates('!!', () => 0)[0]).toBe('world')
  })
})
