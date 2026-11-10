// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Items the game draws in code, cut from the entity textures it skins them with: which texture
 * each family takes, where 1.20.1 keeps a few of them, and nothing where a texture is missing.
 */
import { describe, expect, test } from 'bun:test'
import { entityIconOf } from './entity-items.ts'

const has =
  (...textures: string[]) =>
  (texture: string) =>
    textures.includes(texture)
const texturesOf = (icon: ReturnType<typeof entityIconOf>) =>
  icon === null || icon === undefined
    ? []
    : [
        ...new Set(
          (icon.kind === 'cut' ? icon.cuts : [...icon.top, ...icon.left, ...icon.right]).map(
            (c) => c.texture,
          ),
        ),
      ]

describe('an item the game draws in code', () => {
  test('each family from its own texture', () => {
    const every = (texture: string) => texture.startsWith('entity/')
    expect(texturesOf(entityIconOf('chest', every))).toEqual(['entity/chest/normal'])
    expect(texturesOf(entityIconOf('trapped_chest', every))).toEqual(['entity/chest/trapped'])
    expect(texturesOf(entityIconOf('ender_chest', every))).toEqual(['entity/chest/ender'])
    expect(texturesOf(entityIconOf('waxed_weathered_copper_chest', every))).toEqual([
      'entity/chest/copper_weathered',
    ])
    expect(texturesOf(entityIconOf('shulker_box', every))).toEqual(['entity/shulker/shulker'])
    expect(texturesOf(entityIconOf('light_blue_shulker_box', every))).toEqual([
      'entity/shulker/shulker_light_blue',
    ])
    expect(texturesOf(entityIconOf('red_bed', every))).toEqual(['entity/bed/red'])
    expect(texturesOf(entityIconOf('wither_skeleton_skull', every))).toEqual([
      'entity/skeleton/wither_skeleton',
    ])
    expect(texturesOf(entityIconOf('player_head', every))).toEqual(['entity/player/wide/steve'])
    expect(texturesOf(entityIconOf('oxidized_copper_golem_statue', every))).toEqual([
      'entity/copper_golem/copper_golem_oxidized',
    ])
    expect(texturesOf(entityIconOf('decorated_pot', every))).toEqual([
      'entity/decorated_pot/decorated_pot_base',
      'entity/decorated_pot/decorated_pot_side',
    ])
  })

  test('a banner’s flag in its dye’s colour, and a bed lying across', () => {
    const banner = entityIconOf('red_banner', (t) => t.startsWith('entity/'))
    expect(banner?.kind === 'cut' && banner.cuts.map((c) => c.tint)).toEqual([null, null, 0xb02e26])
    const bed = entityIconOf('red_bed', (t) => t.startsWith('entity/'))
    expect(bed?.kind === 'cut' && bed.cuts.map((c) => c.turn)).toEqual([270, 270])
  })

  test('a head wears the hat layer only where its skin has one', () => {
    const faces = (id: string) => {
      const icon = entityIconOf(id, (t) => t.startsWith('entity/'))
      return icon?.kind === 'cut_block' ? icon.left.length : 0
    }
    expect(faces('skeleton_skull')).toBe(1)
    expect(faces('zombie_head')).toBe(2)
  })

  test('1.20.1 keeps a banner’s and a shield’s texture a folder higher', () => {
    expect(texturesOf(entityIconOf('white_banner', has('entity/banner_base')))).toEqual([
      'entity/banner_base',
    ])
    expect(texturesOf(entityIconOf('shield', has('entity/shield_base_nopattern')))).toEqual([
      'entity/shield_base_nopattern',
    ])
  })

  test('nothing where the texture is missing; any other item isn’t one of these', () => {
    expect(entityIconOf('chest', has())).toBeNull()
    expect(entityIconOf('decorated_pot', has('entity/decorated_pot/decorated_pot_side'))).toBeNull()
    expect(entityIconOf('diamond', has())).toBeUndefined()
    expect(entityIconOf('chest_minecart', () => true)).toBeUndefined()
  })
})
