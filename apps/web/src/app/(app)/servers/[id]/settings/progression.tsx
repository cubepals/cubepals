// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Offline world progression: Cubepals' plugin or mod that catches a world up on the time nobody
 * was near it, with its switch, and one for each of its parts under Advanced. On by default; it is
 * Cubepals' own, so it never
 * shows among the server's plugins or mods, and nothing shows on a server it isn't for. The
 * switch restarts nothing and applies at the next start, so it saves at once, as the performance
 * mods' does (`performance-mods.tsx`). Beside it, a drawing of what it does, which changes with the
 * switch: things a base leaves going, and what they are found as.
 */
import {
  type ItemIconView,
  PROGRESSION_DEFAULTS,
  type ProgressionView,
  type ServerView,
} from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { FormRow, FormSection, ItemSlot, Note, Toggle } from '../../../../../ui'
import styles from './progression.module.css'
import {
  CHANGES,
  FOUND_AS,
  PROGRESSION_CLASH,
  PROGRESSION_LINE,
  PROGRESSION_PARTS_SHOWN,
  PROGRESSION_WAITS,
} from './progression-line'
import { useChanged } from './shared'

export function ProgressionSetting({ view }: { view: ServerView }) {
  // A control plane from before it says nothing of it, and a server it isn't for has none.
  const shown = view.progression ?? null
  if (shown === null) return null
  return <ProgressionForm view={view} shown={shown} />
}

function ProgressionForm({ view, shown }: { view: ServerView; shown: ProgressionView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const save = useMutation(trpc.servers.setProgression.mutationOptions({ onSuccess: changed }))
  return (
    <FormSection title="Offline world progression" description={PROGRESSION_LINE}>
      <FormRow
        label="Keeps going while you’re away"
        description="Applies at the server’s next start."
        control={
          <Toggle
            ariaLabel="Offline world progression"
            checked={shown.on}
            disabled={save.isPending}
            onChange={(on) => save.mutate({ serverId: view.id, on })}
          />
        }
      />
      <Drawing gameVersion={view.gameVersion} on={shown.on} />
      <p className="bk-field__help">{PROGRESSION_WAITS}</p>
      {shown.turnedOff === 'clash' && <p className="bk-field__help">{PROGRESSION_CLASH}</p>}
      {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      <Parts view={view} shown={shown} />
    </FormSection>
  )
}

/**
 * Each part's own switch, folded away under Advanced: most owners never need them. They save at
 * once, as the main switch does, and with it off they can't be changed, since nothing runs.
 */
function Parts({ view, shown }: { view: ServerView; shown: ProgressionView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const save = useMutation(trpc.servers.setProgressionPart.mutationOptions({ onSuccess: changed }))
  const parts = shown.parts ?? PROGRESSION_DEFAULTS
  return (
    <details>
      <summary className="type-body-sm bk-disclosure">Advanced</summary>
      <div className={styles.parts}>
        {PROGRESSION_PARTS_SHOWN.map(({ part, label, covers }) => (
          <FormRow
            key={part}
            label={label}
            description={covers}
            control={
              <Toggle
                ariaLabel={label}
                checked={shown.on && parts[part]}
                disabled={!shown.on || save.isPending}
                onChange={(on) => save.mutate({ serverId: view.id, part, on })}
              />
            }
          />
        ))}
        {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      </div>
    </details>
  )
}

/** The drawing: each thing as it was left, an arrow, and as it is found, which off is as it was left. */
function Drawing({ gameVersion, on }: { gameVersion: string; on: boolean }) {
  const trpc = useTRPC()
  const ids = [...new Set(CHANGES.flatMap((c) => [c.id, FOUND_AS[c.id] ?? c.id]))].map(
    (id) => `minecraft:${id}`,
  )
  const icons = useQuery(trpc.players.icons.queryOptions({ gameVersion, ids: ids.sort() }))
  const icon = (id: string): ItemIconView | undefined => icons.data?.[`minecraft:${id}`] ?? undefined
  const stack = (id: string, name: string, count: number) => ({
    id: `minecraft:${id}`,
    name,
    count,
    named: false,
    enchantments: [],
    potion: null,
    durability: null,
  })
  return (
    <figure className={styles.figure} data-on={on}>
      <div className={styles.changes}>
        {CHANGES.map((change) => {
          const found = on ? change.found : change.left
          const foundId = on ? (FOUND_AS[change.id] ?? change.id) : change.id
          return (
            <span key={change.id} className={styles.change}>
              <ItemSlot
                stack={stack(change.id, change.left.name, change.left.count)}
                icon={icon(change.id)}
                gameVersion={gameVersion}
              />
              <span className={styles.arrow} aria-hidden>
                →
              </span>
              <ItemSlot
                stack={stack(foundId, found.name, found.count)}
                icon={icon(foundId)}
                gameVersion={gameVersion}
              />
            </span>
          )
        })}
      </div>
      <figcaption className="bk-field__help">
        {on
          ? 'What you left, and what you find when you’re back.'
          : 'Off, it all waits for you as you left it.'}
      </figcaption>
    </figure>
  )
}
