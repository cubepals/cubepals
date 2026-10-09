'use client'

import type { OperationView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Moon, Play, RotateCw, Sunrise } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { codeOf, messageOf, useTRPC } from '../../../../lib/api'
import { useNow, useSince } from '../../../../lib/hooks'
import { said, useOutcome } from '../../../../lib/outcome'
import {
  busyWord,
  clockTime,
  dayOf,
  etaLine,
  joinLine,
  loaderWithBuild,
  packToInstall,
  presentProgress,
  presentStatus,
  whenItGoes,
} from '../../../../lib/present'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CopyField,
  EmptyState,
  GetPack,
  ICON,
  Note,
  PackBadge,
  PlayerFace,
  ProvisioningPanel,
  Skeleton,
  StatusPill,
} from '../../../../ui'
import { PlusOffer } from '../../plus-offer'
import { BootLine } from './boot-line'
import { useChanged } from './settings/shared'
import { requestId, useServer } from './use-server'

export default function OverviewPage() {
  const server = useServer()
  if (server.isPending) return <OverviewSkeleton />
  if (server.isError)
    return (
      <EmptyState
        danger
        title="We could not reach this server"
        description={messageOf(server.error)}
        action={
          <Button variant="primary" onClick={() => server.refetch()}>
            Try again
          </Button>
        }
      />
    )
  return <Overview server={server.data} />
}

function Overview({ server }: { server: ServerView }) {
  // The panel with the steps and the bar is for a world that isn't there yet: the first build,
  // where there is nothing else to show. Everything after that — waking, applying a change,
  // restoring, moving — happens to a world the owner is already looking at, so the page stays
  // where it is and the status and the button carry the state.
  const progress = server.activeOperation ? presentProgress(server.activeOperation, server) : null
  if (progress && server.activeOperation && server.status === 'provisioning')
    return <Working server={server} progress={progress} operation={server.activeOperation} />

  const status = presentStatus(server)
  // A pack everyone installs is part of joining, so how to get it sits with the address.
  const pack = packToInstall(server)
  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {server.name}
        </h1>
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }}>
          <StatusPill status={status.pill} {...(status.label ? { label: status.label } : {})} />
          <span className="type-body-sm bk-num" style={{ color: 'var(--ink-muted)' }}>
            {status.detail}
          </span>
        </div>
        <div className="bk-stack" style={{ maxWidth: 'var(--width-form)', gap: 'var(--space-8)' }}>
          <CopyField value={server.joinAddress} />
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            {joinLine(server.gameVersion, pack)}
          </p>
          {pack && <GetPack pack={pack} gameVersion={server.gameVersion} quiet />}
        </div>
      </header>

      {server.status === 'failed' ? <Failed server={server} /> : <Actions server={server} />}

      <div className="bk-grid">
        <PlayersCard server={server} />
        <Card title="Version" href={`/servers/${server.id}/settings`}>
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
            <Badge mono>{server.gameVersion}</Badge>
            {/* A pack's loader is the pack's business: what it plays is the pack, at its version. */}
            {server.modpack ? (
              <PackBadge
                name={`${server.modpack.name} ${server.modpack.version}`}
                icon={server.modpack.icon}
              />
            ) : (
              <Badge>{loaderWithBuild(server.loader, server.loaderVersion)}</Badge>
            )}
            <Badge>{server.playStyle === 'creative' ? 'Creative' : 'Survival'}</Badge>
          </div>
          {/* Where it runs is Blockly's business: the settings page has it for anyone who wants
              to move it. What an owner needs here is how many can play. */}
          <p className="bk-card__desc">Up to {server.maxPlayers} players at once.</p>
        </Card>
        <WhoCanJoinCard serverId={server.id} />
      </div>
    </>
  )
}

function Working({
  server,
  progress,
  operation,
}: {
  server: ServerView
  progress: NonNullable<ReturnType<typeof presentProgress>>
  operation: OperationView
}) {
  const now = useNow(1_000)
  // Within a step the bar keeps creeping on, slower as it goes, and never reaches the next one:
  // it moves because the server is working, and only the server moves it to the next step.
  const since = useSince(operation.step)
  const within = 1 - Math.exp(-(now - since) / 10_000)
  const percent = Math.min(95, ((progress.index + 0.9 * within) / progress.steps.length) * 100)
  const pack = packToInstall(server)
  return (
    <ProvisioningPanel
      title={progress.title}
      eta={etaLine(operation.startedAt, progress.expectedSeconds, now)}
      progress={percent}
      steps={progress.steps}
      live={server.status === 'provisioning' ? <BootLine server={server} step={operation.step} /> : undefined}
    >
      {server.status === 'updating' || server.status === 'restoring' ? (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Players online are back in as soon as it is up. If it doesn’t start, the server goes back to how it
          was.
        </p>
      ) : server.status === 'relocating' ? (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          The address stays the same. Your friends can join again once it is up.
        </p>
      ) : (
        <>
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="type-label" style={{ color: 'var(--ink)' }}>
              Send this to your friends while you wait
            </span>
            <CopyField value={server.joinAddress} />
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              {joinLine(server.gameVersion, pack)}
            </p>
          </div>
          {/* A pack takes a while to get too: the wait for the world is the time to get it. */}
          {pack && <GetPack pack={pack} gameVersion={server.gameVersion} quiet />}
        </>
      )}
    </ProvisioningPanel>
  )
}

function Actions({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const start = useMutation(trpc.servers.start.mutationOptions())
  const stop = useMutation(trpc.servers.stop.mutationOptions())
  const restart = useMutation(trpc.servers.restart.mutationOptions())
  const error = start.error ?? stop.error ?? restart.error
  // Each button says when the server has finished what it was pressed for.
  const power = useOutcome(server)
  const again = useOutcome(server)
  // Keeping a server made for a while takes its note away, so the word that it worked is here.
  const kept = useOutcome(undefined)
  const pressed = (outcome: ReturnType<typeof useOutcome>) => (next: ServerView) => {
    changed(next)
    outcome.settled(next)
  }

  const running = server.status === 'running'
  // A world resting while nobody plays is asleep like any other; waking is its only action.
  const stopped = server.status === 'stopped' || server.status === 'stored' || server.status === 'storing'
  const asleep = presentStatus(server).pill === 'sleeping'
  // The plan's own limits are worth saying while they matter: once someone is playing, or once
  // the stop is close. On a world nobody has joined yet they are just noise at the top.
  const minute = useNow(60_000)
  const playing = (server.players?.online ?? 0) > 0
  const endingSoon = server.sessionEndsAt !== null && Date.parse(server.sessionEndsAt) - minute < 30 * 60_000

  // Stopping a world in Blockly is putting it to sleep: it is saved, and the next player to join
  // wakes it. The button says that. One button carries every phase, so its colour and its icon
  // move from one to the next instead of being replaced by another button mid-change.
  const phases = {
    sleep: {
      icon: <Moon {...ICON} aria-hidden />,
      label: 'Put it to sleep',
      working: 'Putting it to sleep',
      failed: 'Still awake',
      done: 'Asleep',
      variant: 'secondary' as const,
      run: (requestId: string) => stop.mutateAsync({ serverId: server.id, requestId }).then(pressed(power)),
    },
    wake: {
      icon: <Sunrise {...ICON} aria-hidden />,
      label: 'Wake it up',
      working: 'Waking it up',
      failed: 'Didn’t wake',
      done: 'Awake',
      variant: 'sleeping' as const,
      run: (requestId: string) => start.mutateAsync({ serverId: server.id, requestId }).then(pressed(power)),
    },
    start: {
      icon: <Play {...ICON} aria-hidden />,
      label: 'Start again',
      working: 'Starting it',
      failed: 'Didn’t start',
      done: 'Started',
      variant: 'secondary' as const,
      run: (requestId: string) => start.mutateAsync({ serverId: server.id, requestId }).then(pressed(power)),
    },
  }
  const busy = server.activeOperation
  // Mid-restart the server is neither running nor stopped, and the button beside it is dimmed:
  // it keeps the face it had rather than offering to start what is already starting.
  const now = running ? 'sleep' : asleep ? 'wake' : busy !== null ? 'sleep' : 'start'

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }}>
        <ActionButton
          phases={phases}
          now={now}
          busy={busy?.kind === 'restart' ? undefined : busyWord(server.activeOperation)}
          said={power.said}
          disabled={busy?.kind === 'restart'}
        />
        {/* Restart stays while the server is busy, so a restart morphs on the button that was
            pressed rather than unmounting halfway through stopping and starting again. */}
        {!stopped && (
          <ActionButton
            phases={{
              restart: {
                icon: <RotateCw {...ICON} aria-hidden />,
                label: 'Restart',
                working: 'Restarting',
                failed: 'Didn’t restart',
                done: 'Restarted',
                variant: 'outline' as const,
                run: (requestId: string) =>
                  restart.mutateAsync({ serverId: server.id, requestId }).then(pressed(again)),
              },
            }}
            now="restart"
            busy={busy?.kind === 'restart' ? busyWord(busy) : undefined}
            said={again.said}
            disabled={busy !== null && busy.kind !== 'restart'}
          />
        )}
      </div>
      {running && server.sessionEndsAt && (playing || endingSoon) && (
        <Note tone="info">
          <span>
            This server stops at {clockTime(server.sessionEndsAt)}, saving the world first. You can start it
            again straight away.
          </span>
        </Note>
      )}
      {server.deletesAt !== null && <Unplayed server={server} at={server.deletesAt} />}
      {server.expiresAt !== null && (
        <MadeForAWhile server={server} at={server.expiresAt} onKept={() => kept.settled()} />
      )}
      {kept.said === 'done' && <Note tone="success">Kept. It stays until you delete it.</Note>}
      {running && <NextStep server={server} />}
      {stopped && server.crash?.outOfMemory && <MoreRoom server={server} />}
      {/* A server its plan no longer runs (mods after Plus ended) waits for the plan that does. */}
      {error && codeOf(error) === 'not_entitled' ? (
        <PlusOffer why={messageOf(error)} reason="mods" />
      ) : (
        error && <Note tone="danger">{messageOf(error)}</Note>
      )}
    </div>
  )
}

/**
 * A Free world nobody has played for most of a year. The date it goes, a way to keep it and a
 * way to take it home, here as in the two emails before it: never gone without being asked.
 */
function Unplayed({ server, at }: { server: ServerView; at: string }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const keep = useMutation(trpc.servers.keepWorld.mutationOptions({ onSuccess: (next) => changed(next) }))
  return (
    <Note tone="info">
      <span>
        Nobody has played {server.name} for almost a year. Free worlds are kept for a year after they were
        last played, so Cubepals deletes it on {dayOf(at)}, into the trash for a week after. Keep it, and it
        stays another year.
      </span>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', marginBlockStart: 'var(--space-12)' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={keep.isPending}
          onClick={() => keep.mutate({ serverId: server.id })}
        >
          {keep.isPending ? 'Keeping it…' : 'Keep it'}
        </Button>
        <Button variant="ghost" size="sm" href={`/servers/${server.id}/backups`}>
          Download it
        </Button>
      </div>
      {keep.isError && <Note tone="danger">{messageOf(keep.error)}</Note>}
    </Note>
  )
}

/**
 * A server its owner asked for only for a while. It says when it goes and what happens to the
 * world, from the day it is made rather than in an email the day it does, and keeping it is one
 * press — Blockly's automation is always visible and always has a way back.
 */
function MadeForAWhile({ server, at, onKept }: { server: ServerView; at: string; onKept: () => void }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const now = useNow(60_000)
  const keep = useMutation(
    trpc.servers.keep.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        onKept()
      },
    }),
  )
  return (
    <Note tone="info">
      <span>
        You made this one for a while: Cubepals deletes it {whenItGoes(at, now)}. Its world goes to the trash,
        where you can bring it back for as long as your plan keeps it.
      </span>
      <div style={{ marginBlockStart: 'var(--space-12)' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={keep.isPending}
          onClick={() => keep.mutate({ serverId: server.id })}
        >
          {keep.isPending ? 'Keeping it…' : 'Keep it'}
        </Button>
      </div>
    </Note>
  )
}

/**
 * Out of memory, with the way out in one press. Blockly already knows which size is next, so it
 * offers that one by name rather than sending someone to a page of sizes to work it out. Bigger
 * servers use the plan's hours faster, which is why it says so and never does it by itself.
 */
function MoreRoom({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const roomier = useOutcome(server)
  const resize = useMutation(
    trpc.servers.resize.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        roomier.settled(next)
      },
    }),
  )
  const bigger = server.roomier
  // A plan with bigger sizes than this one, which is the only other way to more room.
  const overview = useQuery(trpc.account.overview.queryOptions())
  const roomierPlan = overview.data?.plans.find(
    (p) => p.entitlements.sizeLabels.length > (overview.data?.entitlements.sizeLabels.length ?? 0),
  )
  return (
    <Note tone="info">
      <span>
        It ran out of memory: its world, mods or players needed more than this size has.{' '}
        {bigger === null ? (
          <>
            It is already on the biggest size your plan offers. Fewer mods or a smaller view distance leave it
            more room.
          </>
        ) : (
          <>A {bigger.label} server gives it room. It uses your hours faster while it runs.</>
        )}
      </span>
      {bigger !== null && (
        <div style={{ marginBlockStart: 'var(--space-12)' }}>
          <Button
            variant="secondary"
            size="sm"
            busy={server.activeOperation ? busyWord(server.activeOperation) : undefined}
            {...said(roomier, { done: 'Resized', failed: 'Didn’t resize' })}
            disabled={resize.isPending}
            onClick={() =>
              resize.mutate({
                serverId: server.id,
                partySize: bigger.partySize,
                requestId: requestId(),
                version: server.version,
              })
            }
          >
            {resize.isPending ? 'Making room…' : `Give it ${bigger.label}`}
          </Button>
        </div>
      )}
      {resize.isError && <Note tone="danger">{messageOf(resize.error)}</Note>}
      {bigger === null && roomierPlan !== undefined && (
        <PlusOffer
          why={`A bigger server comes with ${title(roomierPlan.key)}.`}
          plan={roomierPlan.key}
          reason="size"
        />
      )}
    </Note>
  )
}

const title = (plan: string) => `${plan[0]?.toUpperCase() ?? ''}${plan.slice(1)}`

/**
 * A server that didn't start. The title and the sentence under it come from what the server
 * itself said (`minecraft/diagnosis.ts`), and where Blockly recognised the failure there is one
 * action beside "Try again" that actually fixes it, rather than a log to read.
 */
function Failed({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const retry = useMutation(trpc.servers.retry.mutationOptions())
  const resize = useMutation(trpc.servers.resize.mutationOptions({ onSuccess: (next) => changed(next) }))
  const remedy = server.failure?.remedy ?? null
  const bigger = server.roomier
  const fix =
    remedy === 'more_room' && bigger !== null ? (
      <Button
        variant="primary"
        disabled={resize.isPending}
        onClick={() =>
          resize.mutate({
            serverId: server.id,
            partySize: bigger.partySize,
            requestId: requestId(),
            version: server.version,
          })
        }
      >
        {resize.isPending ? 'Making room…' : `Give it ${bigger.label}`}
      </Button>
    ) : remedy === 'modpack' && server.failure?.during === 'provisioning' ? (
      // Its first build failed on the pack: nothing was ever in it, so the way out is another
      // pack, under the same name and address.
      <Button variant="primary" href={`/servers/new?replace=${server.id}`}>
        Pick another pack
      </Button>
    ) : remedy === 'mods' || remedy === 'modpack' ? (
      <Button variant="primary" href={`/servers/${server.id}/mods`}>
        {remedy === 'modpack' ? 'Look at its modpack' : 'Change its mods'}
      </Button>
    ) : remedy === 'restore' ? (
      <Button variant="primary" href={`/servers/${server.id}/backups`}>
        Restore a backup
      </Button>
    ) : null

  return (
    <EmptyState
      danger
      title={presentStatus(server).detail}
      description={server.failure?.message}
      action={
        <div className="bk-row" style={{ gap: 'var(--space-12)', justifyContent: 'center' }}>
          {fix}
          <Button
            variant={fix === null ? 'primary' : 'outline'}
            disabled={retry.isPending}
            onClick={() => retry.mutate({ serverId: server.id, requestId: requestId() })}
          >
            Try again
          </Button>
        </div>
      }
    />
  )
}

/** Faces in the players card: enough to see who's on, few enough to stay one row. */
const FACES_SHOWN = 5

function PlayersCard({ server }: { server: ServerView }) {
  const online = server.players
  return (
    <Card title="Players" href={`/servers/${server.id}/players`}>
      {online && online.online > 0 ? (
        <>
          <div className="bk-row" style={{ gap: 'var(--space-12)', justifyContent: 'space-between' }}>
            <p className="type-heading-md bk-num" style={{ color: 'var(--ink)' }}>
              {online.online} / {server.maxPlayers}
            </p>
            <div className="bk-avatars">
              {online.people.slice(0, FACES_SHOWN).map((player) => (
                <PlayerFace key={player.uuid} name={player.name} uuid={player.uuid} size={28} />
              ))}
            </div>
          </div>
          <p className="bk-card__desc">{online.people.map((player) => player.name).join(', ')}</p>
        </>
      ) : (
        <p className="bk-card__desc">
          {server.status === 'running'
            ? 'Nobody’s online right now. Send your friends the address.'
            : 'Start the server and your friends can join.'}
        </p>
      )}
    </Card>
  )
}

function WhoCanJoinCard({ serverId }: { serverId: string }) {
  const trpc = useTRPC()
  const access = useQuery(trpc.access.get.queryOptions({ serverId }))
  const whitelist = access.data?.pendingWhitelistEnabled ?? access.data?.whitelistEnabled
  const listed =
    access.data?.entries.filter((e) => e.list === 'whitelist' && e.state !== 'pending_remove').length ?? 0
  return (
    <Card title="Who can join" href={`/servers/${serverId}/players`}>
      {access.isPending ? (
        <Skeleton width="70%" />
      ) : (
        <p className="bk-card__desc">
          {whitelist
            ? `Only people you add — ${listed} ${listed === 1 ? 'player' : 'players'} so far.`
            : 'Anyone with the address can join.'}
        </p>
      )}
    </Card>
  )
}

function OverviewSkeleton() {
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-16)' }} aria-busy>
      <Skeleton width={320} height={36} />
      <Skeleton width={180} height={20} />
      <Skeleton width="min(560px, 100%)" height={48} />
    </div>
  )
}

/**
 * The one suggestion Blockly makes: a first world, online and still bare, is the moment someone
 * finds out it can run mods. It goes when it is used, when it is waved away, and for good once
 * the account has a second server or the world has a mod.
 */
/**
 * The one thing worth doing next, and only while it is true. Blockly's onboarding is this:
 * a sentence in the place the work happens, about something real — get a friend in, or make the
 * world yours — dismissible, never repeated, and never a tour.
 */
function NextStep({ server }: { server: ServerView }) {
  if (!server.everPlayed) return <FirstFriend server={server} />
  // A pack chose its mods, and a server playing one has no list of its own to add to.
  if (server.onlyServer && server.modCount === 0 && server.modpack === null)
    return <FirstMod server={server} />
  return null
}

/** Nobody has joined yet: the only thing missing is the link, so here it is. */
function FirstFriend({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const share = useQuery(trpc.sharing.own.queryOptions({ serverId: server.id }))
  const { hidden, dismiss } = useNudge(`blockly.first-friend.${server.id}`)
  if (hidden || share.data === undefined) return null
  return (
    <Note tone="success">
      <span className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <span>Nobody has joined yet. This link shows your friends what the server is and how to get in.</span>
        <CopyField value={share.data.inviteUrl} label="Copy link" />
        <span>
          <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={dismiss}>
            Got it
          </button>
        </span>
      </span>
    </Note>
  )
}

/** Remembering that a suggestion was taken, in the only place that knows: this browser. */
function useNudge(key: string) {
  const [hidden, setHidden] = useState(true)
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(key) === 'done')
    } catch {
      setHidden(false)
    }
  }, [key])
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(key, 'done')
    } catch {
      // A browser that refuses storage simply sees the suggestion again.
    }
  }
  return { hidden, dismiss }
}

function FirstMod({ server }: { server: ServerView }) {
  const { hidden, dismiss } = useNudge(`blockly.suggested-mods.${server.id}`)
  if (hidden) return null
  return (
    <Note tone="success">
      <span className="bk-row bk-wrap" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
        <span>Make it yours: Cubepals can add a mod and keep your world.</span>
        <Link href={`/servers/${server.id}/mods`} onClick={dismiss}>
          Find one
        </Link>
        <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={dismiss}>
          Not now
        </button>
      </span>
    </Note>
  )
}
