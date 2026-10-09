import { describe, expect, test } from 'bun:test'
import { isNightly, latestStable, nextVersion, nightlyTag } from './versions.ts'

describe('versions', () => {
  test('the first production deploy is 0.1.0, and each after it is the newest patch plus one', () => {
    expect(nextVersion([])).toBe('0.1.0')
    expect(nextVersion(['v0.1.0', 'v0.1.9', 'v0.1.10', 'v0.1.2'])).toBe('0.1.11')
  })

  test('nightlies and other tags never count as a production version', () => {
    const tags = ['v0.1.3', 'v0.1.4-nightly.20261009.12', 'v9.9.9-rc.1', 'release', 'v1.0']
    expect(latestStable(tags)).toBe('v0.1.3')
    expect(nextVersion(tags)).toBe('0.1.4')
  })

  test('a nightly is the next version, its UTC day and its run', () => {
    const tag = nightlyTag(['v0.1.3'], new Date('2026-10-09T23:30:00Z'), 12)
    expect(tag).toBe('v0.1.4-nightly.20261009.12')
    expect(isNightly(tag)).toBe(true)
    expect(isNightly('v0.1.4')).toBe(false)
  })
})
