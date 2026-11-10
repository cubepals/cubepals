// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What an owner would otherwise type into the console for one player, as buttons on their page: a
 * trip to coordinates or to someone else playing, an item, picked from every item the release has
 * (`item-field.tsx`), health and hunger back, levels, a kick, and an emptied inventory, which asks
 * first and is kept to put back (`kept-inventories.tsx`).
 * Each is done at once while the player is on. For someone away, or a server asleep, a trip,
 * items, levels and an emptying wait for their next join, and the page says what waits
 * (`waiting.tsx`); a heal, a kick and a trip to someone else show only while they play. The
 * player is told in chat what was done, unless the server's Settings turn that off. The commands
 * are the control plane's to build (`minecraft/player-powers.ts`), never typed here.
 */
import {
  type DIMENSIONS,
  MOST_GIVEN,
  MOST_LEVELS,
  type PlayerPower,
  type PlayerView,
  shownName,
} from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { said, useOutcome } from '../../../../../../lib/outcome'
import { Button, FormSection, Modal, Note, Select, TextField } from '../../../../../../ui'
import { ItemField } from './item-field'
import { KeptInventories } from './kept-inventories'
import { useRefresh, Waiting, waitingOf } from './waiting'

type Dimension = (typeof DIMENSIONS)[number]

const WORLDS: Array<{ value: Dimension; label: string }> = [
  { value: 'minecraft:overworld', label: 'Overworld' },
  { value: 'minecraft:the_nether', label: 'Nether' },
  { value: 'minecraft:the_end', label: 'End' },
]

/** A whole number from a field, or null where it holds none. */
function whole(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) return null
  return Number(trimmed)
}

export function PlayerPowers({
  serverId,
  player,
  running,
  others,
  tellPlayers,
  gameVersion,
}: {
  serverId: string
  player: PlayerView
  running: boolean
  /** The server's release, whose items the item field offers. */
  gameVersion: string
  /** Whether the player is told in chat what was done to them, as this server's Settings say. */
  tellPlayers: boolean
  /** Everyone else playing now, for a trip to one of them. */
  others: readonly { name: string; uuid: string }[]
}) {
  const name = shownName(player)
  const on = running && player.online
  return (
    <>
      <FormSection
        title="Teleport"
        description={
          on ? `Send ${name} to coordinates, or to someone playing.` : `Send ${name} there as they next join.`
        }
      >
        <ToPlace serverId={serverId} player={player} />
        <Kept serverId={serverId} player={player} kind="place" />
        {on && others.length > 0 && <ToPlayer serverId={serverId} player={player} others={others} />}
      </FormSection>
      <FormSection
        title="Give an item"
        description={
          on ? `Straight into ${name}’s inventory.` : `Into ${name}’s inventory as they next join.`
        }
      >
        <GiveItem serverId={serverId} player={player} gameVersion={gameVersion} />
        <Kept serverId={serverId} player={player} kind="give" />
      </FormSection>
      <FormSection
        title="Quick actions"
        description={
          on ? undefined : `These wait for ${name} to join. Healing and kicking show while they play.`
        }
      >
        <div className="bk-row" style={{ gap: 'var(--space-12)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {on && <Heal serverId={serverId} player={player} />}
          <ClearInventory serverId={serverId} player={player} />
        </div>
        <Kept serverId={serverId} player={player} kind="clear_inventory" />
        <KeptInventories serverId={serverId} player={player} />
        <Levels serverId={serverId} player={player} />
        <Kept serverId={serverId} player={player} kind="levels" />
        {on && <Kick serverId={serverId} player={player} />}
      </FormSection>
      <p className="bk-field__help">
        {tellPlayers
          ? `${name} sees a line in chat each time, or as they join for what waited for them. `
          : `${name} isn’t told in chat. `}
        <Link href={`/servers/${serverId}/settings`}>Change this in Settings</Link>
      </p>
    </>
  )
}

interface PowerProps {
  serverId: string
  player: PlayerView
}

/**
 * One power's call, its button's words for how it went, and the page read again after. Kept for
 * their next join, the button says nothing: the line under it says what waits.
 */
function usePower({ serverId, player }: PowerProps) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const outcome = useOutcome(undefined)
  const act = useMutation(
    trpc.players.act.mutationOptions({
      onSuccess: (result) => {
        if (result.done === 'now') outcome.settled()
      },
      onError: () => outcome.refused(),
      onSettled: refresh,
    }),
  )
  return {
    run: (power: PlayerPower) => act.mutate({ serverId, playerUuid: player.uuid, power }),
    pending: act.isPending,
    error: act.isError ? messageOf(act.error) : null,
    words: (done: string) => said(outcome, { done, failed: 'Didn’t work' }),
  }
}

/** What waits of one kind for their next join, in a sentence, with a way to take it back. */
function Kept({
  serverId,
  player,
  kind,
}: PowerProps & { kind: 'place' | 'give' | 'levels' | 'clear_inventory' }) {
  const line = keptLine(player, kind)
  if (line === null) return null
  return (
    <Waiting serverId={serverId} player={player} kind={kind}>
      {line}
    </Waiting>
  )
}

function keptLine(player: PlayerView, kind: 'place' | 'give' | 'levels' | 'clear_inventory'): string | null {
  const when = `When ${shownName(player)} next joins`
  switch (kind) {
    case 'place': {
      const trip = waitingOf(player, 'place')
      if (trip?.what !== 'there') return null
      const world = WORLDS.find((w) => w.value === trip.there.dimension)?.label ?? trip.there.dimension
      const { x, y, z } = trip.there
      const at = y === null ? `${x}, ${z}, on the ground` : `${x}, ${y}, ${z}`
      return `${when}, they go to ${at} in the ${world}.`
    }
    case 'give': {
      const items = waitingOf(player, 'give')?.items ?? []
      if (items.length === 0) return null
      return `${when}, they get ${items.map((i) => `${i.count} ${itemName(i.item)}`).join(', ')}.`
    }
    case 'levels': {
      const levels = waitingOf(player, 'levels')?.levels
      return levels === undefined ? null : `${when}, they get ${levels} levels.`
    }
    case 'clear_inventory':
      return waitingOf(player, 'clear_inventory')
        ? `${when}, their inventory is emptied, before any items waiting for them.`
        : null
  }
}

/** `minecraft:golden_apple` reads "golden apple"; a mod's keeps its name: `create:wrench`. */
function itemName(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length).replaceAll('_', ' ') : id
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

function GiveItem({ gameVersion, ...props }: PowerProps & { gameVersion: string }) {
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
        <ItemField gameVersion={gameVersion} value={item} onChange={setItem} />
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
  const ready = n !== null && n >= 1 && n <= MOST_LEVELS
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
          Everything {name} carries and wears is taken away. Cubepals keeps it first, so you can put it back
          at their feet later. Their ender chest stays as it is. If they’re away, it happens as they next
          join, and you can cancel it until then.
        </p>
      </Modal>
    </div>
  )
}
