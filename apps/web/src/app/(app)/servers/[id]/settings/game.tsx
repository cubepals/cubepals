'use client'

import {
  DIFFICULTIES,
  GAME_MODES,
  type RevisionChangeView,
  type ServerSettingsView,
  type ServerView,
  type SettingsOptions,
} from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { type Outcome, said, useOutcome } from '../../../../../lib/outcome'
import { presentChange, settingLabel } from '../../../../../lib/present'
import { Button, FormRow, FormSection, Select, TextField, Toggle } from '../../../../../ui'
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

type NumberSetting = 'maxPlayers' | 'viewDistance' | 'simulationDistance' | 'spawnProtection'

/** The form's settings, in the order it shows them. */
const FIELDS = [
  'difficulty',
  'defaultGameMode',
  'pvp',
  'motd',
  'maxPlayers',
  'spawnProtection',
  'viewDistance',
  'simulationDistance',
] as const

type Field = (typeof FIELDS)[number]
type Takes = SettingsOptions['takes'][Field]

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/** "Difficulty, game mode, and PvP": settings as a sentence names them, opening it or not. */
const named = (fields: readonly string[], opening = true) =>
  LIST.format(
    fields.map((field, i) => {
      const label = settingLabel(field)
      return (opening && i === 0) || label === 'PvP' ? label : label.charAt(0).toLowerCase() + label.slice(1)
    }),
  )

/** What saving does to a running server: which changes restart it, and which it takes as people play. */
function onRunning(view: ServerView, fields: readonly string[], takes: SettingsOptions['takes']): string {
  // Moving to the size the plan offers restarts it, whatever else changes.
  if (view.movesToSize !== null) return whatHappens(view)
  const how = (field: string) => takes[field as Field]
  const restarting = fields.filter((field) => how(field) === 'restart')
  if (restarting.length > 0)
    return `${named(restarting)} ${restarting.length === 1 ? 'needs' : 'need'} a restart. ${whatHappens(view)}`
  const later = fields.some((field) => how(field) === 'next_start')
    ? 'The new server message shows from the server’s next start.'
    : ''
  return fields.some((field) => how(field) === 'now')
    ? `The game takes the change as people play, and nobody is sent away. ${later}`.trim()
    : `Nobody is sent away. ${later}`.trim()
}

/**
 * How the game plays. Changes become a new revision; `key` resets the form when that lands, and
 * how the save went is kept here, above it, so "Saved" outlives the reset.
 */
export function GameSettings({ view, options }: { view: ServerView; options: SettingsOptions }) {
  const outcome = useOutcome(view)
  return <GameForm key={JSON.stringify(view.settings)} view={view} options={options} outcome={outcome} />
}

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
  const [draft, setDraft] = useState<ServerSettingsView>(view.settings)
  // Numbers are typed as text so a half-typed "1" on the way to "12" isn't fought over.
  const [typed, setTyped] = useState(() => typedFrom(view.settings))
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

  const bounds = {
    maxPlayers: { min: 1, max: options.bounds.maxPlayers },
    viewDistance: options.bounds.viewDistance,
    simulationDistance: options.bounds.simulationDistance,
    spawnProtection: options.bounds.spawnProtection,
  }
  const problems = Object.fromEntries(
    (Object.keys(bounds) as NumberSetting[]).map((key) => {
      const value = Number(typed[key])
      const { min, max } = bounds[key]
      const ok = typed[key].trim() !== '' && Number.isInteger(value) && value >= min && value <= max
      return [key, ok ? null : `Choose ${min} to ${max}.`]
    }),
  ) as Record<NumberSetting, string | null>
  const motdProblem =
    draft.motd.length > options.bounds.motdLength
      ? `Keep it to ${options.bounds.motdLength} characters, so it fits in the server list.`
      : null
  const valid = Object.values(problems).every((p) => p === null) && motdProblem === null
  const next: ServerSettingsView = {
    ...draft,
    maxPlayers: Number(typed.maxPlayers),
    viewDistance: Number(typed.viewDistance),
    simulationDistance: Number(typed.simulationDistance),
    spawnProtection: Number(typed.spawnProtection),
  }
  const changes = valid ? differences(view.settings, next) : []
  const allowed = changeable(view)
  const taking = (how: Takes) => FIELDS.filter((field) => options.takes[field] === how)
  const restarts =
    view.movesToSize !== null || changes.some((change) => options.takes[change.field as Field] === 'restart')

  const number = (key: NumberSetting, label: string, help: string) => (
    <TextField
      label={label}
      inputMode="numeric"
      className="bk-num"
      value={typed[key]}
      onChange={(event) => setTyped({ ...typed, [key]: event.target.value })}
      error={problems[key]}
      help={help}
    />
  )
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
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(view.settings)
                  setTyped(typedFrom(view.settings))
                }}
              >
                Undo changes
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              busy={allowed.busy}
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
        <FormRow
          label="PvP"
          description="Players can hurt each other."
          control={
            <Toggle checked={draft.pvp} ariaLabel="PvP" onChange={(pvp) => setDraft({ ...draft, pvp })} />
          }
        />
        <TextField
          label="Server message"
          value={draft.motd}
          onChange={(event) => setDraft({ ...draft, motd: event.target.value })}
          error={motdProblem}
          help={`Shown under the name in your friends’ server list, from the server’s next start. ${Math.max(0, options.bounds.motdLength - draft.motd.length)} characters left.`}
        />
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          {number(
            'maxPlayers',
            'Max players',
            `This size holds up to ${options.bounds.maxPlayers}. Pick a bigger size below for more.`,
          )}
          {number('spawnProtection', 'Spawn protection', 'Blocks around spawn only operators can change.')}
          {number('viewDistance', 'View distance', 'How far players see, in chunks.')}
          {number('simulationDistance', 'Simulation distance', 'How far the world keeps moving, in chunks.')}
        </div>
      </FormSection>
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Save these changes?"
        lines={[...changes.map(presentChange), ...planLines(view)]}
        confirmLabel={view.status === 'running' && restarts ? 'Save and restart' : 'Save changes'}
        working="Saving your changes"
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({ serverId: view.id, requestId, version: view.version, settings: next })
        }
        onAcknowledge={(requestId) =>
          save.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            settings: next,
            acknowledgeRevoked: true,
          })
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

const typedFrom = (settings: ServerSettingsView): Record<NumberSetting, string> => ({
  maxPlayers: String(settings.maxPlayers),
  viewDistance: String(settings.viewDistance),
  simulationDistance: String(settings.simulationDistance),
  spawnProtection: String(settings.spawnProtection),
})

function differences(from: ServerSettingsView, to: ServerSettingsView): RevisionChangeView[] {
  return (Object.keys(to) as (keyof ServerSettingsView)[])
    .filter((key) => from[key] !== to[key])
    .map((key) => ({ field: key, from: from[key], to: to[key] }))
}
