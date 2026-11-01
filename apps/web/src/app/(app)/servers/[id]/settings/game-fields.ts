/**
 * SPDX-FileCopyrightText: 2026 The Cubepals Authors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Game fields and explanations, independent of rendering the form.
 */
import type { RevisionChangeView, ServerSettingsView, ServerView, SettingsOptions } from '@blockly/contracts'
import { settingLabel } from '../../../../../lib/present'
import { whatHappens } from './shared'

export type NumberSetting = 'maxPlayers' | 'viewDistance' | 'simulationDistance' | 'spawnProtection'

/** The form's settings, in the order it shows them. */
export const FIELDS = [
  'difficulty',
  'defaultGameMode',
  'pvp',
  'keepInventory',
  'motd',
  'maxPlayers',
  'spawnProtection',
  'viewDistance',
  'simulationDistance',
] as const

export type Field = (typeof FIELDS)[number]
export type Takes = SettingsOptions['takes'][Field]

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/** "Difficulty, game mode, and PvP": settings as a sentence names them, opening it or not. */
export const named = (fields: readonly string[], opening = true) =>
  LIST.format(
    fields.map((field, i) => {
      const label = settingLabel(field)
      return (opening && i === 0) || label === 'PvP' ? label : label.charAt(0).toLowerCase() + label.slice(1)
    }),
  )

/** What saving does to a running server: which changes restart it, and which it takes as people play. */
export function onRunning(
  view: ServerView,
  fields: readonly string[],
  takes: SettingsOptions['takes'],
): string {
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

export const typedFrom = (settings: ServerSettingsView): Record<NumberSetting, string> => ({
  maxPlayers: String(settings.maxPlayers),
  viewDistance: String(settings.viewDistance),
  simulationDistance: String(settings.simulationDistance),
  spawnProtection: String(settings.spawnProtection),
})

export function differences(from: ServerSettingsView, to: ServerSettingsView): RevisionChangeView[] {
  return (
    (Object.keys(to) as (keyof ServerSettingsView)[])
      .filter((key) => from[key] !== to[key])
      // Only keeping items on death may be unchosen, which is off.
      .map((key) => ({ field: key, from: from[key] ?? false, to: to[key] ?? false }))
  )
}
