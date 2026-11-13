// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The performance mods Cubepals adds to a Fabric server as it starts: which ones, by name, and the
 * switch that turns them off and back on. They are Cubepals' own, so they never show among the
 * server's mods, and nothing shows on a server that doesn't get them. The switch restarts nothing
 * and applies at the next start, so it saves at once, as Telling players does
 * (`telling-players.tsx`). Where a start turned them off itself, the section says so.
 */
import type { PerformanceModsView, ServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { FormRow, FormSection, Note, Toggle } from '../../../../../ui'
import { performanceLine } from './performance-line'
import { useChanged } from './shared'

export function PerformanceModsSetting({ view }: { view: ServerView }) {
  // A control plane from before the switch says nothing of them.
  const shown = view.performanceMods ?? null
  if (shown === null) return null
  return <PerformanceModsForm view={view} shown={shown} />
}

function PerformanceModsForm({ view, shown }: { view: ServerView; shown: PerformanceModsView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const save = useMutation(trpc.servers.setPerformanceMods.mutationOptions({ onSuccess: changed }))
  return (
    <FormSection title="Performance" description={performanceLine(shown)}>
      <FormRow
        label="Performance mods"
        description="Applies at the server’s next start."
        control={
          <Toggle
            ariaLabel="Performance mods"
            checked={shown.on}
            disabled={save.isPending}
            onChange={(on) => save.mutate({ serverId: view.id, on })}
          />
        }
      />
      {shown.turnedOff === 'clash' && (
        <p className="bk-field__help">
          Cubepals turned these off because the server didn’t start with them. You can turn them back on after
          changing your mods.
        </p>
      )}
      {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
    </FormSection>
  )
}
