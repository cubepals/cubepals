import { PARTY_SIZES, type PartySize, type SetupSourceInput } from '@blockly/contracts'

/**
 * Paying for it comes back here with the choice, the group and a region picked by hand as they
 * were. The name stays out: the return address goes to the payment provider, and what someone
 * typed is theirs.
 */
export function keptPath(from: SetupSourceInput | null, chosenSize: PartySize | null, region: string | null) {
  const kept = new URLSearchParams()
  if (from?.kind === 'template') kept.set('template', from.key)
  if (from?.kind === 'template' && from.gameVersion !== undefined) kept.set('version', from.gameVersion)
  if (from?.kind === 'modpack') kept.set('pack', from.projectId)
  if (from?.kind === 'curated') kept.set('curated', from.key)
  if (from?.kind === 'import') kept.set('import', from.importId)
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
  const template = search.get('template')
  const release = search.get('version')
  const pack = search.get('pack')
  const curated = search.get('curated')
  const upload = search.get('import')
  const size = PARTY_SIZES.find((one) => one === search.get('size')) ?? null
  return {
    from:
      template !== null
        ? { kind: 'template', key: template, ...(release === null ? {} : { gameVersion: release }) }
        : curated !== null
          ? { kind: 'curated', key: curated }
          : pack !== null
            ? { kind: 'modpack', projectId: pack }
            : upload !== null
              ? { kind: 'import', importId: upload }
              : null,
    partySize: size,
    region: search.get('region'),
  }
}
