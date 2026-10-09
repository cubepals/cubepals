import type { Distribution, LicenceReading, Permission } from '../../domain/mods/curation.ts'

/**
 * The packs Blockly offers by name (docs/modpack-templates.md). This file is the review: a pack is
 * here only after someone read its licence, the licences of what it installs on a server, and its
 * authors' terms, and pinned each release to the exact file its authors published. Nothing else
 * becomes a curated pack, and nothing here names a URL: the catalog's adapter knows its hosts, and
 * ingestion (`service.ts`) fetches only the bytes pinned below, from there.
 *
 * Adding a release is a change to this file, reviewed like any other. Offering it is an admin's
 * decision once ingestion has verified it; withdrawing it takes it from new servers, never from
 * the servers that play it.
 */
export interface CuratedPack {
  /** Its name in every reference (`key@version`): never renamed, never reused for another pack. */
  key: string
  /** As its authors call it. */
  name: string
  /** One line of what playing it is, in Blockly's words. */
  blurb: string
  /** Who made it, as they sign their work: the credit shown wherever the pack is. */
  authors: string
  /** Where its reviewed files come from: a project on a catalog, whose adapter knows its hosts. */
  source: { catalog: string; projectId: string }
  /** The most Blockly may do with its files, as the review found (docs/modpack-templates.md § Licences). */
  distribution: Distribution
  /** Licences of their own found in it, as a reviewer read them, with where the deciding words are. */
  readings: readonly LicenceReading[]
  /** Its authors' written permissions, where a licence alone doesn't allow what Blockly does. */
  permissions: readonly Permission[]
  /**
   * Archives the pack carries that no catalog publishes, which the review found to be its own
   * authors' work, under the pack's licence. Anything else it carries unpublished is someone's the
   * review hasn't identified, and holds the pack back until it has.
   */
  authored: readonly string[]
  /** Where the review is written up. */
  review: string
  /**
   * Why no admin may offer it yet, when the review left something to settle first: written
   * permission it still needs, say. Its releases are fetched and checked all the same; lifting the
   * hold is a change to this file, reviewed like the rest.
   */
  held?: string
  /** Its releases, newest first, each the exact file its authors published. */
  releases: readonly CuratedReleaseSpec[]
}

export interface CuratedReleaseSpec {
  /** As its authors number it; with the key, the release's name. */
  version: string
  /** The catalog's own id for this version. */
  versionId: string
  /** The file it published, byte for byte: anything else under this version is refused. */
  sha512: string
  sizeBytes: number
}

export const CURATED_PACKS: readonly CuratedPack[] = [
  {
    key: 'skyblock-plus',
    name: 'SkyBlock Plus',
    blurb: 'Start on one small island over the void, and grow it into a world.',
    authors: 'BPR02',
    source: { catalog: 'modrinth', projectId: 'cJJdkNYP' },
    // Apache-2.0 itself, and every mod it puts on a server MIT, Apache-2.0 or GPL-3.0 (2026-09-27).
    distribution: 'mirror',
    readings: [],
    permissions: [],
    authored: [],
    review: 'docs/modpack-templates.md#skyblock-plus',
    releases: [
      {
        version: '1.0.9',
        versionId: 'Nte4eTsy',
        sha512:
          '94df2dd6ce119bda726ac4ebf98ffa357190920c0375f4cc7519a2d0290fd7a8cb3f2a8c3b5c52126e0d188a2fe7a53a49cebf0b34a5d06e9078929f518c0076',
        sizeBytes: 1869,
      },
    ],
  },
  {
    key: 'cobblemon',
    name: 'Cobblemon',
    blurb: 'Catch, raise and battle creatures across a world full of them.',
    authors: 'Cobbled Studios',
    source: { catalog: 'modrinth', projectId: '5FFgwNNP' },
    // MPL-2.0 itself, but it installs all-rights-reserved mods (Balm, Crafting Tweaks,
    // NetherPortalFix and more), which only their authors publish: servers fetch them from there.
    distribution: 'upstream',
    readings: [
      // FancyMenu: "You may not re-upload, re-distribute, mirror ..." (§3.1), and a launcher may
      // download it "as long as the mod is obtained from the official download sources" (§5.1).
      { licence: 'LicenseRef-DSMSLv3.1', reads: 'reserved', evidence: 'docs/modpack-templates.md#dsmsl' },
    ],
    permissions: [],
    // Loading-screen tips the pack's own authors wrote (`assets/cobblemontips`, "Adds Cobblemon
    // loading screen tips."), carried for Open Loader.
    authored: ['overrides/config/openloader/resources/Cobblemon-Tips-3.0.zip'],
    review: 'docs/modpack-templates.md#cobblemon',
    held: 'Xaero’s Minimap and World Map run on its servers, and Xaero allows a pack to be monetized only through CurseForge or Modrinth without his written permission. Ask him, and Cobbled Studios, first.',
    releases: [
      {
        version: '1.8.1',
        versionId: 'Cqimd3JM',
        sha512:
          'ae2429fd6ffd7ef00f19e0f8fa0121e2f24c81bd73786ae03c2b0337e3d99b916a10017b6f4aea145bcfa17562330d2e69e5c1a2caf623fa95b8e9cfb48ca928',
        sizeBytes: 100909813,
      },
    ],
  },
]

/** A pack by its key, from the review. */
export const curatedPack = (key: string, packs: readonly CuratedPack[] = CURATED_PACKS): CuratedPack | null =>
  packs.find((pack) => pack.key === key) ?? null
