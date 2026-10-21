// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Stop cheaters on a player's own page: each time it removed them, and, folded away where the
 * moderation tools run, a way to leave them unchecked (`grim.exempt` through LuckPerms) and to
 * check them again. Not for warnings, mutes and bans (`moderation.tsx`).
 */
import type { PlayerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { timeAgo } from '../../../../../../lib/present'
import { Button, FormSection, Note } from '../../../../../../ui'
import { removalLine, upper } from '../stop-cheaters'

export function PlayerRemovals({ serverId, player }: { serverId: string; player: PlayerView }) {
  const trpc = useTRPC()
  const removals = useQuery(trpc.moderation.removalsOf.queryOptions({ serverId, playerUuid: player.uuid }))
  const moderation = useQuery(trpc.moderation.get.queryOptions({ serverId }))
  const access = useQuery(trpc.access.get.queryOptions({ serverId }))
  if (!removals.isSuccess || !moderation.isSuccess) return null
  const checking = moderation.data.stopCheaters.effective && moderation.data.enabled
  if (removals.data.length === 0 && !checking) return null
  const unchecked = access.data?.entries.find(
    (e) => e.list === 'unchecked' && e.player.uuid === player.uuid && e.state !== 'pending_remove',
  )
  const now = Date.now()
  return (
    <FormSection title="Stop cheaters">
      {removals.data.length === 0 ? (
        <p className="bk-field__help">{player.name} hasn’t been removed here.</p>
      ) : (
        <ul className="bk-stack" style={{ gap: 'var(--space-8)', listStyle: 'none', padding: 0, margin: 0 }}>
          {removals.data.map((removal) => (
            <li key={removal.at} className="bk-stack" style={{ gap: 'var(--space-2)' }}>
              <span className="type-body-md" style={{ color: 'var(--ink)' }}>
                {removalLine(removal.reason)}
              </span>
              <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
                {upper(timeAgo(removal.at, now))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {checking && <Unchecked serverId={serverId} player={player} unchecked={unchecked !== undefined} />}
    </FormSection>
  )
}

/** Out of the way: most never need it. */
function Unchecked({
  serverId,
  player,
  unchecked,
}: {
  serverId: string
  player: PlayerView
  unchecked: boolean
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const settled = {
    onSettled: () => void queries.invalidateQueries({ queryKey: trpc.access.get.queryKey({ serverId }) }),
  }
  const add = useMutation(trpc.access.addUnchecked.mutationOptions(settled))
  const remove = useMutation(trpc.access.removeUnchecked.mutationOptions(settled))
  const failed = add.error ?? remove.error
  return (
    <details>
      <summary className="type-body-sm" style={{ color: 'var(--ink-muted)', cursor: 'pointer' }}>
        {unchecked ? `${player.name} isn’t checked` : 'More'}
      </summary>
      <div className="bk-stack" style={{ gap: 'var(--space-8)', marginTop: 'var(--space-12)' }}>
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={add.isPending || remove.isPending}
            onClick={() =>
              unchecked
                ? remove.mutate({ serverId, playerUuid: player.uuid })
                : add.mutate({ serverId, name: player.name })
            }
          >
            {unchecked ? 'Check them again' : 'Don’t check them'}
          </Button>
        </div>
        {failed && <Note tone="danger">{messageOf(failed)}</Note>}
      </div>
    </details>
  )
}
