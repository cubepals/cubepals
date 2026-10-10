// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  distributionFor,
  installable,
  judgeLicences,
  type LicenceReview,
  licenceKind,
  newerRelease,
  nextState,
  obligations,
  offeredRelease,
  parseReleaseRef,
  type ReleaseState,
  type ReviewedWork,
  releaseRef,
} from './curation.ts'

const work = (name: string, licence: string | null, projectId: string | null = name): ReviewedWork => ({
  name,
  project: projectId === null ? null : { catalog: 'modrinth', projectId },
  licence,
})

describe('a release by name', () => {
  test('a reference is the pack and its exact version, and reads back', () => {
    const ref = releaseRef({ key: 'adrenaserver', version: '1.7.0+1.21.1.fabric' })
    expect(ref).toBe('adrenaserver@1.7.0+1.21.1.fabric')
    expect(parseReleaseRef(ref)).toEqual({ key: 'adrenaserver', version: '1.7.0+1.21.1.fabric' })
  })

  test('a mutable name, or anything that could name two things, is no reference', () => {
    // A pack without a version is exactly what a server must never pin.
    expect(parseReleaseRef('adrenaserver')).toBeNull()
    for (const text of [
      'Adrenaserver@1.0',
      '-pack@1.0',
      'pack@',
      '@1.0',
      'pack@1.0@2',
      'pack@../1',
      'pack@1 0',
    ])
      expect(parseReleaseRef(text)).toBeNull()
  })
})

describe('licences', () => {
  test('each identifier is read for what a paid product may do with a copy', () => {
    expect(licenceKind('MIT')).toBe('open')
    expect(licenceKind('Apache-2.0')).toBe('open')
    expect(licenceKind('CC0-1.0')).toBe('open')
    expect(licenceKind('LGPL-3.0-only')).toBe('copyleft')
    expect(licenceKind('MPL-2.0')).toBe('copyleft')
    expect(licenceKind('GPL-3.0-or-later')).toBe('copyleft')
    expect(licenceKind('CC-BY-NC-4.0')).toBe('noncommercial')
    expect(licenceKind('CC-BY-NC-SA-4.0')).toBe('noncommercial')
    expect(licenceKind('PolyForm-Noncommercial-1.0.0')).toBe('noncommercial')
    expect(licenceKind('LicenseRef-All-Rights-Reserved')).toBe('reserved')
    // A licence of the author's own says nothing until someone reads it.
    expect(licenceKind('LicenseRef-Polyform-Shield-1.0.0')).toBe('custom')
    expect(licenceKind('LicenseRef-Custom')).toBe('custom')
    expect(licenceKind(null)).toBe('unknown')
    expect(licenceKind('  ')).toBe('unknown')
  })

  test('an expression binds every part it joins with AND, and offers the choice it joins with OR', () => {
    expect(licenceKind('MIT AND CC-BY-4.0')).toBe('open')
    expect(licenceKind('MIT AND LGPL-3.0-only')).toBe('copyleft')
    expect(licenceKind('MIT AND LicenseRef-All-Rights-Reserved')).toBe('reserved')
    expect(licenceKind('GPL-3.0-only OR MIT')).toBe('open')
    // An exception only ever adds to the licence it follows.
    expect(licenceKind('GPL-3.0-only WITH Classpath-exception-2.0')).toBe('copyleft')
    // Brackets are for a person to read, not for a pattern to guess at.
    expect(licenceKind('(MIT OR Apache-2.0) AND LicenseRef-Custom')).toBe('custom')
  })

  test('a copy owes its notices, and copyleft its source too', () => {
    expect(obligations('open')).toEqual(['notices'])
    expect(obligations('copyleft')).toEqual(['notices', 'source'])
    expect(obligations('reserved')).toEqual([])
  })
})

describe('what a pack’s licences allow', () => {
  // Adrenaserver 1.7.0 as Modrinth declared each of its files on 2026-09-27.
  const adrenaserver: LicenceReview = {
    pack: work('Adrenaserver', 'MIT'),
    files: [
      work('C2ME', 'MIT'),
      work('Fabric API', 'Apache-2.0'),
      work('Lithium', 'LGPL-3.0-only'),
      work('Krypton', 'LGPL-3.0-only'),
    ],
  }
  // The shape of Cobblemon's official pack: an open pack carrying all-rights-reserved mods.
  const cobblemon: LicenceReview = {
    pack: work('Cobblemon Official Modpack', 'MPL-2.0'),
    files: [work('Cobblemon', 'MPL-2.0'), work('Balm', 'LicenseRef-All-Rights-Reserved')],
  }

  test('a pack whose every file may be copied may be mirrored, owing notices and sources', () => {
    const verdict = judgeLicences(adrenaserver)
    expect(verdict.mirror.allowed).toBe(true)
    expect(verdict.upstream.allowed).toBe(true)
    expect(verdict.mirror.obligations.find((o) => o.name === 'Lithium')?.owes).toEqual(['notices', 'source'])
    expect(verdict.mirror.obligations.find((o) => o.name === 'C2ME')?.owes).toEqual(['notices'])
  })

  test('an open pack licence says nothing about the mods inside it', () => {
    // The pack's author can licence their own files, never someone else's mod.
    const verdict = judgeLicences(cobblemon)
    expect(verdict.mirror.allowed).toBe(false)
    expect(verdict.mirror.blockers).toEqual([
      { name: 'Balm', licence: 'LicenseRef-All-Rights-Reserved', because: 'reserved' },
    ])
    // Fetched from its authors, nothing of Balm's is copied: the server runs it as a launcher does.
    expect(verdict.upstream.allowed).toBe(true)
  })

  test('the author’s written permission lifts what their licence withholds, as far as it grants', () => {
    const mirror = judgeLicences(
      cobblemon,
      [],
      [{ catalog: 'modrinth', projectId: 'Balm', grants: 'mirror', evidence: 'docs#balm' }],
    )
    expect(mirror.mirror.allowed).toBe(true)
    const offerOnly = judgeLicences(
      cobblemon,
      [],
      [{ catalog: 'modrinth', projectId: 'Balm', grants: 'upstream', evidence: 'docs#balm' }],
    )
    expect(offerOnly.mirror.allowed).toBe(false)
    // A permission names a project; a file no catalog publishes can't be matched to one.
    const carried = judgeLicences(
      { pack: work('Pack', 'MIT'), files: [work('extra.jar', null, null)] },
      [],
      [{ catalog: 'modrinth', projectId: 'extra.jar', grants: 'mirror', evidence: 'docs#x' }],
    )
    expect(carried.mirror.blockers).toEqual([{ name: 'extra.jar', licence: null, because: 'unread' }])
  })

  test('a licence of its own is blocked until a reviewer reads it, then taken as read', () => {
    const review: LicenceReview = { pack: work('Simply Optimized', 'LicenseRef-WTFPL'), files: [] }
    expect(judgeLicences(review).mirror.blockers[0]?.because).toBe('unread')
    expect(judgeLicences(review).upstream.allowed).toBe(false)
    const read = judgeLicences(review, [
      { licence: 'LicenseRef-WTFPL', reads: 'open', evidence: 'docs#wtfpl' },
    ])
    expect(read.mirror.allowed).toBe(true)
    expect(read.upstream.allowed).toBe(true)
  })

  test('a licence of its own on something a server runs is read before the pack is offered at all', () => {
    // Fzzy Config's TDL-M 1.3: "You may not distribute this software", but a pack may include it
    // "via a manifest which would download this software from its respective ... Modrinth page".
    const review: LicenceReview = {
      pack: work('Adrenaline', 'MIT'),
      files: [work('Fzzy Config', 'LicenseRef-TDL-M'), work('Lithium', 'LGPL-3.0-only')],
    }
    expect(judgeLicences(review).upstream.blockers).toEqual([
      { name: 'Fzzy Config', licence: 'LicenseRef-TDL-M', because: 'unread' },
    ])
    const read = judgeLicences(review, [
      { licence: 'LicenseRef-TDL-M', reads: 'reserved', evidence: 'docs#tdl-m' },
    ])
    expect(read.upstream.allowed).toBe(true)
    expect(read.mirror.blockers).toEqual([
      { name: 'Fzzy Config', licence: 'LicenseRef-TDL-M', because: 'reserved' },
    ])
    // A file only the pack carries has no publisher to read a licence from: unread until someone does.
    const carried = judgeLicences({ pack: work('Pack', 'MIT'), files: [work('extra.jar', null, null)] })
    expect(carried.upstream.blockers).toEqual([{ name: 'extra.jar', licence: null, because: 'unread' }])
  })

  test('nothing noncommercial stands in a paid product, however it is fetched', () => {
    const review: LicenceReview = {
      pack: work('Pack', 'MIT'),
      files: [work('Shaders', 'CC-BY-NC-4.0'), work('Map', 'LicenseRef-All-Rights-Reserved')],
    }
    const verdict = judgeLicences(review)
    expect(verdict.upstream.blockers).toEqual([
      { name: 'Shaders', licence: 'CC-BY-NC-4.0', because: 'noncommercial' },
    ])
    expect(verdict.mirror.blockers.map((b) => b.because)).toEqual(['noncommercial', 'reserved'])
  })

  test('an all-rights-reserved pack is offered only with its author’s permission', () => {
    const review: LicenceReview = { pack: work('Better MC', 'LicenseRef-All-Rights-Reserved'), files: [] }
    expect(judgeLicences(review).upstream.blockers).toEqual([
      { name: 'Better MC', licence: 'LicenseRef-All-Rights-Reserved', because: 'reserved' },
    ])
    const granted = judgeLicences(
      review,
      [],
      [{ catalog: 'modrinth', projectId: 'Better MC', grants: 'upstream', evidence: 'docs#bmc' }],
    )
    expect(granted.upstream.allowed).toBe(true)
  })

  test('a release gets the distribution its review asked for, or is refused with what stands in the way', () => {
    const open = judgeLicences(adrenaserver)
    const mixed = judgeLicences(cobblemon)
    expect(distributionFor(open, 'mirror', true)).toEqual({ distribution: 'mirror' })
    // No store to keep copies in: still legal to offer, so offered from upstream.
    expect(distributionFor(open, 'mirror', false)).toEqual({ distribution: 'upstream' })
    expect(distributionFor(open, 'upstream', true)).toEqual({ distribution: 'upstream' })
    expect(distributionFor(mixed, 'upstream', true)).toEqual({ distribution: 'upstream' })
    // A review that asked for a mirror its licences don't allow is for a person, not a fallback.
    expect(distributionFor(mixed, 'mirror', true)).toEqual({ refused: mixed.mirror.blockers })
  })
})

describe('a release’s life', () => {
  test('checked once, it stays checked; published and withdrawn move both ways; refused can try again', () => {
    expect(nextState('pending', 'verified')).toBe('verified')
    expect(nextState('pending', 'refused')).toBe('refused')
    expect(nextState('refused', 'retry')).toBe('pending')
    expect(nextState('verified', 'publish')).toBe('published')
    expect(nextState('published', 'withdraw')).toBe('withdrawn')
    expect(nextState('withdrawn', 'publish')).toBe('published')
    expect(nextState('published', 'retry')).toBeNull()
    expect(nextState('verified', 'refused')).toBeNull()
    expect(nextState('pending', 'publish')).toBeNull()
  })

  test('withdrawing takes a release from new servers, never from the ones that play it', () => {
    expect(installable('withdrawn')).toBe(true)
    expect(installable('published')).toBe(true)
    expect(installable('pending')).toBe(false)
    expect(installable('refused')).toBe(false)
  })

  test('new servers get the newest published release; a server is offered only newer ones', () => {
    const order = ['3.0', '2.0', '1.0']
    const releases: Array<{ version: string; state: ReleaseState }> = [
      { version: '3.0', state: 'refused' },
      { version: '2.0', state: 'published' },
      { version: '1.0', state: 'withdrawn' },
    ]
    expect(offeredRelease(order, releases)?.version).toBe('2.0')
    expect(newerRelease(order, releases, '1.0')?.version).toBe('2.0')
    expect(newerRelease(order, releases, '2.0')).toBeNull()
    expect(newerRelease(order, releases, 'unknown')).toBeNull()
    expect(offeredRelease(order, [])).toBeNull()
  })
})
