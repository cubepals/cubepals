// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What a player carries, laid out as the game lays it out: armor and the offhand beside the
 * inventory, the hotbar under it, and the ender chest apart. Read only. The pictures are the
 * release's own (`ui/items.tsx`), asked for once for every item on the page.
 */
import type { InventoryView, SlotView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../../../../../lib/api'
import { FormSection, ItemSlot } from '../../../../../../ui'

export function Inventory({
  inventory,
  gameVersion,
  name,
}: {
  inventory: InventoryView
  gameVersion: string
  name: string
}) {
  const trpc = useTRPC()
  const { armor } = inventory
  const all = [
    ...inventory.hotbar,
    ...inventory.main,
    armor.head,
    armor.chest,
    armor.legs,
    armor.feet,
    inventory.offhand,
    ...inventory.enderChest,
  ]
  const ids = [...new Set(all.flatMap((stack) => (stack === null ? [] : [stack.id])))].sort()
  const icons = useQuery({
    ...trpc.players.icons.queryOptions({ gameVersion, ids }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: ids.length > 0,
  })
  // Until the pictures arrive a slot shows nothing; where there are none, the item's name.
  const slot = (stack: SlotView, key: string, label?: string) => (
    <ItemSlot
      key={key}
      stack={stack}
      icon={stack === null ? null : icons.isError ? null : icons.data?.[stack.id]}
      gameVersion={gameVersion}
      {...(label === undefined ? {} : { label })}
    />
  )
  const empty = all.every((stack) => stack === null)

  return (
    <>
      <FormSection title="Inventory" description={empty ? `${name} carries nothing.` : undefined}>
        <div className="bk-inventory">
          <div className="bk-inventory__all">
            <div className="bk-inventory__worn">
              {slot(armor.head, 'head', 'Head')}
              {slot(armor.chest, 'chest', 'Chest')}
              {slot(armor.legs, 'legs', 'Legs')}
              {slot(armor.feet, 'feet', 'Feet')}
              {slot(inventory.offhand, 'offhand', 'Offhand')}
            </div>
            <div className="bk-inventory__main">
              <div className="bk-slots">{inventory.main.map((stack, i) => slot(stack, `main-${i}`))}</div>
              <div className="bk-slots">{inventory.hotbar.map((stack, i) => slot(stack, `hotbar-${i}`))}</div>
            </div>
          </div>
        </div>
      </FormSection>
      <FormSection title="Ender chest">
        <div className="bk-inventory">
          <div className="bk-slots">{inventory.enderChest.map((stack, i) => slot(stack, `ender-${i}`))}</div>
        </div>
      </FormSection>
    </>
  )
}
