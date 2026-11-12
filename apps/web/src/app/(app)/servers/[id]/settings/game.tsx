// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

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
import { presentChange } from '../../../../../lib/present'
import { Button, FormRow, FormSection, Select, Toggle } from '../../../../../ui'
import { differences, FIELDS, type Field, named, numberProblems, onRunning, type Takes } from './game-fields'
import { GameNumbers } from './game-numbers'
import { messageProblem, ServerMessage } from './server-message'
import { ConfirmChange, changeable, planLines, useChanged, whatHappens } from './shared'

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
 * How the game plays. Changes become a new revision; `key` resets the form when that lands, and
 * how the save went is kept here, above it, so "Saved" outlives the reset.
 */
export function GameSettings({
  view,
  options,
  onAskSize,
}: {
  view: ServerView
  options: SettingsOptions
  /** Take the owner to the size section with a size chosen, when the game asks for more room. */
  onAskSize: (size: PartySize) => void
}) {
  const outcome = useOutcome(view)
  return (
    <GameForm
      key={JSON.stringify(view.settings)}
      view={view}
      options={options}
      outcome={outcome}
      onAskSize={onAskSize}
    />
  )
}

/** The settings change as the API takes it, with when it restarts the server and any jars run anyway. */
const saved = (
  view: ServerView,
  settings: ServerSettingsView,
  how: { requestId: string; when: RestartWhen; acknowledgeRevoked?: boolean },
) => ({ serverId: view.id, version: view.version, settings, ...how })

function GameForm({
  view,
  options,
  outcome,
  onAskSize,
}: {
  view: ServerView
  options: SettingsOptions
  outcome: Outcome
  onAskSize: (size: PartySize) => void
}) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  // A server that never chose keeps nothing on death, as Minecraft has it.
  const current = { ...view.settings, keepInventory: view.settings.keepInventory === true }
  const [draft, setDraft] = useState<ServerSettingsView>(current)
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

  const problems = numberProblems(draft, options)
  const motdProblem = messageProblem(draft.motd)
  const valid = Object.values(problems).every((p) => p === null) && motdProblem === null
  const changes = valid ? differences(current, draft) : []
  const allowed = changeable(view)
  const taking = (how: Takes) => FIELDS.filter((field) => options.takes[field] === how)
  const restarts =
    view.movesToSize !== null || changes.some((change) => options.takes[change.field as Field] === 'restart')

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (valid && changes.length > 0 && allowed.ok) setConfirming(true)
  }

  return (
    <form onSubmit={submit}>
      <FormSection
        title="Game"
        description={`How your world plays. ${named(taking('now'))} change as people play; ${named(taking('restart'), false)} restart the server.`}
        actions={
          <>
            {changes.length > 0 && (
              <Button variant="ghost" onClick={() => setDraft(current)}>
                Undo changes
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              busy={busyFor(outcome, view)}
              {...said(outcome)}
              disabled={!valid || changes.length === 0 || !allowed.ok}
            >
              Save changes
            </Button>
          </>
        }
      >
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <Select
            label="Difficulty"
            value={draft.difficulty}
            options={DIFFICULTIES.map((value) => ({ value, label: DIFFICULTY_LABELS[value] }))}
            onChange={(event) =>
              setDraft({ ...draft, difficulty: event.target.value as ServerSettingsView['difficulty'] })
            }
          />
          <Select
            label="Game mode"
            help="For players joining for the first time."
            value={draft.defaultGameMode}
            options={GAME_MODES.map((value) => ({ value, label: MODE_LABELS[value] }))}
            onChange={(event) =>
              setDraft({
                ...draft,
                defaultGameMode: event.target.value as ServerSettingsView['defaultGameMode'],
              })
            }
          />
        </div>
        <Rules draft={draft} onChange={setDraft} />
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
          onAskSize={onAskSize}
        />
      </FormSection>
      <ConfirmChange
        view={restarts ? view : undefined}
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Save these changes?"
        lines={[...changes.map(presentChange), ...planLines(view)]}
        confirmLabel={view.status === 'running' && restarts ? 'Save and restart' : 'Save changes'}
        working="Saving your changes"
        error={save.error}
        onConfirm={(requestId, when) => save.mutateAsync(saved(view, draft, { requestId, when }))}
        onAcknowledge={(requestId, when) =>
          save.mutateAsync(saved(view, draft, { requestId, when, acknowledgeRevoked: true }))
        }
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {view.status === 'running'
            ? onRunning(
                view,
                changes.map((change) => change.field),
                options.takes,
              )
            : whatHappens(view)}
        </p>
      </ConfirmChange>
    </form>
  )
}

/** The game's rules that are on or off: PvP, and whether players keep their items when they die. */
function Rules({
  draft,
  onChange,
}: {
  draft: ServerSettingsView
  onChange: (next: ServerSettingsView) => void
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
    </>
  )
}
