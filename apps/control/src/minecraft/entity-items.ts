// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Items the game draws in code, not from an item model: chests, beds, banners, shields, heads,
 * shulker boxes, the conduit, decorated pots and copper golem statues. Their pictures are cut from
 * the entity textures the game skins them with, which the release's client jar holds: each face is
 * one or more rectangles of a texture, placed on a 16×16 face. Where they sit in each texture is
 * the game's own model, read off its textures and written down here, the same in 1.20.1 and 26.x.
 *
 * Deliberately simple: a chest or a head is drawn as the cube it nearly is, a bed and a banner as
 * they look from the front, and a statue as its head over its body. Where a texture is missing,
 * the item has no picture and the page writes its name.
 */

/** A rectangle of a texture, drawn onto part of a face. */
interface Cut {
  /** Under `textures/`, without `.png`: `entity/chest/normal`. */
  texture: string
  /** The texture's size in pixels, as the game's model gives it. */
  size: [number, number]
  /** Where it is in the texture, in pixels: x, y, width, height. */
  from: [number, number, number, number]
  /** Where it goes on the face, in sixteenths: x, y, width, height. */
  to: [number, number, number, number]
  tint: number | null
  /** Turned clockwise in its place, in degrees, as a bed lies across a slot. */
  turn: 0 | 90 | 180 | 270
}

export type CutIcon =
  | { kind: 'cut'; cuts: Cut[] }
  | { kind: 'cut_block'; top: Cut[]; left: Cut[]; right: Cut[] }

type Rect = [number, number, number, number]
const WHOLE: Rect = [0, 0, 16, 16]

/** The colours a dye tints a banner, as the game's `DyeColor` gives them: they are in its code, not its files. */
const DYES: Record<string, number> = {
  white: 0xf9fffe,
  orange: 0xf9801d,
  magenta: 0xc74ebd,
  light_blue: 0x3ab3da,
  yellow: 0xfed83d,
  lime: 0x80c71f,
  pink: 0xf38baa,
  gray: 0x474f52,
  light_gray: 0x9d9d97,
  cyan: 0x169c9c,
  purple: 0x8932b8,
  blue: 0x3c44aa,
  brown: 0x835432,
  green: 0x5e7c16,
  red: 0xb02e26,
  black: 0x1d1d21,
}
const COLOR = `(${Object.keys(DYES).join('|')})`

/**
 * The picture of an item the game draws in code, by its path (`red_bed`); undefined for any other
 * item, and null for one of these whose texture the release doesn't have.
 */
export function entityIconOf(
  path: string,
  hasTexture: (texture: string) => boolean,
): CutIcon | null | undefined {
  for (const [pattern, draw] of FAMILIES) {
    const match = pattern.exec(path)
    if (match === null) continue
    const icon = draw(match)
    return icon === null ? null : found(icon, hasTexture)
  }
  return undefined
}

/**
 * The icon with each texture where this release keeps it: 1.20.1 keeps a few a folder higher
 * (`entity/banner_base`, not `entity/banner/banner_base`). Null where one is in neither place.
 */
function found(icon: CutIcon, hasTexture: (texture: string) => boolean): CutIcon | null {
  const where = new Map<string, string | null>()
  for (const { texture } of cutsOf(icon)) {
    if (where.has(texture)) continue
    where.set(texture, placesOf(texture).find(hasTexture) ?? null)
  }
  if ([...where.values()].includes(null)) return null
  const moved = (cuts: Cut[]) => cuts.map((c) => ({ ...c, texture: where.get(c.texture) ?? c.texture }))
  return icon.kind === 'cut'
    ? { kind: 'cut', cuts: moved(icon.cuts) }
    : { kind: 'cut_block', top: moved(icon.top), left: moved(icon.left), right: moved(icon.right) }
}

/**
 * Where a release may keep a texture: as named; a folder higher, as 1.20.1 keeps a banner's; or
 * with its stage first, as 1.21.10 names a copper golem's (`exposed_copper_golem`).
 */
function placesOf(texture: string): string[] {
  const staged = /^entity\/copper_golem\/copper_golem_([a-z]+)$/.exec(texture)
  return [
    texture,
    texture.replace(/^entity\/[a-z_]+\//, 'entity/'),
    ...(staged === null ? [] : [`entity/copper_golem/${staged[1]}_copper_golem`]),
  ]
}

function cutsOf(icon: CutIcon): Cut[] {
  return icon.kind === 'cut' ? icon.cuts : [...icon.top, ...icon.left, ...icon.right]
}

type Draw = (match: RegExpExecArray) => CutIcon | null

const FAMILIES: [RegExp, Draw][] = [
  [
    /^(trapped_|ender_)?chest$/,
    (m) => chest(`entity/chest/${m[1] === undefined ? 'normal' : m[1].slice(0, -1)}`),
  ],
  [
    /^(?:waxed_)?(exposed_|weathered_|oxidized_)?copper_chest$/,
    (m) => chest(`entity/chest/copper${m[1] === undefined ? '' : `_${m[1].slice(0, -1)}`}`),
  ],
  [new RegExp(`^(?:${COLOR}_)?shulker_box$`), (m) => shulkerBox(m[1])],
  [new RegExp(`^${COLOR}_bed$`), (m) => bed(m[1] ?? '')],
  [new RegExp(`^${COLOR}_banner$`), (m) => banner(DYES[m[1] ?? ''] ?? null)],
  [
    /^shield$/,
    () => ({
      kind: 'cut',
      cuts: [cut('entity/shield/shield_base_nopattern', [64, 64], [1, 1, 12, 22], [4, 1, 8, 14])],
    }),
  ],
  [/^(skeleton|wither_skeleton)_skull$/, (m) => head(`entity/skeleton/${m[1]}`, [64, 32])],
  [/^creeper_head$/, () => head('entity/creeper/creeper', [64, 32])],
  [/^zombie_head$/, () => head('entity/zombie/zombie', [64, 64], true)],
  [/^player_head$/, () => head('entity/player/wide/steve', [64, 64], true)],
  [/^piglin_head$/, () => piglinHead()],
  [/^dragon_head$/, () => dragonHead()],
  [/^conduit$/, () => conduit()],
  [/^decorated_pot$/, () => decoratedPot()],
  [
    /^(?:waxed_)?(exposed_|weathered_|oxidized_)?copper_golem_statue$/,
    (m) => statue(`entity/copper_golem/copper_golem${m[1] === undefined ? '' : `_${m[1].slice(0, -1)}`}`),
  ],
]

function cut(
  texture: string,
  size: [number, number],
  from: Rect,
  to: Rect,
  tint: number | null = null,
  turn: Cut['turn'] = 0,
): Cut {
  return { texture, size, from, to, tint, turn }
}

/** A box's faces in its texture, as the game lays one out from its corner: width, height, depth. */
function box(u: number, v: number, w: number, h: number, d: number) {
  return {
    top: [u + d, v, w, d] as Rect,
    front: [u + d, v + d, w, h] as Rect,
    side: [u + d + w, v + d, d, h] as Rect,
  }
}

/** The lid over the base, with the latch on the front. */
function chest(texture: string): CutIcon {
  const size: [number, number] = [64, 64]
  const lid = box(0, 0, 14, 5, 14)
  const base = box(0, 19, 14, 10, 14)
  return {
    kind: 'cut_block',
    // The game turns the lid's texture over: what it draws on top is beside the box's top.
    top: [cut(texture, size, [28, 0, 14, 14], WHOLE)],
    left: [
      cut(texture, size, lid.front, [0, 0, 16, 6]),
      cut(texture, size, base.front, [0, 6, 16, 10]),
      cut(texture, size, [1, 1, 2, 4], [7, 3, 2, 4]),
    ],
    right: [cut(texture, size, lid.side, [0, 0, 16, 6]), cut(texture, size, base.side, [0, 6, 16, 10])],
  }
}

/** The lid over the bottom of the base, in the box's colour or a dye's. */
function shulkerBox(color: string | undefined): CutIcon {
  const texture = `entity/shulker/shulker${color === undefined ? '' : `_${color}`}`
  const size: [number, number] = [64, 64]
  const lid = box(0, 0, 16, 12, 16)
  // The lid's lower edge is open where the base shows through it, so the base goes behind.
  const side = (rect: Rect): Cut[] => [
    cut(texture, size, [rect[0], 44, rect[2], 8], [0, 8, 16, 8]),
    cut(texture, size, rect, [0, 0, 16, 12]),
  ]
  return {
    kind: 'cut_block',
    top: [cut(texture, size, lid.top, WHOLE)],
    left: side(lid.front),
    right: side(lid.side),
  }
}

/** Seen from above, lying across: the pillow end on the left, then the foot. */
function bed(color: string): CutIcon {
  const texture = `entity/bed/${color}`
  return lyingBed(
    { texture, size: [64, 64], from: [6, 6, 16, 16] },
    { texture, size: [64, 64], from: [6, 28, 16, 16] },
  )
}

/** The top of one half of a bed, in a texture. */
export interface BedTop {
  texture: string
  size: [number, number]
  from: Rect
}

/**
 * A bed from the tops of its two halves, lying across as the beds before 26.2 are drawn: from
 * 26.2 a bed is two block models, and their tops are what this is given (`item-models.ts`).
 */
export function lyingBed(head: BedTop, foot: BedTop): CutIcon {
  return {
    kind: 'cut',
    cuts: [
      cut(head.texture, head.size, head.from, [0, 4, 8, 8], null, 270),
      cut(foot.texture, foot.size, foot.from, [8, 4, 8, 8], null, 270),
    ],
  }
}

/** The pole, the bar and the flag in front of them, the flag in the dye's colour. */
function banner(tint: number | null): CutIcon {
  const texture = 'entity/banner/banner_base'
  const size: [number, number] = [64, 64]
  return {
    kind: 'cut',
    cuts: [
      cut(texture, size, [46, 2, 2, 42], [7.5, 0, 1, 16]),
      cut(texture, size, [2, 44, 20, 2], [3, 0, 10, 1]),
      cut(texture, size, [1, 1, 20, 40], [4, 1, 8, 15], tint),
    ],
  }
}

/** A head as the cube it is, with the hat layer over it where the skin has one. */
function head(texture: string, size: [number, number], hat = false): CutIcon {
  const skull = box(0, 0, 8, 8, 8)
  const layer = box(32, 0, 8, 8, 8)
  const face = (inner: Rect, outer: Rect): Cut[] => [
    cut(texture, size, inner, WHOLE),
    ...(hat ? [cut(texture, size, outer, WHOLE)] : []),
  ]
  return {
    kind: 'cut_block',
    top: face(skull.top, layer.top),
    left: face(skull.front, layer.front),
    right: face(skull.side, layer.side),
  }
}

function piglinHead(): CutIcon {
  const texture = 'entity/piglin/piglin'
  const size: [number, number] = [64, 64]
  const skull = box(0, 0, 10, 8, 8)
  return {
    kind: 'cut_block',
    top: [cut(texture, size, skull.top, WHOLE)],
    left: [cut(texture, size, skull.front, WHOLE)],
    right: [cut(texture, size, skull.side, WHOLE)],
  }
}

/** The dragon's head without its snout: the face with its eyes. */
function dragonHead(): CutIcon {
  const texture = 'entity/enderdragon/dragon'
  const size: [number, number] = [256, 256]
  const skull = box(112, 30, 16, 16, 16)
  return {
    kind: 'cut_block',
    top: [cut(texture, size, skull.top, WHOLE)],
    left: [cut(texture, size, skull.front, WHOLE)],
    right: [cut(texture, size, skull.side, WHOLE)],
  }
}

/** The conduit's shell, as it sits closed in an inventory. */
function conduit(): CutIcon {
  const texture = 'entity/conduit/base'
  const size: [number, number] = [32, 16]
  const shell = box(0, 0, 6, 6, 6)
  return {
    kind: 'cut_block',
    top: [cut(texture, size, shell.top, WHOLE)],
    left: [cut(texture, size, shell.front, WHOLE)],
    right: [cut(texture, size, shell.side, WHOLE)],
  }
}

/** A plain pot: its sides, under its top. */
function decoratedPot(): CutIcon {
  const side = cut('entity/decorated_pot/decorated_pot_side', [16, 16], WHOLE, WHOLE)
  return {
    kind: 'cut_block',
    top: [cut('entity/decorated_pot/decorated_pot_base', [32, 32], [0, 13, 14, 14], WHOLE)],
    left: [side],
    right: [side],
  }
}

/** A copper golem from the front: its head over its body. */
function statue(texture: string): CutIcon {
  const size: [number, number] = [64, 64]
  return {
    kind: 'cut',
    cuts: [
      cut(texture, size, [6, 21, 8, 6], [4, 8, 8, 6]),
      cut(texture, size, [10, 10, 8, 6], [2, 1, 12, 9]),
    ],
  }
}
