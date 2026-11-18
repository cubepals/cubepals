// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The files Cubepals set aside for a start, each with its way back: "Put it back" returns it at the
 * server's next start, as every change to what a server boots does, and the line waiting for that
 * start has Cancel. Not why a file was set aside (`set-aside-lines.ts`).
 */
import type { ServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../lib/api'
import { Button, Note } from '../../../../ui'
import { setAsideLine } from './set-aside-lines'
import { useChanged } from './settings/shared'

export function SetAside({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(server.id)
  const putBack = useMutation(trpc.servers.putBack.mutationOptions({ onSuccess: (next) => changed(next) }))
  const files = server.setAside ?? []
  if (files.length === 0) return null
  return (
    <Note tone="info">
      <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        {files.map((file) => (
          <div
            key={file.path}
            className="bk-row bk-wrap"
            style={{ gap: 'var(--space-12)', justifyContent: 'space-between' }}
          >
            <span>{setAsideLine(file)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={putBack.isPending}
              onClick={() => putBack.mutate({ serverId: server.id, path: file.path, back: !file.back })}
            >
              {file.back ? 'Cancel' : 'Put it back'}
            </Button>
          </div>
        ))}
        {putBack.isError && <Note tone="danger">{messageOf(putBack.error)}</Note>}
      </div>
    </Note>
  )
}
