// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The create page's choice in its own address: what to play, the group and the region, kept across
 * paying for it and across bringing a world (`world/page.tsx`), which may bring the pack it was
 * played with. Nothing someone typed is kept: the address goes to the payment provider.
 */
import { PARTY_SIZES, type PackSourceInput, type PartySize, type SetupSourceInput } from '@blockly/contracts'

/**
 * Paying for it comes back here with the choice, the group and a region picked by hand as they
 * were, and bringing a world (`world/page.tsx`) comes back with the world. The name stays out: the
 * return address goes to the payment provider, and what someone typed is theirs.
 */
export function keptPath(from: SetupSourceInput | null, chosenSize: PartySize | null, region: string | null) {
  const kept = new URLSearchParams()
  if (from?.kind === 'template') kept.set('template', from.key)
  if (from?.kind === 'template' && from.gameVersion !== undefined) kept.set('version', from.gameVersion)
  // A world played with mods comes back with the pack it was played with.
  const pack = from?.kind === 'world' ? from.pack : from
  if (pack?.kind === 'modpack') kept.set('pack', pack.projectId)
  if (pack?.kind === 'modpack' && pack.versionId !== undefined) kept.set('packVersion', pack.versionId)
  if (pack?.kind === 'curated') kept.set('curated', pack.key)
  if (pack?.kind === 'curated' && pack.version !== undefined) kept.set('curatedVersion', pack.version)
  if (pack?.kind === 'import') kept.set('import', pack.importId)
  if (from?.kind === 'world') kept.set('world', from.importId)
  if (chosenSize !== null) kept.set('size', chosenSize)
  if (region !== null) kept.set('region', region)
  return `/servers/new?${kept}`
}

/** A choice carried through paying for it, read back from the address the checkout returned to. */
export function keptChoice(search: { get(name: string): string | null }): {
  from: SetupSourceInput | null
  partySize: PartySize | null
  region: string | null
} {
  const size = PARTY_SIZES.find((one) => one === search.get('size')) ?? null
  return { from: keptFrom(search), partySize: size, region: search.get('region') }
}

/** What to play, as `keptPath` wrote it in the address. */
function keptFrom(search: { get(name: string): string | null }): SetupSourceInput | null {
  const template = search.get('template')
  const release = search.get('version')
  if (template !== null)
    return { kind: 'template', key: template, ...(release === null ? {} : { gameVersion: release }) }
  const pack = keptPack(search)
  const world = search.get('world')
  if (world === null) return pack
  return { kind: 'world', importId: world, ...(pack === null ? {} : { pack }) }
}

/** The pack `keptPath` wrote, on its own or as the one a world was played with. */
function keptPack(search: { get(name: string): string | null }): PackSourceInput | null {
  const curated = search.get('curated')
  const release = search.get('curatedVersion')
  if (curated !== null)
    return { kind: 'curated', key: curated, ...(release === null ? {} : { version: release }) }
  const pack = search.get('pack')
  const version = search.get('packVersion')
  if (pack !== null)
    return { kind: 'modpack', projectId: pack, ...(version === null ? {} : { versionId: version }) }
  const upload = search.get('import')
  return upload === null ? null : { kind: 'import', importId: upload }
}
