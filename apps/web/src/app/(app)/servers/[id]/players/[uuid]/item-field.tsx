// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The field an owner names an item in, to give it: every item the server's release has, found by
 * typing part of its id or its words, each with its picture, drawn as the inventory draws it
 * (`ui/items.tsx`). The list and the pictures are the release's own, from the control plane
 * (`app/items/`). Any id can still be typed, a mod's included; the list only helps.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../../../../../lib/api'
import { ItemIcon, SuggestField } from '../../../../../../ui'

/** What owners hand out most, offered while the field is empty. */
const COMMON_ITEMS = [
  'diamond',
  'netherite_ingot',
  'iron_ingot',
  'gold_ingot',
  'emerald',
  'cooked_beef',
  'golden_apple',
  'ender_pearl',
  'torch',
  'oak_log',
  'elytra',
  'firework_rocket',
  'totem_of_undying',
  'diamond_pickaxe',
  'diamond_sword',
]

/** The most the list offers at once: past that, typing more narrows it. */
const MOST_SHOWN = 40

export function ItemField({
  gameVersion,
  value,
  onChange,
}: {
  gameVersion: string
  value: string
  onChange: (value: string) => void
}) {
  const trpc = useTRPC()
  const all = useQuery({
    ...trpc.players.items.queryOptions({ gameVersion }),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const items = (all.data ?? []).map(bare)
  const typed = bare(value.trim().toLowerCase())
  const shown = typed === '' ? COMMON_ITEMS : matching(items, typed)
  const ids = [...new Set([...shown, typed].filter((id) => items.includes(id) || COMMON_ITEMS.includes(id)))]
  const icons = useQuery({
    ...trpc.players.icons.queryOptions({ gameVersion, ids: ids.map((id) => `minecraft:${id}`).sort() }),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    enabled: ids.length > 0,
  })
  const icon = (id: string) => icons.data?.[`minecraft:${id}`] ?? undefined
  return (
    <SuggestField
      label="Item"
      mono
      placeholder="diamond"
      help="Type part of its name to find it. A mod’s item starts with the mod’s name: create:wrench."
      value={value}
      leading={<ItemIcon icon={icon(typed)} gameVersion={gameVersion} />}
      suggestions={shown.map((id) => ({
        value: id,
        icon: <ItemIcon icon={icon(id)} gameVersion={gameVersion} />,
      }))}
      onPick={onChange}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** `minecraft:diamond` is `diamond`, as the field shows it; a mod's id keeps its name. */
function bare(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id
}

/**
 * The items holding what is typed, a space as good as an underscore: those it starts first, then
 * those with a word it starts (`apple` finds `golden_apple`), then the rest.
 */
function matching(items: readonly string[], typed: string): string[] {
  const words = typed.replaceAll(' ', '_')
  const rank = (id: string) => (id.startsWith(words) ? 0 : id.includes(`_${words}`) ? 1 : 2)
  return items
    .filter((id) => id.includes(words))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, MOST_SHOWN)
}
