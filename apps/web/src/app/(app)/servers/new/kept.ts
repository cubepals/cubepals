// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PARTY_SIZES, type PartySize, type SetupSourceInput } from '@blockly/contracts'

/**
 * Paying for it comes back here with the choice, the group and a region picked by hand as they
 * were, and bringing a world (`world/page.tsx`) comes back with the world. The name stays out: the
 * return address goes to the payment provider, and what someone typed is theirs.
 */
export function keptPath(from: SetupSourceInput | null, chosenSize: PartySize | null, region: string | null) {
  const kept = new URLSearchParams()
  if (from?.kind === 'template') kept.set('template', from.key)
  if (from?.kind === 'template' && from.gameVersion !== undefined) kept.set('version', from.gameVersion)
  if (from?.kind === 'modpack') kept.set('pack', from.projectId)
  if (from?.kind === 'curated') kept.set('curated', from.key)
  if (from?.kind === 'import') kept.set('import', from.importId)
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
  const curated = search.get('curated')
  if (curated !== null) return { kind: 'curated', key: curated }
  const pack = search.get('pack')
  if (pack !== null) return { kind: 'modpack', projectId: pack }
  const upload = search.get('import')
  if (upload !== null) return { kind: 'import', importId: upload }
  const world = search.get('world')
  return world === null ? null : { kind: 'world', importId: world }
}
