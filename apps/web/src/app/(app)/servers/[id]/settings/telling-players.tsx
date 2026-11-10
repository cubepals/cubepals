// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Whether this server tells a player in chat when its owner acts on them from their page: a trip,
 * an item, an emptied inventory. On until the owner turns it off; it applies at once. Saved as the
 * idle kick beside it is (`idle-players.tsx`).
 */
import type { ServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { FormRow, FormSection, Note, Toggle } from '../../../../../ui'
import { useChanged } from './shared'

export function TellingPlayers({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const save = useMutation(trpc.servers.setTellPlayers.mutationOptions({ onSuccess: changed }))
  return (
    <FormSection title="Telling players" description="These choices apply only to this server.">
      <FormRow
        label="Tell players what you did"
        description="When you teleport someone, give them something or empty their inventory from their page, they see a line in chat saying so. It applies straight away."
        control={
          <Toggle
            ariaLabel="Tell players what you did"
            checked={view.tellPlayers}
            disabled={save.isPending}
            onChange={(tell) => save.mutate({ serverId: view.id, tell })}
          />
        }
      />
      {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
    </FormSection>
  )
}
