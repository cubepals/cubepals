// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Item models in the shapes releases write them, made up here: nothing of Mojang's is in the
 * repository. 1.20.1 keeps an item's model at `models/item/<id>.json`; 1.21.4 and later name it in
 * `items/<id>.json`, with its tints, through selections and conditions.
 */
import { describe, expect, test } from 'bun:test'
import { iconOf, itemsOf, type ModelFiles } from './item-models.ts'

const textures = new Set([
  'item/sword',
  'item/bottle',
  'item/bottle_overlay',
  'block/log_top',
  'block/log_side',
  'block/grass_top',
  'block/dirt_side',
  'block/planks',
])

function files(json: Record<string, unknown>): ModelFiles {
  return { json: (path) => json[path] ?? null, hasTexture: (texture) => textures.has(texture) }
}

const CUBE = {
  parent: 'block/block',
  elements: [
    {
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: {
        up: { texture: '#up', tintindex: 0 },
        north: { texture: '#north' },
        east: { texture: '#east' },
      },
    },
  ],
}
const COLUMN = { parent: 'block/cube', textures: { up: '#end', north: '#side', east: '#side' } }

describe('how an item is drawn', () => {
  test('1.20.1: a flat item from its own model, held in hand', () => {
    const icon = iconOf(
      'minecraft:sword',
      files({
        'models/item/sword.json': {
          parent: 'minecraft:item/handheld',
          textures: { layer0: 'minecraft:item/sword' },
        },
        'models/item/handheld.json': { parent: 'item/generated' },
      }),
    )
    expect(icon).toEqual({ kind: 'flat', layers: [{ texture: 'item/sword', tint: null }] })
  })

  test('1.20.1: a block through its parents to a cube, and a potion tinted as the game’s code does', () => {
    const shared = { 'models/block/cube.json': CUBE }
    expect(
      iconOf(
        'minecraft:log',
        files({
          ...shared,
          'models/item/log.json': { parent: 'minecraft:block/log' },
          'models/block/log.json': {
            parent: 'block/column',
            textures: { end: 'block/log_top', side: 'block/log_side' },
          },
          'models/block/column.json': COLUMN,
        }),
      ),
    ).toEqual({
      kind: 'block',
      top: { texture: 'block/log_top', tint: null },
      left: { texture: 'block/log_side', tint: null },
      right: { texture: 'block/log_side', tint: null },
    })
    const potion = iconOf(
      'minecraft:potion',
      files({
        'models/item/potion.json': {
          parent: 'item/generated',
          textures: { layer0: 'item/bottle_overlay', layer1: 'item/bottle' },
        },
      }),
    )
    expect(potion).toEqual({
      kind: 'flat',
      layers: [
        { texture: 'item/bottle_overlay', tint: 0x385dc6 },
        { texture: 'item/bottle', tint: null },
      ],
    })
  })

  test('26.x: the definition names the model and its tints, through a selection to its fallback', () => {
    const icon = iconOf(
      'minecraft:grassy',
      files({
        'items/grassy.json': {
          model: {
            type: 'minecraft:select',
            cases: [{ when: 'x', model: { type: 'minecraft:model', model: 'block/elsewhere' } }],
            fallback: {
              type: 'minecraft:model',
              model: 'minecraft:block/grassy',
              tints: [{ type: 'minecraft:constant', value: -12012264 }],
            },
          },
        },
        'models/block/grassy.json': {
          parent: 'block/cube',
          // 1.21.6 on may write a texture as a sprite with how it is drawn.
          textures: { up: { sprite: 'block/grass_top' }, north: 'block/dirt_side', east: 'block/dirt_side' },
        },
        'models/block/cube.json': CUBE,
      }),
    )
    expect(icon).toEqual({
      kind: 'block',
      top: { texture: 'block/grass_top', tint: 0x48b518 },
      left: { texture: 'block/dirt_side', tint: null },
      right: { texture: 'block/dirt_side', tint: null },
    })
  })

  test('a shape that isn’t a cube is one of its faces; one drawn by code, or missing art, is nothing', () => {
    const stairs = iconOf(
      'minecraft:stairs',
      files({
        'models/item/stairs.json': { parent: 'block/stairs' },
        'models/block/stairs.json': {
          textures: { particle: 'block/planks' },
          elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: {} }],
        },
      }),
    )
    expect(stairs).toEqual({ kind: 'flat', layers: [{ texture: 'block/planks', tint: null }] })
    expect(
      iconOf(
        'minecraft:shield',
        files({
          'items/shield.json': { model: { type: 'minecraft:special', base: 'item/shield' } },
          // Its base has a texture for particles, which is not what a shield looks like.
          'models/item/shield.json': { textures: { particle: 'block/planks' } },
        }),
      ),
    ).toBeNull()
    // The texture its model names isn't in the jar: the page writes the item's name instead.
    expect(
      iconOf(
        'minecraft:gone',
        files({ 'models/item/gone.json': { parent: 'item/generated', textures: { layer0: 'item/gone' } } }),
      ),
    ).toBeNull()
    expect(iconOf('minecraft:unknown', files({}))).toBeNull()
    expect(iconOf('create:wrench', files({}))).toBeNull()
  })
})

describe('what an inventory shows', () => {
  test('a select’s case for an inventory, though its fallback is drawn in a hand', () => {
    const icon = iconOf(
      'minecraft:trident',
      files({
        'items/trident.json': {
          model: {
            type: 'minecraft:select',
            cases: [
              {
                when: ['gui', 'ground'],
                model: { type: 'minecraft:model', model: 'minecraft:item/trident' },
              },
            ],
            fallback: { type: 'minecraft:special', base: 'minecraft:item/trident_in_hand' },
          },
        },
        'models/item/trident.json': { parent: 'item/generated', textures: { layer0: 'item/sword' } },
      }),
    )
    expect(icon).toEqual({ kind: 'flat', layers: [{ texture: 'item/sword', tint: null }] })
  })

  test('a chest from its entity texture, not the planks its model names for particles', () => {
    const icon = iconOf('minecraft:chest', {
      json: (path) => (path === 'models/item/chest.json' ? { textures: { particle: 'block/planks' } } : null),
      hasTexture: (texture) => texture === 'entity/chest/normal' || texture === 'block/planks',
    })
    expect(icon?.kind).toBe('cut_block')
  })
})

describe('every item a release has', () => {
  test('26.x: each definition in items/, and nothing else', () => {
    const paths = [
      'items/stone.json',
      'items/diamond_sword.json',
      'models/item/generated.json',
      'models/item/diamond_sword.json',
      'textures/item/diamond_sword.png',
    ]
    expect(itemsOf(paths, files({}))).toEqual(['diamond_sword', 'stone'])
  })

  test('1.20.1: each item model, but not one only other models are drawn from', () => {
    const json = {
      'models/item/generated.json': { parent: 'builtin/generated' },
      'models/item/template_spawn_egg.json': { parent: 'builtin/entity' },
      'models/item/pig_spawn_egg.json': { parent: 'minecraft:item/template_spawn_egg' },
      'models/item/bow.json': {
        parent: 'item/generated',
        overrides: [{ predicate: { pulling: 1 }, model: 'item/bow_pulling_0' }],
      },
      'models/item/bow_pulling_0.json': { parent: 'item/bow' },
      'models/item/oak_log.json': { parent: 'minecraft:block/oak_log' },
      'models/item/clock.json': {
        parent: 'item/generated',
        overrides: [
          { predicate: { time: 0 }, model: 'item/clock' },
          { predicate: { time: 0.5 }, model: 'item/clock_01' },
        ],
      },
      'models/item/clock_01.json': { parent: 'item/generated' },
      'models/item/trident.json': { parent: 'builtin/entity' },
      'models/item/trident_in_hand.json': { parent: 'builtin/entity' },
    }
    expect(itemsOf(Object.keys(json), files(json))).toEqual([
      'bow',
      'clock',
      'oak_log',
      'pig_spawn_egg',
      'trident',
    ])
  })
})
