// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Which players' games join a Paper server: one line that says it, worked out from its version and
 * the Via plugins Cubepals adds as it starts, with the switch that turns them off and a second
 * choice for 1.8 and 1.7. They are Cubepals' own, so they never show among the server's plugins,
 * and nothing shows on a server that can't run them.
 */

import type { OtherVersions, ServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { type Outcome, useOutcome } from '../../../../../lib/outcome'
import { FormRow, FormSection, Toggle } from '../../../../../ui'
import { joinsLine } from './joins-line'
import { ConfirmChange, changeable, useChanged, whatHappens } from './shared'

/**
 * Which players' games join a Paper server: one line that says it, worked out from its version and
 * the Via plugins Cubepals adds as it starts, with the switch that turns them off and a second
 * choice for 1.8 and 1.7. They are Cubepals' own, so they never show among the server's plugins.
 * Nothing shows on a server that can't run them.
 */
export function OtherVersionsSetting({ view }: { view: ServerView }) {
  const outcome = useOutcome(view)
  const choice = view.joins?.otherVersions
  if (choice === null || choice === undefined) return null
  return <OtherVersionsForm key={choice} view={view} choice={choice} outcome={outcome} />
}

function OtherVersionsForm({
  view,
  choice,
  outcome,
}: {
  view: ServerView
  choice: OtherVersions
  outcome: Outcome
}) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [asking, setAsking] = useState<OtherVersions | null>(null)
  const save = useMutation(
    trpc.servers.changeOtherVersions.mutationOptions({
      onSuccess: (next) => {
        setAsking(null)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const allowed = changeable(view)
  const line = joinsLine(view)
  const said =
    allowed.busy !== undefined
      ? `${allowed.busy}…`
      : outcome.said === 'done'
        ? `Saved. ${line}`
        : outcome.said === 'failed'
          ? `Didn’t change. ${line}`
          : line

  return (
    <FormSection title="Other versions" description={said}>
      <FormRow
        label="Newer and older versions"
        description="Players don’t need your exact version."
        control={
          <Toggle
            checked={choice !== 'off'}
            ariaLabel="Let players on other Minecraft versions join"
            disabled={!allowed.ok}
            onChange={() => setAsking(choice === 'off' ? 'on' : 'off')}
          />
        }
      />
      {choice !== 'off' && (
        <FormRow
          label="Minecraft 1.8 and 1.7 too"
          description="For players who stayed on the old combat."
          control={
            <Toggle
              checked={choice === 'oldest'}
              ariaLabel="Let players on Minecraft 1.8 and 1.7 join"
              disabled={!allowed.ok}
              onChange={() => setAsking(choice === 'oldest' ? 'on' : 'oldest')}
            />
          }
        />
      )}
      <ConfirmChange
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === 'off' ? 'Only let in your own version?' : 'Let in other versions?'}
        confirmLabel={asking === 'off' ? 'Only my version' : 'Let them in'}
        working="Saving your change"
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            otherVersions: asking ?? choice,
          })
        }
      >
        <p>
          {asking === 'off'
            ? `Only players on Minecraft ${view.gameVersion} will be able to join.`
            : asking === 'oldest'
              ? 'Players on Minecraft 1.8 and 1.7 can join too, as well as newer and older versions.'
              : 'Players on newer and older Minecraft versions can join, not only yours.'}
        </p>
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </FormSection>
  )
}
