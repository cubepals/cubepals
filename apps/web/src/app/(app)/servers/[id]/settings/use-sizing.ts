/**
 * SPDX-FileCopyrightText: 2026 The Cubepals Authors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The size the game form saves with its settings. Until the owner picks one, it is the size
 * their players and distances need (`sizing.ts`), once they have moved one of them; the size the
 * server is on before that, so a page opened on an old setting never offers a change nobody made.
 * A size the owner picks holds until they slide past what it holds, which hands the choice back
 * to Cubepals. Picking a smaller size brings max players down to fit it, as a resize does.
 */
import type { PartySize, ServerSettingsView, ServerView, SettingsOptions } from '@blockly/contracts'
import { useState } from 'react'
import {
  type Current,
  capacityOf,
  holdsOf,
  mostPlayers,
  neededSize,
  type SizeChoice,
  type Want,
} from './sizing'

export interface Sizing {
  /** The server as it is. */
  current: Current
  sizes: readonly SizeChoice[]
  /** The size this change saves with. */
  size: PartySize
  /** How far max players goes on it. */
  holds: number
  /** What its machine takes, which the load is measured against. */
  capacity: number
  /** Cubepals picked it, bigger than the server's own, for what the owner slid. */
  raised: boolean
  /** The most players any size the plan has holds: how far the players slider goes. */
  most: number
  want: Want
  /** The owner picks a size: it holds until they slide past it. */
  choose: (size: PartySize) => void
  /** The settings with max players as the owner slid it, handing the size back past what it holds. */
  withPlayers: (players: number) => ServerSettingsView
  /** Back to the server as it is, with Undo changes. */
  reset: () => void
}

export function useSizing(
  view: ServerView,
  options: SettingsOptions,
  draft: ServerSettingsView,
  setDraft: (next: ServerSettingsView) => void,
): Sizing {
  const [chosen, setChosen] = useState<PartySize | null>(null)
  const current: Current = {
    size: view.partySize,
    holds: options.bounds.maxPlayers,
    capacity: options.bounds.maxPlayers,
  }
  const sizes = options.partySizes
  const choiceOf = (value: PartySize) => sizes.find((size) => size.value === value)
  const holdsFor = (value: PartySize) => {
    const choice = choiceOf(value)
    return choice ? holdsOf(choice, current) : current.holds
  }
  const capacityFor = (value: PartySize) => {
    const choice = choiceOf(value)
    return choice ? capacityOf(choice, current) : current.capacity
  }
  const want: Want = {
    players: draft.maxPlayers,
    view: draft.viewDistance,
    simulation: draft.simulationDistance,
  }
  const moved =
    draft.maxPlayers !== view.settings.maxPlayers ||
    draft.viewDistance !== view.settings.viewDistance ||
    draft.simulationDistance !== view.settings.simulationDistance
  const size = chosen ?? (moved ? neededSize(want, sizes, current) : current.size)
  return {
    current,
    sizes,
    size,
    holds: holdsFor(size),
    capacity: capacityFor(size),
    raised: chosen === null && size !== current.size,
    most: mostPlayers(sizes, current),
    want,
    choose: (value) => {
      setChosen(value)
      const holds = holdsFor(value)
      if (draft.maxPlayers > holds) setDraft({ ...draft, maxPlayers: holds })
    },
    withPlayers: (players) => {
      if (chosen !== null && players > holdsFor(chosen)) setChosen(null)
      return { ...draft, maxPlayers: players }
    },
    reset: () => setChosen(null),
  }
}
