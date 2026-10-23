// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A template's resolution kept for the create page's previews: asked once, answered from what was
 * kept until it is dropped, and asked again after an outage.
 */
import { describe, expect, test } from 'bun:test'
import { offeredVersions } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import { CatalogUnavailable } from '../ports/catalog.ts'
import { ResolvedTemplates, TEMPLATE_KEPT_MS } from './resolved-templates.ts'
import type { ResolvedSetup, SetupSource } from './service.ts'

type TemplateSource = SetupSource & { kind: 'template' }

/** A resolver that counts its asks and answers what `answer` says, against a clock the test moves. */
function kept(answer: (source: TemplateSource) => Promise<ResolvedSetup> = resolved) {
  const asked: TemplateSource[] = []
  const clock = { now: 0 }
  const templates = new ResolvedTemplates(
    (source) => {
      asked.push(source)
      return answer(source)
    },
    { now: () => clock.now },
  )
  return { asked, clock, templates }
}

const resolved = async (source: TemplateSource) =>
  ({ from: source.key, gameVersion: source.gameVersion ?? '26.2' }) as ResolvedSetup

const [newest, older] = offeredVersions().map((offered) => offered.id)

describe('a template’s resolution, kept for previews', () => {
  test('is worked out once, and answered from what was kept after that', async () => {
    const { asked, templates } = kept()
    const first = await templates.get({ kind: 'template', key: 'skyblock' })
    const again = await templates.get({ kind: 'template', key: 'skyblock' })
    expect(again).toBe(first)
    expect(asked).toHaveLength(1)
  })

  test('is kept apart by template and by release', async () => {
    const { asked, templates } = kept()
    await templates.get({ kind: 'template', key: 'skyblock' })
    await templates.get({ kind: 'template', key: 'skyblock', gameVersion: older })
    await templates.get({ kind: 'template', key: 'duels' })
    await templates.get({ kind: 'template', key: 'skyblock', gameVersion: older })
    expect(asked).toEqual([
      { kind: 'template', key: 'skyblock' },
      { kind: 'template', key: 'skyblock', gameVersion: older },
      { kind: 'template', key: 'duels' },
    ])
  })

  test('asks that come while one is worked out wait for that one', async () => {
    const { asked, templates } = kept()
    const [one, two] = await Promise.all([
      templates.get({ kind: 'template', key: 'create' }),
      templates.get({ kind: 'template', key: 'create' }),
    ])
    expect(two).toBe(one)
    expect(asked).toHaveLength(1)
  })

  test('is worked out again once it has been kept its while', async () => {
    const { asked, clock, templates } = kept()
    await templates.get({ kind: 'template', key: 'rpg' })
    clock.now += TEMPLATE_KEPT_MS - 1
    await templates.get({ kind: 'template', key: 'rpg' })
    expect(asked).toHaveLength(1)
    clock.now += 1
    await templates.get({ kind: 'template', key: 'rpg' })
    expect(asked).toHaveLength(2)
  })

  test('keeps a refusal, which is as much an answer', async () => {
    const refused = new AppError('mods_conflict', `Cubepals can't run Duels on Minecraft ${newest}.`)
    const { asked, templates } = kept(async () => {
      throw refused
    })
    const source = { kind: 'template', key: 'duels', gameVersion: newest } as const
    await expect(templates.get(source)).rejects.toBe(refused)
    await expect(templates.get(source)).rejects.toBe(refused)
    expect(asked).toHaveLength(1)
  })

  test('asks again after a catalog that didn’t answer', async () => {
    let down = true
    const { asked, templates } = kept(async (source) => {
      if (down) throw new CatalogUnavailable('no answer', 'Hangar')
      return resolved(source)
    })
    await expect(templates.get({ kind: 'template', key: 'duels' })).rejects.toBeInstanceOf(CatalogUnavailable)
    down = false
    expect((await templates.get({ kind: 'template', key: 'duels' })).from).toBe('duels')
    expect(asked).toHaveLength(2)
  })

  test('keeps nothing for a release Blockly doesn’t offer', async () => {
    const { asked, templates } = kept()
    await templates.get({ kind: 'template', key: 'survival', gameVersion: '0.0.1' })
    await templates.get({ kind: 'template', key: 'survival', gameVersion: '0.0.1' })
    expect(asked).toHaveLength(2)
  })

  test('keeps nothing when its while is none', async () => {
    const asked: TemplateSource[] = []
    const templates = new ResolvedTemplates(
      (source) => {
        asked.push(source)
        return resolved(source)
      },
      { keptMs: 0 },
    )
    await templates.get({ kind: 'template', key: 'survival' })
    await templates.get({ kind: 'template', key: 'survival' })
    expect(asked).toHaveLength(2)
  })
})
