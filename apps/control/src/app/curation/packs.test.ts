import { describe, expect, test } from 'bun:test'
import { isPackKey, isReleaseVersion, licenceKind } from '../../domain/mods/curation.ts'
import { CURATED_PACKS } from './packs.ts'

// The review itself (docs/modpack-templates.md): what it pins must be exact, and what it says to
// people must be in their words. Ingestion checks the bytes; this checks the review is well formed.
describe('the review of packs Blockly offers by name', () => {
  test('every pack has a key of its own, and every release an exact pin', () => {
    const keys = CURATED_PACKS.map((pack) => pack.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const pack of CURATED_PACKS) {
      expect(isPackKey(pack.key)).toBe(true)
      expect(pack.releases.length).toBeGreaterThan(0)
      const versions = pack.releases.map((release) => release.version)
      expect(new Set(versions).size).toBe(versions.length)
      for (const release of pack.releases) {
        expect(isReleaseVersion(release.version)).toBe(true)
        // The bytes, not a name that could come to mean other bytes.
        expect(release.sha512).toMatch(/^[0-9a-f]{128}$/)
        expect(release.versionId.length).toBeGreaterThan(0)
        expect(Number.isInteger(release.sizeBytes) && release.sizeBytes > 0).toBe(true)
      }
      const ids = pack.releases.map((release) => release.versionId)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('every reading and permission says where its evidence is, and a review is written up', () => {
    for (const pack of CURATED_PACKS) {
      expect(pack.review).toMatch(/^docs\/modpack-templates\.md#[a-z0-9-]+$/)
      for (const reading of pack.readings) {
        expect(reading.evidence).toMatch(/^docs\/modpack-templates\.md#/)
        // A reading is for what an identifier can't settle; a known licence needs none.
        expect(licenceKind(reading.licence)).toBe('custom')
      }
      for (const permission of pack.permissions)
        expect(permission.evidence).toMatch(/^docs\/modpack-templates\.md#/)
    }
  })

  test('each pack is described as what playing it is, in a person’s words', () => {
    for (const pack of CURATED_PACKS) {
      expect(pack.name.length).toBeGreaterThan(2)
      expect(pack.authors.length).toBeGreaterThan(1)
      expect(pack.blurb).toMatch(/\.$/)
      expect(pack.blurb.length).toBeLessThanOrEqual(80)
      // A hold is read by the admin it stops: a whole sentence, saying what to settle.
      if (pack.held !== undefined) expect(pack.held).toMatch(/^[A-Z].+\.$/)
      // Nothing on a card names a loader, a build or a mod list: the pack brings those.
      for (const word of ['loader', 'fabric', 'forge', 'modrinth', 'curseforge'])
        expect(pack.blurb.toLowerCase()).not.toContain(word)
    }
  })
})
