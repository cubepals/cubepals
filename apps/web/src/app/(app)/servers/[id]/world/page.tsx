'use client'

import { type FreshStartView, LEVEL_TYPES, type ServerView, type WorldView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { said, useOutcome } from '../../../../../lib/outcome'
import { levelTypeLabel } from '../../../../../lib/present'
import * as rules from '../../../../../lib/rules'
import { useChecked } from '../../../../../lib/use-checked'
import {
  Badge,
  Button,
  CopyField,
  FormRow,
  FormSection,
  LoadFailed,
  Modal,
  Note,
  Select,
  Skeleton,
  TextField,
  Toggle,
} from '../../../../../ui'
import { ChangeState, ConfirmChange, changeable, useChanged } from '../settings/shared'
import { useServer } from '../use-server'

export default function WorldPage() {
  const server = useServer()
  const trpc = useTRPC()
  const worlds = useQuery(trpc.worlds.list.queryOptions({ serverId: server.id }))
  if (server.isPending || worlds.isPending) return <Skeleton width={240} height={36} />
  if (server.isError) return <LoadFailed error={messageOf(server.error)} onRetry={() => server.refetch()} />
  if (worlds.isError) return <LoadFailed error={messageOf(worlds.error)} onRetry={() => worlds.refetch()} />
  const view = server.data
  const active = worlds.data.find((w) => w.active)
  const others = worlds.data.filter((w) => !w.active)

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        World
      </h1>
      <ChangeState view={view} />
      {active && <Active world={active} />}
      <FreshStart view={view} />
      <NewWorld view={view} />
      {others.length > 0 && <Others view={view} worlds={others} />}
    </>
  )
}

/**
 * A world change takes everyone online with it, into another world, so the confirmation says that
 * rather than the settings' promise that people are back where they were.
 */
function whatSwitching(view: ServerView, world: string): string {
  return view.status === 'running'
    ? `The server saves the world it runs and restarts into ${world}. Anyone online is disconnected, and can join again once it’s up. If ${world} doesn’t start, the server goes back to how it was.`
    : `The server runs ${world} from its next start.`
}

function Active({ world }: { world: WorldView }) {
  return (
    <FormSection
      title={world.name}
      description={
        world.running ? 'The world your server runs.' : 'Your server runs this world from its next start.'
      }
    >
      <FormRow
        label="Type"
        control={
          <span className="bk-row" style={{ gap: 'var(--space-8)' }}>
            {levelTypeLabel(world.levelType)}
            {world.hardcore && <Badge tone="danger">Hardcore</Badge>}
          </span>
        }
      />
      <FormRow
        label="First opened on"
        control={<span className="type-mono-md">Minecraft {world.generatedOnVersion}</span>}
      />
      {world.seed && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <span className="type-label">Seed</span>
          <CopyField value={world.seed} />
        </div>
      )}
    </FormSection>
  )
}

/** What a fresh start is called, what it asks, and what it says once it has happened. */
function freshWords(start: FreshStartView) {
  const back = `Cubepals keeps ${start.leaving} under Other worlds, so you can switch back to it.`
  switch (start.kind) {
    case 'season':
      return {
        title: 'New season',
        description: `Everyone starts again with ${start.hearts} hearts on a fresh world.`,
        action: 'Start a new season',
        ask: 'Start a new season?',
        consequence: `Everyone goes back to ${start.hearts} hearts on a fresh world. Cubepals keeps this season’s world, and you can bring it back from Backups.`,
        done: `${start.name} has begun, and everyone has ${start.hearts} hearts again. Last season is in Backups.`,
      }
    case 'round':
      return {
        title: 'Another round',
        description: 'A fresh world from a new seed, for the next game.',
        action: 'Start another round',
        ask: 'Start another round?',
        consequence: `Everyone starts over on a fresh world. ${back}`,
        done: `${start.name} is the server’s world now. ${start.leaving} is under Other worlds.`,
      }
    case 'world':
      return {
        title: 'Fresh world',
        description: 'A new world from a random seed, in one step.',
        action: 'Start a fresh world',
        ask: 'Start a fresh world?',
        consequence: `The server moves to a new world from a random seed. ${back}`,
        done: `${start.name} is the server’s world now. ${start.leaving} is under Other worlds.`,
      }
  }
}

/**
 * Starting over in one step, named for what the server plays. A new season resets everyone's
 * hearts, which takes the server running; the others wait for its next start like any switch.
 */
function FreshStart({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const start = useQuery(trpc.worlds.freshStart.queryOptions({ serverId: view.id }))
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const outcome = useOutcome(view)
  const begin = useMutation(
    trpc.worlds.startOver.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId: view.id }) })
        void queries.invalidateQueries({ queryKey: trpc.worlds.freshStart.queryKey({ serverId: view.id }) })
        setConfirming(false)
        outcome.settled(next)
      },
    }),
  )
  if (!start.data) return null
  const words = freshWords(start.data)
  const allowed = changeable(view)
  const needsRunning = start.data.kind === 'season' && view.status !== 'running'
  const settled = allowed.ok && view.status !== 'failed' && view.lastChange?.status !== 'failed'
  return (
    <FormSection
      title={words.title}
      description={
        needsRunning && allowed.ok
          ? `${words.description} Start the server first, so Cubepals can reset everyone’s hearts.`
          : words.description
      }
      actions={
        <Button
          variant="outline"
          busy={allowed.busy}
          {...said(outcome, { done: 'Started', failed: 'Didn’t start' })}
          disabled={!allowed.ok || needsRunning}
          onClick={() => {
            setDone(null)
            setConfirming(true)
          }}
        >
          {words.action}
        </Button>
      }
    >
      {done !== null && settled && <Note tone="success">{done}</Note>}
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title={words.ask}
        confirmLabel={view.status === 'running' ? `${words.action} and restart` : words.action}
        working="Making the world"
        error={begin.error}
        onConfirm={async (requestId) => {
          const sentence = words.done
          await begin.mutateAsync({ serverId: view.id, requestId })
          setDone(sentence)
        }}
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {words.consequence}
        </p>
        {view.status === 'running' && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            The server restarts into {start.data.name}. Anyone online can join again once it’s up.
          </p>
        )}
      </ConfirmChange>
    </FormSection>
  )
}

function NewWorld({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const [name, setName] = useState('')
  const [seed, setSeed] = useState('')
  const checkedName = useChecked(rules.worldName, name)
  const checkedSeed = useChecked(rules.seed, seed)
  const [levelType, setLevelType] = useState<WorldView['levelType']>('minecraft:normal')
  const [hardcore, setHardcore] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const outcome = useOutcome(view)
  const create = useMutation(
    trpc.worlds.create.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId: view.id }) })
        setConfirming(false)
        setName('')
        setSeed('')
        outcome.settled(next)
      },
    }),
  )
  const allowed = changeable(view)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (name.trim() && allowed.ok) setConfirming(true)
  }
  return (
    <form onSubmit={submit}>
      <FormSection
        title="Make your own world"
        description="Choose its name, type and seed. The server moves to it. Your current world stays, and you can switch back to it."
        actions={
          <Button
            type="submit"
            variant="primary"
            busy={allowed.busy}
            {...said(outcome, { done: 'Started', failed: 'Didn’t start' })}
            disabled={!name.trim() || !allowed.ok}
          >
            Start new world
          </Button>
        }
      >
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <TextField
            label="Name"
            placeholder="Skyblock"
            maxLength={40}
            value={name}
            error={checkedName.error}
            onChange={(e) => setName(e.target.value)}
            {...checkedName.field}
          />
          <Select
            label="Type"
            value={levelType}
            options={LEVEL_TYPES.map((value) => ({ value, label: levelTypeLabel(value) }))}
            onChange={(e) => setLevelType(e.target.value as WorldView['levelType'])}
          />
        </div>
        <TextField
          label="Seed"
          optional
          mono
          maxLength={32}
          value={seed}
          error={checkedSeed.error}
          onChange={(e) => setSeed(e.target.value)}
          {...checkedSeed.field}
          help="The same seed makes the same world. Leave it empty for a surprise."
        />
        <FormRow
          label="Hardcore"
          description="One life. Players who die can only watch."
          control={<Toggle checked={hardcore} ariaLabel="Hardcore" onChange={setHardcore} />}
        />
      </FormSection>
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Start ${name.trim() || 'a new world'}?`}
        lines={[
          `${levelTypeLabel(levelType)} world${hardcore ? ', hardcore' : ''}${seed.trim() ? `, seed ${seed.trim()}` : ''}`,
        ]}
        confirmLabel={view.status === 'running' ? 'Start it and restart' : 'Start it'}
        working="Making the world"
        error={create.error}
        onConfirm={(requestId) =>
          create.mutateAsync({
            serverId: view.id,
            requestId,
            name: name.trim(),
            levelType,
            hardcore,
            ...(seed.trim() ? { seed: seed.trim() } : {}),
          })
        }
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatSwitching(view, name.trim() || 'the new world')}
        </p>
      </ConfirmChange>
    </form>
  )
}

function Others({ view, worlds }: { view: ServerView; worlds: WorldView[] }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const [switching, setSwitching] = useState<WorldView | null>(null)
  const [deleting, setDeleting] = useState<WorldView | null>(null)
  const refresh = () =>
    queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId: view.id }) })
  const switchTo = useMutation(
    trpc.worlds.switch.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void refresh()
        setSwitching(null)
      },
    }),
  )
  const remove = useMutation(
    trpc.worlds.delete.mutationOptions({
      onSuccess: () => {
        void refresh()
        setDeleting(null)
      },
    }),
  )
  const allowed = changeable(view)
  return (
    <FormSection title="Other worlds" description="Kept on the server until you delete them.">
      {worlds.map((world) => (
        <FormRow
          key={world.id}
          label={world.name}
          description={`${levelTypeLabel(world.levelType)} · first opened on Minecraft ${world.generatedOnVersion}${world.backups > 0 ? ` · ${world.backups} ${world.backups === 1 ? 'backup' : 'backups'}` : ''}`}
          control={
            <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
              <Button variant="ghost" size="sm" disabled={world.running} onClick={() => setDeleting(world)}>
                Delete
              </Button>
              <Button variant="outline" size="sm" disabled={!allowed.ok} onClick={() => setSwitching(world)}>
                Switch to it
              </Button>
            </div>
          }
        />
      ))}
      <ConfirmChange
        open={switching !== null}
        onClose={() => setSwitching(null)}
        title={`Switch to ${switching?.name ?? 'this world'}?`}
        confirmLabel={view.status === 'running' ? 'Switch and restart' : 'Switch'}
        working="Switching worlds"
        error={switchTo.error}
        onConfirm={(requestId) =>
          switchTo.mutateAsync({ serverId: view.id, requestId, worldId: switching?.id ?? '' })
        }
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatSwitching(view, switching?.name ?? 'this world')}
        </p>
      </ConfirmChange>
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'this world'}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate({ serverId: view.id, worldId: deleting.id })}
            >
              Delete world
            </Button>
          </>
        }
      >
        <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
          <p>
            It’s removed from the server the next time it runs.{' '}
            {deleting && deleting.backups > 0
              ? 'Its backups stay, and restoring one brings it back.'
              : 'It has no backups, so it’s gone for good.'}
          </p>
          {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
        </div>
      </Modal>
    </FormSection>
  )
}
