// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ServerView, SettingsOptions } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { type Outcome, said, useOutcome } from '../../../../../lib/outcome'
import { Button, FormRow, FormSection, Select } from '../../../../../ui'
import { ConfirmChange, changeable, useChanged } from './shared'

/** Where the server runs, and moving it closer to its players (§9 relocate). */
export function Location({ view, options }: { view: ServerView; options: SettingsOptions }) {
  const outcome = useOutcome(view)
  return <LocationForm key={view.region.key} view={view} options={options} outcome={outcome} />
}

function LocationForm({
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
  const [region, setRegion] = useState(view.region.key)
  const [confirming, setConfirming] = useState(false)
  const move = useMutation(
    trpc.servers.relocate.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        setConfirming(false)
        outcome.settled(next)
      },
    }),
  )
  const allowed = changeable(view)
  const target = options.regions.find((r) => r.key === region)
  if (options.regions.length <= 1)
    return (
      <FormSection title="Location">
        <FormRow
          label="Region"
          description="Where your world lives."
          control={<span className="type-body">{view.region.label}</span>}
        />
      </FormSection>
    )
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (region !== view.region.key && allowed.ok) setConfirming(true)
  }
  return (
    <form onSubmit={submit}>
      <FormSection
        title="Location"
        description="Where your world lives. Closer to your players means less lag."
        actions={
          <Button
            type="submit"
            variant="primary"
            busy={allowed.busy}
            {...said(outcome, { done: 'Moved', failed: 'Didn’t move' })}
            disabled={region === view.region.key || !allowed.ok}
          >
            Move server
          </Button>
        }
      >
        <Select
          label="Region"
          value={region}
          options={options.regions.map((r) => ({ value: r.key, label: r.label }))}
          onChange={(event) => setRegion(event.target.value)}
        />
      </FormSection>
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Move to ${target?.label ?? region}?`}
        confirmLabel="Move server"
        working="Moving it"
        error={move.error}
        onConfirm={(requestId) => move.mutateAsync({ serverId: view.id, requestId, regionKey: region })}
      >
        <p>
          The world moves with it, and the address stays the same. Cubepals backs it up first, and the server
          stays where it is until the move is done.
        </p>
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {view.status === 'running'
            ? 'Nobody can play while it moves; it takes a few minutes.'
            : 'It stays stopped; the next start is there.'}
        </p>
      </ConfirmChange>
    </form>
  )
}
