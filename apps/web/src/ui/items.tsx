'use client'

/**
 * Items as an inventory shows them, drawn in the browser from the textures of the server's own
 * release, which the control plane fetched from Mojang and serves: never shipped with Cubepals.
 */
import type { ItemIconView, ItemStackView } from '@blockly/contracts'
import type { CSSProperties, ReactNode } from 'react'
import { Tip } from './tip'

/**
 * An inventory slot as the game shows one: the item drawn from its release's own textures, which
 * the control plane fetched from Mojang and serves, how many, and how worn. Flat items are their
 * layers; blocks are three faces of a cube, turned as the game turns them. Where there is no
 * picture, the slot writes the item's name, so a missing texture is never a broken image. Hovered
 * or tapped, it says what the game's tooltip says.
 */
export function ItemSlot({
  stack,
  icon,
  gameVersion,
  label,
}: {
  stack: ItemStackView | null
  /** Undefined while icons load: the slot is drawn without its picture until then. */
  icon: ItemIconView | undefined
  gameVersion: string
  /** What the slot is for, where it is a particular one: "Head", "Offhand". */
  label?: string
}) {
  if (stack === null)
    return <span className="bk-slot" role="img" aria-label={label ? `${label}: empty` : 'Empty'} />
  const glint = stack.enchantments.length > 0 || stack.id === 'minecraft:enchanted_book'
  return (
    <Tip tip={<ItemTooltip stack={stack} />}>
      <span
        className="bk-slot"
        role="img"
        aria-label={`${stack.name}${stack.count > 1 ? `, ${stack.count}` : ''}`}
      >
        {icon === null || icon === undefined ? (
          icon === null && <span className="bk-slot__name">{stack.name}</span>
        ) : (
          <ItemPicture icon={icon} gameVersion={gameVersion} glint={glint} />
        )}
        {stack.count > 1 && <span className="bk-slot__count bk-num">{stack.count}</span>}
        {stack.durability && (
          <span className="bk-slot__wear" aria-hidden>
            <span style={wear(stack.durability.left / stack.durability.max)} />
          </span>
        )}
      </span>
    </Tip>
  )
}

/** The game's bar: as long as what's left, from green when new to red near breaking. */
function wear(left: number): CSSProperties {
  return { width: `${left * 100}%`, background: `hsl(${Math.round(left * 120)} 85% 45%)` }
}

function ItemTooltip({ stack }: { stack: ItemStackView }) {
  const lines: ReactNode[] = [...stack.enchantments]
  if (stack.potion) lines.push(stack.potion)
  if (stack.durability) lines.push(`Durability ${stack.durability.left} / ${stack.durability.max}`)
  return (
    <span className="bk-slot__tip">
      <strong style={stack.named ? { fontStyle: 'italic' } : undefined}>{stack.name}</strong>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the tooltip's lines never move
        <span key={i}>{line}</span>
      ))}
    </span>
  )
}

const url = (gameVersion: string, texture: string) => `/api/public/items/${gameVersion}/${texture}.png`

function ItemPicture({
  icon,
  gameVersion,
  glint,
}: {
  icon: NonNullable<ItemIconView>
  gameVersion: string
  glint: boolean
}) {
  if (icon.kind === 'flat')
    return (
      <span className={['bk-item', glint && 'bk-item--glint'].filter(Boolean).join(' ')} aria-hidden>
        {icon.layers.map((layer) => (
          <Paint key={layer.texture} src={url(gameVersion, layer.texture)} tint={layer.tint} />
        ))}
        {glint && <Glint src={url(gameVersion, icon.layers[0]?.texture ?? '')} />}
      </span>
    )
  return (
    <span className="bk-item bk-item--block" aria-hidden>
      <span className="bk-cube">
        <Paint className="bk-cube__top" src={url(gameVersion, icon.top.texture)} tint={icon.top.tint} />
        <Paint className="bk-cube__left" src={url(gameVersion, icon.left.texture)} tint={icon.left.tint} />
        <Paint className="bk-cube__right" src={url(gameVersion, icon.right.texture)} tint={icon.right.tint} />
      </span>
    </span>
  )
}

/**
 * One texture, its first frame where it is animated (a strip of frames). A tint is multiplied in
 * over the texture's own shape, as the game colours grass, leaves and potions.
 */
function Paint({ src, tint, className }: { src: string; tint: number | null; className?: string }) {
  const image: CSSProperties = { backgroundImage: `url(${src})` }
  return (
    <span className={['bk-paint', className].filter(Boolean).join(' ')} style={image}>
      {tint !== null && (
        <span
          className="bk-paint__tint"
          style={{
            backgroundColor: `#${tint.toString(16).padStart(6, '0')}`,
            maskImage: `url(${src})`,
            WebkitMaskImage: `url(${src})`,
          }}
        />
      )}
    </span>
  )
}

/** The shimmer an enchanted item wears, only where the item is. */
function Glint({ src }: { src: string }) {
  return (
    <span className="bk-item__glint" style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` }} />
  )
}
