'use client'

import type { Loader, PartySize, ServerView, SettingsOptions } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type SubmitEvent, useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { type Outcome, said, useOutcome } from '../../../../../lib/outcome'
import { loaderLabel, presentConflict, presentPlan, runsOnPaper } from '../../../../../lib/present'
import { Button, FormSection, Note, Select, Skeleton } from '../../../../../ui'
import { ConfirmChange, changeable, planLines, RevokedChoice, useChanged, whatHappens } from './shared'

const LOADER_HELP: Record<Loader, string> = {
  vanilla: 'Minecraft as it comes.',
  paper: 'Runs plugins, and keeps busy servers smooth.',
  fabric: 'Runs Fabric mods.',
  quilt: 'Runs Quilt and most Fabric mods.',
  neoforge: 'Runs NeoForge mods.',
  forge: 'Runs Forge mods.',
}

/** Plain Minecraft as Cubepals runs it where it can, said where the server type is. */
const ON_PAPER_HELP =
  'Minecraft as it comes. Cubepals runs it on Paper, which plays the same and keeps up with more players. You can switch to Mojang’s own server under Advanced.'

/**
 * Whether a plain world on Paper stays on it after the change: it does where Paper is offered for
 * the version it moves to, and runs Mojang's own server where not.
 */
function paperAfter(
  view: ServerView,
  change: { gameVersion: string; loader: Loader; loaders: readonly { value: Loader }[] },
) {
  const was = runsOnPaper(view) && change.loader === 'vanilla'
  const onPaper = was && change.loaders.some((l) => l.value === 'paper')
  return {
    help: onPaper ? ON_PAPER_HELP : LOADER_HELP[change.loader],
    line: was && !onPaper && `Runs on Mojang’s own server: Paper has no build for ${change.gameVersion} yet`,
  }
}

/** Minecraft version and server type. Worlds only move forward, so the list starts at this one. */
export function VersionSettings({ view, options }: { view: ServerView; options: SettingsOptions }) {
  const outcome = useOutcome(view)
  return (
    <VersionForm key={`${view.gameVersion}:${view.loader}`} view={view} options={options} outcome={outcome} />
  )
}

function VersionForm({
  view,
  options,
  outcome,
}: {
  view: ServerView
  options: SettingsOptions
  outcome: Outcome
}) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [gameVersion, setGameVersion] = useState(view.gameVersion)
  const [loader, setLoader] = useState<Loader>(view.loader)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const save = useMutation(
    trpc.servers.changeVersion.mutationOptions({
      onSuccess: (next) => {
        setConfirming(false)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const loaders = options.gameVersions.find((v) => v.value === gameVersion)?.loaders ?? []
  const upgrade = gameVersion !== view.gameVersion
  const retype = loader !== view.loader
  const paper = paperAfter(view, { gameVersion, loader, loaders })
  const allowed = changeable(view)
  // Every mod is resolved again for the new version and type; the owner sees how before choosing.
  const plan = useQuery({
    ...trpc.servers.planVersion.queryOptions({ serverId: view.id, gameVersion, loader }),
    enabled: confirming,
  })
  const planned = plan.data?.kind === 'ok' ? plan.data : null
  const lines = [
    upgrade && `Minecraft ${view.gameVersion} → ${gameVersion}`,
    retype && `Server type ${loaderLabel(view.loader)} → ${loaderLabel(loader)}`,
    paper.line,
  ].filter((line): line is string => typeof line === 'string')
  const change = (requestId: string, acknowledgeRevoked: boolean) =>
    save.mutateAsync({
      serverId: view.id,
      requestId,
      version: view.version,
      gameVersion,
      loader,
      expected: planned?.expected ?? [],
      acknowledgeRevoked,
    })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (lines.length > 0 && allowed.ok) setConfirming(true)
  }
  return (
    <form onSubmit={submit}>
      <FormSection
        title="Version"
        description="Your friends need the same Minecraft version to join."
        actions={
          <Button
            type="submit"
            variant="primary"
            busy={allowed.busy}
            {...said(outcome, { done: 'Changed', failed: 'Didn’t change' })}
            disabled={lines.length === 0 || !allowed.ok}
          >
            Change version
          </Button>
        }
      >
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <Select
            label="Minecraft version"
            value={gameVersion}
            options={options.gameVersions.map((v) => ({
              value: v.value,
              label: v.value === view.gameVersion ? `${v.label} (this world)` : v.label,
            }))}
            onChange={(event) => {
              const next = event.target.value
              setGameVersion(next)
              const offered = options.gameVersions.find((v) => v.value === next)?.loaders ?? []
              if (!offered.some((l) => l.value === loader && l.allowed))
                setLoader(offered.find((l) => l.allowed)?.value ?? view.loader)
            }}
          />
          <Select
            label="Server type"
            help={paper.help}
            value={loader}
            options={loaders.map((l) => ({
              value: l.value,
              label: l.allowed ? l.label : `${l.label} — ${l.reason ?? 'needs a bigger plan'}`,
              disabled: !l.allowed,
            }))}
            onChange={(event) => setLoader(event.target.value as Loader)}
          />
        </div>
      </FormSection>
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title={upgrade ? `Move this world to Minecraft ${gameVersion}?` : `Switch to ${loaderLabel(loader)}?`}
        lines={[...lines, ...(planned ? presentPlan(planned) : []), ...planLines(view)]}
        confirmLabel={view.status === 'running' ? 'Change and restart' : 'Change version'}
        working="Changing the version"
        error={save.error}
        disabled={planned === null || (planned.revoked.length > 0 && !acknowledged)}
        onConfirm={(requestId) => change(requestId, acknowledged)}
        onAcknowledge={(requestId) => change(requestId, true)}
      >
        {plan.isPending && <Skeleton width="60%" />}
        {plan.isError && <Note tone="danger">{messageOf(plan.error)}</Note>}
        {plan.data?.kind === 'conflicts' && (
          <Note tone="danger">
            Your mods can’t all come along, so nothing changes:
            <ul style={{ paddingLeft: 'var(--space-20)' }}>
              {plan.data.conflicts.map((conflict) => (
                <li key={JSON.stringify(conflict)}>{presentConflict(conflict, { gameVersion, loader })}</li>
              ))}
            </ul>
            Remove those first from the {view.loader === 'paper' ? 'Plugins' : 'Mods'} page.
          </Note>
        )}
        {planned && planned.revoked.length > 0 && (
          <RevokedChoice
            mods={planned.revoked.map((m) => m.name)}
            checked={acknowledged}
            onChange={setAcknowledged}
          />
        )}
        {upgrade && (
          <p>
            Once the world opens on {gameVersion} it can’t go back to {view.gameVersion}. Cubepals saves a
            snapshot first: if {gameVersion} doesn’t start, the server goes back to {view.gameVersion} with
            the world as it was.
          </p>
        )}
        {retype && (
          <p>Your world comes along. Mods and plugins made for one server type don’t run on another.</p>
        )}
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </form>
  )
}

/** Size, chosen the way people choose it: by how many play at once. */
export function SizeSettings({ view, options }: { view: ServerView; options: SettingsOptions }) {
  const outcome = useOutcome(view)
  return <SizeForm key={view.partySize} view={view} options={options} outcome={outcome} />
}

function SizeForm({
  view,
  options,
  outcome,
}: {
  view: ServerView
  options: SettingsOptions
  outcome: Outcome
}) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [partySize, setPartySize] = useState<PartySize>(view.partySize)
  const [confirming, setConfirming] = useState(false)
  const save = useMutation(
    trpc.servers.resize.mutationOptions({
      onSuccess: (next) => {
        setConfirming(false)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const chosen = options.partySizes.find((size) => size.value === partySize)
  const allowed = changeable(view)
  const dirty = partySize !== view.partySize
  // Linked to as #size (the overview's out-of-memory note); it renders after its data, so the
  // browser's own jump to the hash has already come and gone.
  useEffect(() => {
    if (window.location.hash === '#size') document.getElementById('size')?.scrollIntoView({ block: 'start' })
  }, [])

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (dirty && allowed.ok) setConfirming(true)
  }
  return (
    // The overview links here when a server ran out of memory.
    <form id="size" onSubmit={submit}>
      <FormSection
        title="Size"
        description="How many play at the same time. Bigger servers keep up with more players and bigger builds."
        actions={
          <Button
            type="submit"
            variant="primary"
            busy={allowed.busy}
            {...said(outcome, { done: 'Resized', failed: 'Didn’t resize' })}
            disabled={!dirty || !allowed.ok}
          >
            Change size
          </Button>
        }
      >
        <fieldset className="bk-chips">
          <legend className="bk-visually-hidden">How many play at once</legend>
          {options.partySizes.map((size) => (
            <label key={size.value} className="bk-chip bk-num" title={size.reason}>
              <input
                type="radio"
                name="party-size"
                value={size.value}
                checked={partySize === size.value}
                disabled={!size.allowed}
                onChange={() => setPartySize(size.value)}
              />
              {size.label}
            </label>
          ))}
        </fieldset>
        {options.partySizes.some((size) => !size.allowed) && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            Bigger sizes need a bigger plan.
          </p>
        )}
      </FormSection>
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Resize to hold up to ${chosen?.maxPlayers ?? partySize} players?`}
        confirmLabel={view.status === 'running' ? 'Resize and restart' : 'Change size'}
        working="Changing the size"
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({ serverId: view.id, requestId, version: view.version, partySize })
        }
        onAcknowledge={(requestId) =>
          save.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            partySize,
            acknowledgeRevoked: true,
          })
        }
      >
        {chosen && view.settings.maxPlayers > chosen.maxPlayers && (
          <p>Max players goes down to {chosen.maxPlayers} to fit the smaller size.</p>
        )}
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </form>
  )
}
