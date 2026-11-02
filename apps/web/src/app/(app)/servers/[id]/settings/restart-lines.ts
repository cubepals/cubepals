// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The words around a change that restarts a running server while players are on it: who is on,
 * what each choice of when does, and what waits for everyone to leave. The choice itself is
 * `restart-choice.tsx`'s, and what waits is shown by `waiting-changes.tsx`.
 */
import type { RestartWhen, RevisionChangeView, ServerView, WaitingChangesView } from '@blockly/contracts'

/** How many names a line gives before it counts the rest. */
const NAMED = 3

/** Whether a change that restarts this server would drop someone playing on it now. */
export function occupied(view: Pick<ServerView, 'status' | 'players'>): boolean {
  return view.status === 'running' && (view.players?.online ?? 0) > 0
}

/** "Alex", "Alex and Sam", "Alex, Sam and Kim", "Alex, Sam, Kim and 2 others". */
function named(names: readonly string[], online: number): string {
  const shown = names.slice(0, NAMED)
  const rest = online - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest === 1 ? '1 other' : `${rest} others`}`
  if (shown.length === 1) return shown[0] ?? ''
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** Who is on a running server, by name where it knows them; null where nobody is. */
export function onlineLine(view: Pick<ServerView, 'status' | 'players'>): string | null {
  if (!occupied(view) || view.players === null) return null
  const { online, people } = view.players
  if (people.length === 0) return online === 1 ? '1 player is online.' : `${online} players are online.`
  const names = named(
    people.map((person) => person.name),
    online,
  )
  return `${names} ${online === 1 ? 'is' : 'are'} online.`
}

/** What each choice does to the players on the server, as the choice says it. */
export const WHEN_SAID: Record<RestartWhen, { label: string; line: string }> = {
  empty: {
    label: 'When everyone leaves',
    line: 'Nobody is sent away. The server takes the change once the last player leaves, and you can take it sooner or cancel it on this page meanwhile.',
  },
  now: {
    label: 'Restart now',
    line: 'Everyone online sees a 10-second countdown in the game, then the server saves the world and restarts. They can join again in about a minute.',
  },
}

/** One line for each change that waits for everyone to leave, worded by `present` as History does. */
export function waitingLines(
  waiting: WaitingChangesView,
  present: (change: RevisionChangeView) => string,
): string[] {
  const lines = waiting.changes.map(present)
  if (waiting.size !== null) lines.push(`Size ${waiting.size.from} → ${waiting.size.to}`)
  if (waiting.stopCheaters === 'on') lines.push('Stop cheaters turns on')
  if (waiting.stopCheaters === 'off') lines.push('Stop cheaters turns off')
  if (waiting.stopCheaters === 'ours') lines.push('Stop cheaters uses Cubepals’ settings in place of yours')
  return lines
}
