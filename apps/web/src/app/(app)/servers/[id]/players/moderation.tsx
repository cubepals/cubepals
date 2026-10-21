// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Moderation on the Players tab: Stop cheaters first (`stop-cheaters.tsx`), then the tools and the
 * chat filter switched on or off, the helpers the page passes in, and, out of the way, the
 * escalation that picks what a player's next offence gets.
 * Warnings, mutes and bans themselves are given on each player's own page (`[uuid]/moderation.tsx`).
 */
import {
  DEFAULT_LADDER,
  MODERATION_KINDS,
  MODERATION_LENGTHS,
  type ModerationKind,
  type ModerationStep,
} from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { lengthLabel, stepLabel } from '../../../../../lib/moderation'
import { Button, FormSection, Note, Select, Toggle } from '../../../../../ui'
import { useChanged } from '../settings/shared'
import { StopCheaters } from './stop-cheaters'

export function Moderation({
  serverId,
  running,
  children,
}: {
  serverId: string
  running: boolean
  /** The helpers, as the page lists every access list. */
  children: ReactNode
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(serverId)
  const view = useQuery(trpc.moderation.get.queryOptions({ serverId }))
  const set = useMutation(
    trpc.moderation.setTools.mutationOptions({
      onSuccess: (server) => {
        changed(server)
        void queries.invalidateQueries({ queryKey: trpc.moderation.get.queryKey({ serverId }) })
      },
    }),
  )
  if (!view.isSuccess) return null
  const { enabled, chatFilter, available, stopCheaters } = view.data
  const change = (next: { enabled: boolean; chatFilter: boolean }) =>
    set.mutate({ serverId, ...next, requestId: crypto.randomUUID() })
  const cheaters = <StopCheaters serverId={serverId} view={stopCheaters} tools={enabled} />
  // Said once for the section: every switch in it restarts a running server.
  const restarts = (
    <p className="bk-field__help">
      {running ? 'Turning these on or off restarts the server.' : 'They arrive when the server next starts.'}
    </p>
  )
  // Where the tools can't run, Stop cheaters' line is all the section says.
  if (!available)
    return (
      <FormSection title="Moderation">
        {cheaters}
        {stopCheaters.available.kind === 'yes' && restarts}
      </FormSection>
    )

  return (
    <FormSection title="Moderation">
      {cheaters}
      <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <Toggle
          label="Moderation tools"
          checked={enabled}
          disabled={set.isPending}
          onChange={(next) => change({ enabled: next, chatFilter: next && chatFilter })}
        />
        <p className="bk-field__help">
          Warnings, mutes and bans, given here or by helpers in the game. Brings the LibertyBans and LuckPerms
          plugins along.
        </p>
      </div>
      {enabled && (
        <Toggle
          label="Filter chat"
          checked={chatFilter}
          disabled={set.isPending}
          onChange={(next) => change({ enabled, chatFilter: next })}
        />
      )}
      {enabled && chatFilter && (
        <p className="bk-field__help">
          Swearing, advertising and spam are blocked. After three blocked messages, the player is muted for an
          hour.
        </p>
      )}
      {restarts}
      {set.isError && <Note tone="danger">{messageOf(set.error)}</Note>}
      {enabled && (
        <>
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <h3 className="type-heading-sm" style={{ color: 'var(--ink)' }}>
              Helpers
            </h3>
            <p className="bk-field__help">
              Helpers can warn, mute, kick and ban players in the game, and see what others did, with /warn,
              /mute, /ban and /history.
            </p>
          </div>
          {children}
          <Escalation serverId={serverId} ladder={view.data.ladder} own={view.data.ownLadder} />
        </>
      )}
    </FormSection>
  )
}

const KIND_LABELS: Record<ModerationKind, string> = { warn: 'Warning', mute: 'Mute', ban: 'Ban' }

/**
 * What each offence gets, first to last, the last again after that. Blockly's own unless the
 * owner changes it, and folded away: most never need to.
 */
function Escalation({ serverId, ladder, own }: { serverId: string; ladder: ModerationStep[]; own: boolean }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [draft, setDraft] = useState<ModerationStep[] | null>(null)
  const steps = draft ?? ladder
  const save = useMutation(
    trpc.moderation.setLadder.mutationOptions({
      onSuccess: () => {
        setDraft(null)
        void queries.invalidateQueries({ queryKey: trpc.moderation.get.queryKey({ serverId }) })
      },
    }),
  )
  const put = (i: number, step: ModerationStep) => setDraft(steps.map((s, j) => (j === i ? step : s)))

  return (
    <details>
      <summary className="type-body-sm" style={{ color: 'var(--ink-muted)', cursor: 'pointer' }}>
        What each offence gets:{' '}
        {steps.map((step, i) => (i === 0 ? stepLabel(step) : stepLabel(step).toLowerCase())).join(', then ')}
      </summary>
      <div className="bk-stack" style={{ gap: 'var(--space-12)', marginTop: 'var(--space-12)' }}>
        <p className="bk-field__help">
          A player’s page suggests the next step for them. You can always choose another.
        </p>
        {steps.map((step, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a step is its place in the order.
            key={i}
            className="bk-row"
            style={{ gap: 'var(--space-12)', flexWrap: 'wrap' }}
          >
            <Select
              label={i === steps.length - 1 ? `Offence ${i + 1} and after` : `Offence ${i + 1}`}
              value={step.kind}
              options={MODERATION_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
              onChange={(event) => {
                const kind = event.target.value as ModerationKind
                put(i, {
                  kind,
                  minutes: kind === 'warn' ? null : (step.minutes ?? MODERATION_LENGTHS[0] ?? null),
                })
              }}
            />
            {step.kind !== 'warn' && (
              <Select
                label="For"
                value={String(step.minutes)}
                options={MODERATION_LENGTHS.map((minutes) => ({
                  value: String(minutes),
                  label: lengthLabel(minutes),
                }))}
                onChange={(event) =>
                  put(i, {
                    ...step,
                    minutes: event.target.value === 'null' ? null : Number(event.target.value),
                  })
                }
              />
            )}
            {steps.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(steps.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          {steps.length < 10 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft([...steps, steps.at(-1) ?? { kind: 'warn', minutes: null }])}
            >
              Add a step
            </Button>
          )}
          {draft !== null && (
            <Button
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ serverId, ladder: draft })}
            >
              Save
            </Button>
          )}
          {(own || draft !== null) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => (own ? save.mutate({ serverId, ladder: null }) : setDraft(null))}
            >
              {own ? 'Use Cubepals’ steps' : 'Cancel'}
            </Button>
          )}
        </div>
        {!own && draft === null && steps.length === DEFAULT_LADDER.length && (
          <p className="bk-field__help">These are the steps Cubepals picks.</p>
        )}
        {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      </div>
    </details>
  )
}
