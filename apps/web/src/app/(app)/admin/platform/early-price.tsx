// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The early price on the platform page: the room for its checkouts as last set from outside, what
 * a checkout of each plan takes, until when it holds, the checkout pages holding it now, and the
 * switch that closes it now and keeps it closed until an admin opens it again. Only what the
 * control plane holds; what sets the room is not here.
 */
import type { PlatformControlsView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { whenTaken } from '../../../../lib/present'
import { Button, FormRow, FormSection, Modal, Note, Toggle } from '../../../../ui'

const points = (n: number) => `${n.toLocaleString('en')} point${n === 1 ? '' : 's'}`

export function EarlyPrice({ view }: { view: PlatformControlsView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(MINUTE_MS)
  const [closing, setClosing] = useState(false)
  const save = useMutation(
    trpc.admin.setEarlyClosed.mutationOptions({
      onSuccess: () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() }),
      onSettled: () => setClosing(false),
    }),
  )
  const room = view.earlyRoom
  const holds = room.validUntil !== null && new Date(room.validUntil).getTime() > now
  const open = room.closedSince === null
  const set =
    room.setAt === null
      ? 'Never set.'
      : `Set ${whenTaken(room.setAt, now).toLowerCase()}${room.validUntil ? `, ${holds ? 'holding until' : 'and ran out at'} ${new Date(room.validUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}.`
  return (
    <FormSection
      title="Early price"
      description="Room for checkouts at an early price, as it was last set. Prices already paid stay as they are, whatever happens here."
    >
      {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      {!open && room.closedSince && (
        <Note tone="info">
          {`Closed by ${room.closedBy ?? 'an admin'} ${whenTaken(room.closedSince, now).toLowerCase()}. Nothing set from outside opens it until it is opened here.`}
        </Note>
      )}
      <FormRow
        label="Room"
        description={set}
        control={<span className="type-body bk-num">{points(open && holds ? room.roomPoints : 0)}</span>}
      />
      <FormRow
        label="A checkout takes"
        control={
          <span className="type-body bk-num">{`Core ${points(room.points.core)}, Plus ${points(room.points.plus)}`}</span>
        }
      />
      <FormRow
        label="Holding it now"
        description="Checkout pages open at the early price, and ones paid since it was last set."
        control={
          <span className="type-body bk-num">
            {room.holds.count === 0 ? 'None' : `${room.holds.count}, taking ${points(room.holds.points)}`}
          </span>
        }
      />
      <FormRow
        label="Open"
        description={
          open
            ? 'On: checkouts take the early price while there is room.'
            : 'Closed: every checkout is at the plan’s own price.'
        }
        control={
          <Toggle
            ariaLabel="Early price open"
            checked={open}
            disabled={save.isPending}
            onChange={(on) => (on ? save.mutate({ closed: false }) : setClosing(true))}
          />
        }
      />
      <Modal
        open={closing}
        onClose={() => setClosing(false)}
        title="Close the early price now?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Keep it open
            </Button>
            <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate({ closed: true })}>
              Close it
            </Button>
          </>
        }
      >
        <p className="type-body">
          Every checkout from now on is at the plan’s own price, until it is opened here again. Checkout pages
          already open keep the price they show, and nobody’s price already paid changes.
        </p>
      </Modal>
    </FormSection>
  )
}
