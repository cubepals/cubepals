// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The create page's question before a choice counts as picked: what the choice would make, the
 * version a template lands on when the one picked for another can't run it, and the answers it
 * asks for ahead so a click finds them already there.
 */
import { describe, expect, test } from 'bun:test'
import type { CreateOptions, SetupPreview, SetupSourceInput } from '@blockly/contracts'
import { refusing } from '@blockly/control/testing/refusing'
import { QueryClient } from '@tanstack/react-query'
import { failedWith } from '../../../../lib/failed-call.ts'
import { choicesAhead, knownPreviewOf, PREVIEW_FRESH_MS, previewOf, previewQuery } from './preview.ts'

/**
 * The control plane as the create page asks it, by what it was asked for: Skyblock runs on 26.2
 * and the 1.21 releases from 1.21.8, not on 1.21.1, as Modrinth listed its plugins on 2026-10-11.
 */
function controlPlane(fails: (from: SetupSourceInput) => Error | null) {
  const asked: SetupSourceInput[] = []
  const trpc = { servers: { setupPreview: { queryOptions: (input: { from: SetupSourceInput }) => input } } }
  const queries = {
    query: async ({ from }: { from: SetupSourceInput }) => {
      asked.push(from)
      const failure = fails(from)
      if (failure !== null) throw failure
      const gameVersion = from.kind === 'template' ? (from.gameVersion ?? '26.2') : '26.2'
      return { from: 'Skyblock', gameVersion } as SetupPreview
    },
  }
  return { asked, queries: queries as never, trpc: trpc as never }
}

const notOn121 = await failedWith(
  refusing(
    'mods_conflict',
    "Cubepals can't run SkyBlock (BSkyBlock) on Minecraft 1.21.1. Skyblock runs on Minecraft 26.2.",
  ),
)
const onlyOn121 = (from: SetupSourceInput) =>
  from.kind === 'template' && from.gameVersion === '1.21.1' ? notOn121 : null

describe('what a choice on the create page would make', () => {
  test('a version picked for another template stays where this one runs on it', async () => {
    const { asked, queries, trpc } = controlPlane(onlyOn121)
    const picked = { kind: 'template', key: 'skyblock', gameVersion: '1.21.11' } as const
    const { source, would } = await previewOf(queries, trpc, picked, '5')
    expect(source).toEqual(picked)
    expect(would.gameVersion).toBe('1.21.11')
    expect(asked).toEqual([picked])
  })

  test('a template that can’t run on the version picked lands on the newest it runs on', async () => {
    // Production, 2026-10-11: a version picked earlier came along, and Skyblock was refused
    // with "can't run SkyBlock (BSkyBlock) on any Minecraft it offers".
    const { asked, queries, trpc } = controlPlane(onlyOn121)
    const { source, would } = await previewOf(
      queries,
      trpc,
      { kind: 'template', key: 'skyblock', gameVersion: '1.21.1' },
      '5',
    )
    expect(source).toEqual({ kind: 'template', key: 'skyblock' })
    expect(would.gameVersion).toBe('26.2')
    expect(asked).toHaveLength(2)
  })

  test('a template whose server type isn’t offered on the version picked lands on the newest too', async () => {
    // Survival picked on 26.3, then Smoother survival: Paper has no build Cubepals offers for 26.3.
    const noPaper = await failedWith(
      refusing('invalid_choice', 'Cubepals doesn’t offer Paper on Minecraft 26.3 yet.'),
    )
    const { source, would } = await previewOf(
      controlPlane((from) => (from.kind === 'template' && from.gameVersion === '26.3' ? noPaper : null))
        .queries,
      controlPlane(() => null).trpc,
      { kind: 'template', key: 'smooth', gameVersion: '26.3' },
      '5',
    )
    expect(source).toEqual({ kind: 'template', key: 'smooth' })
    expect(would.gameVersion).toBe('26.2')
  })

  test('what can’t run at all, or fails another way, is the answer as it came', async () => {
    const nowhere = await failedWith(
      refusing(
        'mods_conflict',
        "Cubepals can't run SkyBlock (BSkyBlock) on any Minecraft it offers right now.",
      ),
    )
    const away = await failedWith(refusing('catalog_unavailable', 'Modrinth isn’t answering right now.'))
    for (const [fails, from] of [
      [nowhere, { kind: 'template', key: 'skyblock' }],
      [away, { kind: 'template', key: 'skyblock', gameVersion: '1.21.1' }],
      [nowhere, { kind: 'modpack', projectId: 'pack' }],
    ] as const) {
      const { asked, queries, trpc } = controlPlane(() => fails)
      await expect(previewOf(queries, trpc, from, '5')).rejects.toBe(fails)
      expect(asked).toEqual([from])
    }
  })
})

/**
 * The control plane behind a real QueryClient, as the page holds it: every ask is counted, and
 * Skyblock is refused on 1.21.1 as above.
 */
function heldBy(fails: (from: SetupSourceInput) => Error | null = onlyOn121) {
  const asked: SetupSourceInput[] = []
  const trpc = {
    servers: {
      setupPreview: {
        queryOptions: (input: { from: SetupSourceInput; partySize: string }) => ({
          queryKey: ['setupPreview', input],
          queryFn: async () => {
            asked.push(input.from)
            const failure = fails(input.from)
            if (failure !== null) throw failure
            const gameVersion = input.from.kind === 'template' ? (input.from.gameVersion ?? '26.2') : '26.2'
            return { from: 'Skyblock', gameVersion, size: { allowed: true } } as SetupPreview
          },
        }),
      },
    },
  }
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ahead = (from: SetupSourceInput) =>
    queries.query(previewQuery(trpc as never, from, '5')).catch(() => undefined)
  return { asked, queries, trpc: trpc as never, ahead }
}

const live = {
  templates: [{ key: 'survival' }, { key: 'skyblock' }],
  packs: [{ key: 'cobblemon' }],
} as unknown as Pick<CreateOptions, 'templates' | 'packs'>

describe('the choices the create page asks about ahead', () => {
  test('are every template and named pack it offers, and with a version, each template at it too', () => {
    expect(choicesAhead(live, undefined)).toEqual([
      { kind: 'template', key: 'survival' },
      { kind: 'template', key: 'skyblock' },
      { kind: 'curated', key: 'cobblemon' },
    ])
    expect(choicesAhead(live, '1.21.1')).toEqual([
      { kind: 'template', key: 'survival' },
      { kind: 'template', key: 'survival', gameVersion: '1.21.1' },
      { kind: 'template', key: 'skyblock' },
      { kind: 'template', key: 'skyblock', gameVersion: '1.21.1' },
      { kind: 'curated', key: 'cobblemon' },
    ])
  })

  test('a choice asked about ahead is answered on the click, with nothing asked again', async () => {
    const { asked, queries, trpc, ahead } = heldBy()
    for (const from of choicesAhead(live, undefined)) await ahead(from)
    const before = asked.length
    const known = knownPreviewOf(queries, trpc, { kind: 'template', key: 'skyblock' }, '5')
    expect(known).toMatchObject({
      source: { kind: 'template', key: 'skyblock' },
      would: { gameVersion: '26.2' },
    })
    // `previewOf`, which the bar's choices fall back on, reads the same answer.
    await previewOf(queries, trpc, { kind: 'template', key: 'skyblock' }, '5')
    expect(asked).toHaveLength(before)
  })

  test('a template refused at the version picked lands on its newest from what was asked ahead', async () => {
    const { asked, queries, trpc, ahead } = heldBy()
    for (const from of choicesAhead(live, '1.21.1')) await ahead(from)
    const before = asked.length
    const known = knownPreviewOf(
      queries,
      trpc,
      { kind: 'template', key: 'skyblock', gameVersion: '1.21.1' },
      '5',
    )
    expect(known).toMatchObject({
      source: { kind: 'template', key: 'skyblock' },
      would: { gameVersion: '26.2' },
    })
    expect(asked).toHaveLength(before)
  })

  test('a refusal asked ahead is said on the click; another failure, or nothing yet, is asked again', async () => {
    const nowhere = await failedWith(
      refusing(
        'mods_conflict',
        "Cubepals can't run SkyBlock (BSkyBlock) on any Minecraft it offers right now.",
      ),
    )
    const away = await failedWith(refusing('catalog_unavailable', 'Modrinth isn’t answering right now.'))
    const { queries, trpc, ahead } = heldBy((from) =>
      from.kind === 'template' && from.key === 'skyblock' ? nowhere : from.kind === 'curated' ? away : null,
    )
    await ahead({ kind: 'template', key: 'skyblock' })
    await ahead({ kind: 'curated', key: 'cobblemon' })
    expect(knownPreviewOf(queries, trpc, { kind: 'template', key: 'skyblock' }, '5')).toEqual({
      refused: nowhere,
    })
    expect(knownPreviewOf(queries, trpc, { kind: 'curated', key: 'cobblemon' }, '5')).toBeNull()
    expect(knownPreviewOf(queries, trpc, { kind: 'template', key: 'survival' }, '5')).toBeNull()
  })

  test('an answer older than the page trusts is asked again', async () => {
    const { queries, trpc, ahead } = heldBy()
    await ahead({ kind: 'template', key: 'survival' })
    const survival = { kind: 'template', key: 'survival' } as const
    expect(knownPreviewOf(queries, trpc, survival, '5', Date.now() + PREVIEW_FRESH_MS - 1000)).not.toBeNull()
    expect(knownPreviewOf(queries, trpc, survival, '5', Date.now() + PREVIEW_FRESH_MS)).toBeNull()
  })
})
