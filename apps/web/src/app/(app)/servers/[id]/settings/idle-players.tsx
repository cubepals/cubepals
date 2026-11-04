// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Idle players on this server only: the plan default until its owner chooses otherwise. Never
 * kicking asks once because an idle player keeps spending play time. Saving waits for the next
 * start, and the form says so rather than restarting anyone's game.
 */
import type { EntitlementsView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { useOutcome } from '../../../../../lib/outcome'
import { Button, FormRow, FormSection, Modal, Note } from '../../../../../ui'
import { useChanged } from './shared'

export function IdlePlayers({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const overview = useQuery(trpc.account.overview.queryOptions())
  if (overview.isError) return <Note tone="danger">{messageOf(overview.error)}</Note>
  if (!overview.data) return null
  return <IdleKick view={view} plan={overview.data.entitlements} />
}

function IdleKick({ view, plan }: { view: ServerView; plan: EntitlementsView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const outcome = useOutcome(undefined)
  const [asking, setAsking] = useState(false)
  const save = useMutation(
    trpc.servers.setAfkKick.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        outcome.settled()
        setAsking(false)
      },
    }),
  )
  const minutes = view.afkKickMinutes
  const effective = minutes ?? plan.playerIdleKickMinutes
  const choices = [...new Set([10, 15, 30, 60, ...(minutes ? [minutes] : [])])].sort((a, b) => a - b)
  const choose = (value: string) => {
    if (value === '0') setAsking(true)
    else save.mutate({ serverId: view.id, minutes: value === 'default' ? null : Number(value) })
  }
  return (
    <FormSection title="Idle players" description="These choices apply only to this server.">
      <FormRow
        label="Kick players who stand still"
        description={`${outcome.said === 'done' ? 'Saved. ' : ''}${
          effective === 0
            ? 'Somebody idle keeps this server awake and spends your play time until they leave.'
            : 'Somebody idle still spends your play time. Kicked players can join again straight away.'
        } Changes apply the next time this server starts.`}
        control={
          <select
            aria-label="Kick players who stand still"
            className="bk-selectctl bk-num"
            style={{ inlineSize: 'auto' }}
            value={minutes ?? 'default'}
            disabled={save.isPending || (!plan.mayChooseAfkKick && minutes === null)}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="default">Plan default: after {plan.playerIdleKickMinutes} minutes</option>
            {choices.map((n) => (
              <option key={n} value={n} disabled={!plan.mayChooseAfkKick}>
                After {n} minutes
              </option>
            ))}
            <option value={0} disabled={!plan.mayChooseAfkKick}>
              Never
            </option>
          </select>
        }
      />
      {!plan.mayChooseAfkKick && (
        <p className="bk-field__help">
          Choosing an idle kick comes with a paid plan. You can return to the plan default.
        </p>
      )}
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Never kick players who stand still?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep kicking them
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => save.mutate({ serverId: view.id, minutes: 0 })}
            >
              {save.isPending ? 'Saving…' : 'Never kick'}
            </Button>
          </>
        }
      >
        <p>
          Somebody idle keeps {view.name} awake, so it keeps using your play time for as long as they stay,
          even when nobody is playing. This changes only this server, from its next start.
        </p>
        {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      </Modal>
      {!asking && save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
    </FormSection>
  )
}
