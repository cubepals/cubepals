// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What an owner would otherwise type into the console for one player, as buttons on their page: a
 * trip to coordinates or to someone else playing, an item, health and hunger back, levels, a kick,
 * and an emptied inventory, which asks first. Each is done at once, while the player is on; the
 * commands are the control plane's to build (`minecraft/player-powers.ts`), never typed here.
 */
import { type DIMENSIONS, MOST_GIVEN, type PlayerPower, type PlayerView, shownName } from '@blockly/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { said, useOutcome } from '../../../../../../lib/outcome'
import { Button, FormSection, Modal, Note, Select, SuggestField, TextField } from '../../../../../../ui'

type Dimension = (typeof DIMENSIONS)[number]

const WORLDS: Array<{ value: Dimension; label: string }> = [
  { value: 'minecraft:overworld', label: 'Overworld' },
  { value: 'minecraft:the_nether', label: 'Nether' },
  { value: 'minecraft:the_end', label: 'End' },
]

/** What owners hand out most, offered as the item field is opened; any other id can be typed. */
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
].map((value) => ({ value }))

/** A whole number from a field, or null where it holds none. */
function whole(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) return null
  return Number(trimmed)
}

export function PlayerPowers({
  serverId,
  player,
  others,
}: {
  serverId: string
  player: PlayerView
  /** Everyone else playing now, for a trip to one of them. */
  others: readonly { name: string; uuid: string }[]
}) {
  const name = shownName(player)
  if (!player.online)
    return (
      <FormSection
        title="Teleport, give and more"
        description={`Teleporting, giving items, healing and kicking show here while ${name} is playing.`}
      />
    )
  return (
    <>
      <FormSection title="Teleport" description={`Send ${name} to coordinates, or to someone playing.`}>
        <ToPlace serverId={serverId} player={player} />
        {others.length > 0 && <ToPlayer serverId={serverId} player={player} others={others} />}
      </FormSection>
      <FormSection title="Give an item" description={`Straight into ${name}’s inventory.`}>
        <GiveItem serverId={serverId} player={player} />
      </FormSection>
      <FormSection title="Quick actions">
        <div className="bk-row" style={{ gap: 'var(--space-12)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Heal serverId={serverId} player={player} />
          <ClearInventory serverId={serverId} player={player} />
        </div>
        <Levels serverId={serverId} player={player} />
        <Kick serverId={serverId} player={player} />
      </FormSection>
    </>
  )
}

interface PowerProps {
  serverId: string
  player: PlayerView
}

/** One power's call, its button's words for how it went, and the page read again after. */
function usePower({ serverId, player }: PowerProps) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const outcome = useOutcome(undefined)
  const act = useMutation(
    trpc.players.act.mutationOptions({
      onSuccess: () => outcome.settled(),
      onError: () => outcome.refused(),
      onSettled: () =>
        void queries.invalidateQueries({
          queryKey: trpc.players.get.queryKey({ serverId, playerUuid: player.uuid }),
        }),
    }),
  )
  return {
    run: (power: PlayerPower) => act.mutate({ serverId, playerUuid: player.uuid, power }),
    pending: act.isPending,
    error: act.isError ? messageOf(act.error) : null,
    words: (done: string) => said(outcome, { done, failed: 'Didn’t work' }),
  }
}

function Failed({ error }: { error: string | null }) {
  return error === null ? null : <Note tone="danger">{error}</Note>
}

function ToPlace(props: PowerProps) {
  const power = usePower(props)
  const here = props.player.position
  const [dimension, setDimension] = useState<Dimension>(
    WORLDS.find((w) => w.value === here?.dimension)?.value ?? 'minecraft:overworld',
  )
  const [x, setX] = useState(here ? String(Math.floor(here.x)) : '')
  const [y, setY] = useState('')
  const [z, setZ] = useState(here ? String(Math.floor(here.z)) : '')
  const [xs, ys, zs] = [whole(x), whole(y), whole(z)]
  const ready = xs !== null && zs !== null && (y.trim() === '' || ys !== null)
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-8)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) power.run({ kind: 'teleport', dimension, x: xs, y: ys, z: zs })
      }}
    >
      <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Select
          label="World"
          options={WORLDS}
          value={dimension}
          onChange={(event) => setDimension(event.target.value as Dimension)}
        />
        <TextField label="X" inputMode="numeric" mono value={x} onChange={(e) => setX(e.target.value)} />
        <TextField
          label="Y"
          optional
          inputMode="numeric"
          mono
          value={y}
          help="Empty: on the ground"
          onChange={(e) => setY(e.target.value)}
        />
        <TextField label="Z" inputMode="numeric" mono value={z} onChange={(e) => setZ(e.target.value)} />
      </div>
      <div>
        <Button type="submit" {...power.words('Teleported')} disabled={!ready || power.pending}>
          Teleport
        </Button>
      </div>
      <Failed error={power.error} />
    </form>
  )
}

function ToPlayer({ others, ...props }: PowerProps & { others: readonly { name: string; uuid: string }[] }) {
  const power = usePower(props)
  const [to, setTo] = useState(others[0]?.uuid ?? '')
  // Whoever was picked may have left meanwhile.
  const target = others.some((o) => o.uuid === to) ? to : (others[0]?.uuid ?? '')
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Select
          label="To a player"
          options={others.map((o) => ({ value: o.uuid, label: shownName(o) }))}
          value={target}
          onChange={(event) => setTo(event.target.value)}
        />
        <Button
          {...power.words('Sent')}
          disabled={target === '' || power.pending}
          onClick={() => power.run({ kind: 'to_player', to: target })}
        >
          Send there
        </Button>
      </div>
      <Failed error={power.error} />
    </div>
  )
}

function GiveItem(props: PowerProps) {
  const power = usePower(props)
  const [item, setItem] = useState('')
  const [count, setCount] = useState('1')
  const id = item.trim().toLowerCase()
  const n = whole(count)
  const ready = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(id) && n !== null && n >= 1 && n <= MOST_GIVEN
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-8)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) power.run({ kind: 'give', item: id, count: n })
      }}
    >
      <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <SuggestField
          label="Item"
          mono
          placeholder="diamond"
          help="Its id, as the game names it. A mod’s starts with the mod’s name: create:wrench."
          value={item}
          suggestions={COMMON_ITEMS}
          onPick={setItem}
          onChange={(e) => setItem(e.target.value)}
        />
        <TextField
          label="How many"
          inputMode="numeric"
          mono
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" {...power.words('Given')} disabled={!ready || power.pending}>
          Give
        </Button>
      </div>
      <Failed error={power.error} />
    </form>
  )
}

function Heal(props: PowerProps) {
  const power = usePower(props)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <Button {...power.words('Healed')} disabled={power.pending} onClick={() => power.run({ kind: 'heal' })}>
        Heal and feed
      </Button>
      <Failed error={power.error} />
    </div>
  )
}

function Levels(props: PowerProps) {
  const power = usePower(props)
  const [levels, setLevels] = useState('5')
  const n = whole(levels)
  const ready = n !== null && n >= 1 && n <= 1000
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-8)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) power.run({ kind: 'levels', levels: n })
      }}
    >
      <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <TextField
          label="Experience levels"
          inputMode="numeric"
          mono
          value={levels}
          onChange={(e) => setLevels(e.target.value)}
        />
        <Button type="submit" {...power.words('Given')} disabled={!ready || power.pending}>
          Give levels
        </Button>
      </div>
      <Failed error={power.error} />
    </form>
  )
}

function Kick(props: PowerProps) {
  const power = usePower(props)
  const [reason, setReason] = useState('')
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-8)' }}
      onSubmit={(event) => {
        event.preventDefault()
        power.run({ kind: 'kick', reason: reason.trim() })
      }}
    >
      <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <TextField
          label="Reason"
          optional
          maxLength={200}
          value={reason}
          help="Shown to them as they leave. They can join again."
          onChange={(e) => setReason(e.target.value)}
        />
        <Button type="submit" {...power.words('Kicked')} disabled={power.pending}>
          Kick
        </Button>
      </div>
      <Failed error={power.error} />
    </form>
  )
}

/** Everything they carry is gone for good, so it asks first. */
function ClearInventory(props: PowerProps) {
  const power = usePower(props)
  const [asking, setAsking] = useState(false)
  const name = shownName(props.player)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <Button
        variant="ghost"
        {...power.words('Cleared')}
        disabled={power.pending}
        onClick={() => setAsking(true)}
      >
        Clear inventory
      </Button>
      <Failed error={power.error} />
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title={`Clear ${name}’s inventory?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false)
                power.run({ kind: 'clear_inventory' })
              }}
            >
              Clear it
            </Button>
          </>
        }
      >
        <p className="type-body-sm">
          Everything {name} carries and wears is gone for good. Their ender chest stays as it is.
        </p>
      </Modal>
    </div>
  )
}
