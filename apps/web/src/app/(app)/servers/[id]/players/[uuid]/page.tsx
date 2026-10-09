'use client'

/**
 * One player's page, opened from the Players tab: who they are and when they were here, where they
 * died and a way back there, where they are and a way to the spawn, their own game mode, what they
 * carry (`inventory.tsx`), and whether they can join, run commands or are banned (`switches.tsx`).
 * A change for someone who is away waits for them to join, and the page says so, with a way to
 * take it back. While the server sleeps, it shows what was kept as it went to sleep.
 */
import type { GameMode, PlaceView, PlayerView, WaitingView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { said, useOutcome } from '../../../../../../lib/outcome'
import { timeAgo } from '../../../../../../lib/present'
import { Button, EmptyState, FormSection, ICON, Note, PlayerFace, Skeleton, Tabs } from '../../../../../../ui'
import { useServer } from '../../use-server'
import { Inventory } from './inventory'
import { AccessSwitches } from './switches'

export default function PlayerPage() {
  const server = useServer()
  const { uuid } = useParams<{ uuid: string }>()
  const trpc = useTRPC()
  const player = useQuery({
    ...trpc.players.get.queryOptions({ serverId: server.id, playerUuid: uuid }),
    // Where someone on is changes as they play: read again while the page is open, and only then.
    refetchInterval: (q) => (q.state.data?.online ? 10_000 : false),
  })

  if (server.isPending || player.isPending) return <Skeleton width={240} height={36} />
  if (server.isError || player.isError)
    return (
      <EmptyState
        danger
        title="We could not load this player"
        description={messageOf(server.error ?? player.error)}
      />
    )

  const p = player.data
  const running = server.data.status === 'running'
  return (
    <>
      <Link href={`/servers/${server.id}/players`} className="bk-backlink">
        <ChevronLeft {...ICON} aria-hidden />
        Players
      </Link>
      <header className="bk-row" style={{ gap: 'var(--space-16)' }}>
        <PlayerFace name={p.name} uuid={p.uuid} size={64} />
        <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
          <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
            {p.name}
          </h1>
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            {statsLine(p)}
          </p>
        </div>
      </header>

      <Source player={p} running={running} />

      {p.source !== 'none' && (
        <>
          <Places serverId={server.id} player={p} />
          <GameModeSection serverId={server.id} player={p} />
          {p.inventory && (
            <Inventory inventory={p.inventory} gameVersion={server.data.gameVersion} name={p.name} />
          )}
        </>
      )}
      <AccessSwitches serverId={server.id} player={p} running={running} />
    </>
  )
}

/** Playtime, deaths and when they were last here, on one line. */
function statsLine(p: PlayerView): string {
  const parts = [
    p.online ? 'Playing now' : null,
    played(p.stats?.playMinutes ?? null),
    // The game writes its stats file every few minutes; a death it already knows of outruns it.
    died(p.stats?.deaths === 0 && p.lastDeath !== null ? null : (p.stats?.deaths ?? null)),
    !p.online && p.lastSeenAt ? `Last seen ${timeAgo(p.lastSeenAt, Date.now())}` : null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : 'Hasn’t joined yet'
}

function played(minutes: number | null): string | null {
  if (minutes === null) return null
  if (minutes < 60) return `Played ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  return `Played ${hours} hour${hours === 1 ? '' : 's'}`
}

function died(deaths: number | null): string | null {
  if (deaths === null) return null
  return deaths === 0 ? 'Never died' : deaths === 1 ? 'Died once' : `Died ${deaths} times`
}

/** Where what the page shows comes from, when it isn't the game this moment. */
function Source({ player, running }: { player: PlayerView; running: boolean }) {
  if (player.source === 'snapshot' && player.asOf)
    return <Note tone="info">As of when the server went to sleep, {timeAgo(player.asOf, Date.now())}.</Note>
  if (player.source !== 'none') return null
  if (player.lastSeenAt === null) return null
  return (
    <Note tone="info">
      {running
        ? `Cubepals couldn’t read where ${player.name} is just now.`
        : `Where ${player.name} is shows once the server wakes.`}
    </Note>
  )
}

const DIMENSIONS: Record<string, string> = {
  'minecraft:overworld': 'the Overworld',
  'minecraft:the_nether': 'the Nether',
  'minecraft:the_end': 'the End',
}

/** "the Nether, at 12, 70, 34": blocks, as the game's own coordinates show them. */
function placeLine(place: PlaceView): string {
  const world =
    DIMENSIONS[place.dimension] ??
    place.dimension.slice(place.dimension.indexOf(':') + 1).replaceAll('_', ' ')
  return `${world}, at ${[place.x, place.y, place.z].map((n) => Math.floor(n)).join(', ')}`
}

function Places({ serverId, player }: { serverId: string; player: PlayerView }) {
  const trip = player.waiting.find((w) => w.kind === 'place')
  return (
    <>
      <FormSection
        title={`Where ${player.name} died`}
        description={
          player.lastDeath ? `In ${placeLine(player.lastDeath)}.` : `${player.name} hasn’t died here.`
        }
      >
        {player.lastDeath && (
          <Trip
            serverId={serverId}
            player={player}
            to="death"
            label="Take them back"
            waiting={trip?.what === 'death' ? trip : undefined}
          />
        )}
      </FormSection>
      <FormSection
        title={`Where ${player.name} is`}
        description={
          player.position
            ? `${player.online ? 'In' : 'Last in'} ${placeLine(player.position)}.`
            : 'Nowhere yet.'
        }
      >
        <Trip
          serverId={serverId}
          player={player}
          to="spawn"
          label="Bring to spawn"
          waiting={trip?.what === 'spawn' ? trip : undefined}
        />
      </FormSection>
    </>
  )
}

/** One trip: done at once for someone on, or kept until they next join. */
function Trip({
  serverId,
  player,
  to,
  label,
  waiting,
}: {
  serverId: string
  player: PlayerView
  to: 'death' | 'spawn'
  label: string
  waiting: WaitingView | undefined
}) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const outcome = useOutcome(undefined)
  const go = useMutation(
    trpc.players.teleport.mutationOptions({
      onSuccess: (result) => {
        if (result.done === 'now') outcome.settled()
        refresh()
      },
      onError: () => outcome.refused(),
    }),
  )
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      {waiting ? (
        <Waiting serverId={serverId} player={player} kind="place">
          {to === 'death'
            ? `When ${player.name} next joins, they go back there.`
            : `When ${player.name} next joins, they go to the spawn.`}
        </Waiting>
      ) : (
        <div>
          <Button
            {...said(outcome, { done: 'Done', failed: 'Didn’t go' })}
            disabled={go.isPending}
            onClick={() => go.mutate({ serverId, playerUuid: player.uuid, to })}
          >
            {label}
          </Button>
        </div>
      )}
      {go.isError && <Note tone="danger">{messageOf(go.error)}</Note>}
    </div>
  )
}

const MODES: Array<{ value: GameMode; label: string }> = [
  { value: 'survival', label: 'Survival' },
  { value: 'creative', label: 'Creative' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'spectator', label: 'Spectator' },
]

function GameModeSection({ serverId, player }: { serverId: string; player: PlayerView }) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const set = useMutation(trpc.players.setGameMode.mutationOptions({ onSettled: refresh }))
  const waiting = player.waiting.find((w) => w.kind === 'game_mode')
  const label = (mode: string) => MODES.find((m) => m.value === mode)?.label ?? mode
  return (
    <FormSection title="Game mode" description={`For ${player.name} alone.`}>
      <Tabs
        label="Game mode"
        items={MODES}
        value={(waiting?.what as GameMode | undefined) ?? player.gameMode ?? 'survival'}
        onChange={(mode) => set.mutate({ serverId, playerUuid: player.uuid, mode })}
      />
      {waiting && (
        <Waiting serverId={serverId} player={player} kind="game_mode">
          {`${label(waiting.what)} when ${player.name} next joins.`}
        </Waiting>
      )}
      {set.isError && <Note tone="danger">{messageOf(set.error)}</Note>}
    </FormSection>
  )
}

/** Something kept for when they next join, and the way to take it back. */
function Waiting({
  serverId,
  player,
  kind,
  children,
}: {
  serverId: string
  player: PlayerView
  kind: 'place' | 'game_mode'
  children: string
}) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const cancel = useMutation(trpc.players.cancel.mutationOptions({ onSettled: refresh }))
  return (
    <div className="bk-row" style={{ gap: 'var(--space-12)', flexWrap: 'wrap' }}>
      <p className="bk-field__help" style={{ margin: 0 }}>
        {children}
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate({ serverId, playerUuid: player.uuid, kind })}
      >
        Cancel
      </Button>
    </div>
  )
}

function useRefresh(serverId: string, playerUuid: string) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return () =>
    void queries.invalidateQueries({ queryKey: trpc.players.get.queryKey({ serverId, playerUuid }) })
}
