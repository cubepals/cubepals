'use client'

/** What an admin does to someone else's server, from the pages where they find it. */
import type { AccountDetailView } from '@blockly/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { newId } from '../../../lib/ids'
import { Button, Modal, Note, TextField } from '../../../ui'

/** One server stopped for the platform's upkeep: its owner sees Blockly did it, and can start it again. */
export function MaintenanceStop({
  server,
  onClose,
}: {
  server: AccountDetailView['serverList'][number]
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [reason, setReason] = useState('')
  const [requestId] = useState(() => newId())
  const stop = useMutation(
    trpc.admin.stopForMaintenance.mutationOptions({
      onSuccess: () => {
        onClose()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
    }),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={`Stop ${server.name} for maintenance?`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length === 0 || stop.isPending}
            onClick={() => stop.mutate({ serverId: server.id, requestId, reason })}
          >
            Stop it
          </Button>
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <p>
          It saves and stops. Its owner sees Cubepals stopped it for maintenance, and can start it again
          whenever they like.
        </p>
        <TextField
          label="Why"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        {stop.error && <Note tone="danger">{messageOf(stop.error)}</Note>}
      </div>
    </Modal>
  )
}
