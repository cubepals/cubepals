// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The game section of a server's settings: difficulty, game mode, the rules, the server list's
 * message, and its players, distance and size (`game-numbers.tsx`), saved as one change.
 */

import {
  DIFFICULTIES,
  GAME_MODES,
  type PartySize,
  type RestartWhen,
  type ServerSettingsView,
  type ServerView,
  type SettingsOptions,
} from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { busyFor } from '../../../../../lib/button-busy'
import { type Outcome, said, useOutcome } from '../../../../../lib/outcome'
import { presentChange, settingLabel } from '../../../../../lib/present'
import { Button, FormRow, FormSection, Select, Toggle } from '../../../../../ui'
import { differences, FIELDS, type Field, named, numberProblems, onRunning, type Takes } from './game-fields'
import { GameNumbers } from './game-numbers'
import { RangeField } from './range-field'
import { messageProblem, ServerMessage } from './server-message'
import { ConfirmChange, changeable, planLines, useChanged, whatHappens } from './shared'
import { compareSizes } from './sizing'
import { type Sizing, useSizing } from './use-sizing'

const DIFFICULTY_LABELS: Record<(typeof DIFFICULTIES)[number], string> = {
  peaceful: 'Peaceful',
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
}
const MODE_LABELS: Record<(typeof GAME_MODES)[number], string> = {
  survival: 'Survival',
  creative: 'Creative',
  adventure: 'Adventure',
  spectator: 'Spectator',
}

/**
 * How the game plays, and the size it plays on. Changes become a new revision, with the size in
 * the same change; `key` resets the form when that lands, and how the save went is kept here,
 * above it, so "Saved" outlives the reset.
 */
export function GameSettings({ view, options }: { view: ServerView; options: SettingsOptions }) {
  const outcome = useOutcome(view)
  return (
    <GameForm
      key={`${JSON.stringify(view.settings)}:${view.partySize}`}
      view={view}
      options={options}
      outcome={outcome}
    />
  )
}

/** The settings change as the API takes it, with the size when it moves, when it restarts the server and any jars run anyway. */
const saved = (
  view: ServerView,
  settings: ServerSettingsView,
  size: PartySize,
  how: { requestId: string; when: RestartWhen; acknowledgeRevoked?: boolean },
) => ({
  serverId: view.id,
  version: view.version,
  settings,
  ...(size === view.partySize ? {} : { partySize: size }),
  ...how,
})

function GameForm({
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
  // A server that never chose keeps nothing on death, as Minecraft has it.
  const current = { ...view.settings, keepInventory: view.settings.keepInventory === true }
  const [draft, setDraft] = useState<ServerSettingsView>(current)
  const sizing = useSizing(view, options, draft, setDraft)
  const [confirming, setConfirming] = useState(false)
  const save = useMutation(
    trpc.servers.changeSettings.mutationOptions({
      onSuccess: (next) => {
        setConfirming(false)
        changed(next)
        outcome.settled(next)
      },
    }),
  )

  const problems = numberProblems(draft, options, sizing.holds)
  const motdProblem = messageProblem(draft.motd)
  const valid = Object.values(problems).every((p) => p === null) && motdProblem === null
  const changes = valid ? differences(current, draft) : []
  const resized = valid && sizing.size !== view.partySize
  const dirty = changes.length > 0 || resized
  const allowed = changeable(view)
  const taking = (how: Takes) => FIELDS.filter((field) => options.takes[field] === how)
  const restarts =
    view.movesToSize !== null ||
    resized ||
    changes.some((change) => options.takes[change.field as Field] === 'restart')

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (valid && dirty && allowed.ok) setConfirming(true)
  }

  return (
    <form onSubmit={submit}>
      <FormSection
        title="Game"
        description={`How your world plays, and the size it plays on. ${named(taking('now'))} change as people play; ${named(taking('restart'), false)} and the size restart the server.`}
        actions={
          <>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(current)
                  sizing.reset()
                }}
              >
                Undo changes
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              busy={busyFor(outcome, view)}
              {...said(outcome)}
              disabled={!valid || !dirty || !allowed.ok}
            >
              Save changes
            </Button>
          </>
        }
      >
        <Basics draft={draft} onChange={setDraft} />
        <Rules draft={draft} onChange={setDraft} problem={problems.spawnProtection} options={options} />
        <ServerMessage
          view={view}
          value={draft.motd}
          maxPlayers={draft.maxPlayers}
          problem={motdProblem}
          onChange={(motd) => setDraft({ ...draft, motd })}
        />
        <GameNumbers
          draft={draft}
          options={options}
          problems={problems}
          onChange={setDraft}
          sizing={sizing}
          serverId={view.id}
        />
      </FormSection>
      <ConfirmChange
        view={restarts ? view : undefined}
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Save these changes?"
        lines={[...changes.map(presentChange), ...sizeLines(sizing), ...planLines(view)]}
        confirmLabel={view.status === 'running' && restarts ? 'Save and restart' : 'Save changes'}
        working="Saving your changes"
        error={save.error}
        onConfirm={(requestId, when) =>
          save.mutateAsync(saved(view, draft, sizing.size, { requestId, when }))
        }
        onAcknowledge={(requestId, when) =>
          save.mutateAsync(saved(view, draft, sizing.size, { requestId, when, acknowledgeRevoked: true }))
        }
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {view.status === 'running' ? runningLine(view, changes, options, resized) : whatHappens(view)}
        </p>
      </ConfirmChange>
    </form>
  )
}

/** What saving does to a running server, with a move to another size, which always restarts it. */
function runningLine(
  view: ServerView,
  changes: { field: string }[],
  options: SettingsOptions,
  resized: boolean,
): string {
  if (resized && view.movesToSize === null) return `A new size needs a restart. ${whatHappens(view)}`
  return onRunning(
    view,
    changes.map((change) => change.field),
    options.takes,
  )
}

/** The size move as the confirmation lists it, with what a bigger or smaller one does to hours. */
function sizeLines(sizing: Sizing): string[] {
  const from = sizing.sizes.find((s) => s.value === sizing.current.size)
  const to = sizing.sizes.find((s) => s.value === sizing.size)
  if (sizing.size === sizing.current.size || !to) return []
  const move = from
    ? `Size for ${from.maxPlayers} → ${to.maxPlayers} players`
    : `Size for ${to.maxPlayers} players`
  const hours =
    compareSizes(to, from) > 0
      ? 'A bigger server uses your hours faster while it runs.'
      : 'A smaller server uses your hours more slowly.'
  return [move, hours]
}

/** Difficulty, and the game mode new players start in. */
function Basics({
  draft,
  onChange,
}: {
  draft: ServerSettingsView
  onChange: (next: ServerSettingsView) => void
}) {
  return (
    <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
      <Select
        label="Difficulty"
        value={draft.difficulty}
        options={DIFFICULTIES.map((value) => ({ value, label: DIFFICULTY_LABELS[value] }))}
        onChange={(event) =>
          onChange({ ...draft, difficulty: event.target.value as ServerSettingsView['difficulty'] })
        }
      />
      <Select
        label="Game mode"
        help="For players joining for the first time."
        value={draft.defaultGameMode}
        options={GAME_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))}
        onChange={(event) =>
          onChange({ ...draft, defaultGameMode: event.target.value as ServerSettingsView['defaultGameMode'] })
        }
      />
    </div>
  )
}

/**
 * The game's rules: PvP, whether players keep their items when they die, and how far around spawn
 * only operators can build.
 */
function Rules({
  draft,
  onChange,
  problem,
  options,
}: {
  draft: ServerSettingsView
  onChange: (next: ServerSettingsView) => void
  problem: string | null
  options: SettingsOptions
}) {
  return (
    <>
      <FormRow
        label="PvP"
        description="Players can hurt each other."
        control={
          <Toggle checked={draft.pvp} ariaLabel="PvP" onChange={(pvp) => onChange({ ...draft, pvp })} />
        }
      />
      <FormRow
        label="Keep items when you die"
        description="Players keep their items and experience when they die, wherever they are."
        control={
          <Toggle
            checked={draft.keepInventory === true}
            ariaLabel="Keep items when you die"
            onChange={(keepInventory) => onChange({ ...draft, keepInventory })}
          />
        }
      />
      <div className="bk-grid" style={{ gap: 'var(--space-24)' }}>
        <RangeField
          label={settingLabel('spawnProtection')}
          value={draft.spawnProtection}
          {...options.bounds.spawnProtection}
          said={(n) => `${n} ${n === 1 ? 'block' : 'blocks'}`}
          help="Blocks around spawn only operators can change."
          error={problem}
          onChange={(spawnProtection) => onChange({ ...draft, spawnProtection })}
        />
      </div>
    </>
  )
}
