// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What a player carried when their inventory was emptied, the newest few, each with a way to put
 * it back: at once while they play, or as they next join, which the line under it says and can
 * take back (`waiting.tsx`). The world keeps the items whole; this lists them as the page shows
 * items. Emptying is `powers.tsx`'s.
 */
import { type KeptInventoryView, type PlayerView, shownName } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { said, useOutcome } from '../../../../../../lib/outcome'
import { timeAgo } from '../../../../../../lib/present'
import { Button, Note } from '../../../../../../ui'
import { useRefresh, Waiting, waitingOf } from './waiting'

/** How many of its items a line names before it says how many more. */
const NAMED = 3

export function KeptInventories({ serverId, player }: { serverId: string; player: PlayerView }) {
  if (player.kept.length === 0) return null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      {player.kept.map((kept) => (
        <KeptOne key={kept.id} serverId={serverId} player={player} kept={kept} />
      ))}
    </div>
  )
}

function KeptOne({
  serverId,
  player,
  kept,
}: {
  serverId: string
  player: PlayerView
  kept: KeptInventoryView
}) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const outcome = useOutcome(undefined)
  const putBack = useMutation(
    trpc.players.putBack.mutationOptions({
      onSuccess: (result) => {
        if (result.done === 'now') outcome.settled()
      },
      onError: () => outcome.refused(),
      onSettled: refresh,
    }),
  )
  const waiting = waitingOf(player, 'put_back')
  const name = shownName(player)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
      <p className="type-body-sm" style={{ margin: 0 }}>
        {`Kept when ${name}’s inventory was emptied, ${timeAgo(kept.keptAt, Date.now())}: ${listed(kept)}.`}
      </p>
      {waiting?.kept === kept.id ? (
        <Waiting serverId={serverId} player={player} kind="put_back">
          {`When ${name} next joins, these land at their feet.`}
        </Waiting>
      ) : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            {...said(outcome, { done: 'Put back', failed: 'Didn’t work' })}
            disabled={putBack.isPending}
            onClick={() => putBack.mutate({ serverId, playerUuid: player.uuid, kept: kept.id })}
          >
            Put it back
          </Button>
        </div>
      )}
      {putBack.isError && <Note tone="danger">{messageOf(putBack.error)}</Note>}
    </div>
  )
}

/** "Ow, 32 Torch and 3 more": the first few by name, with how many of each where more than one. */
function listed(kept: KeptInventoryView): string {
  const names = kept.items
    .slice(0, NAMED)
    .map((item) => (item.count > 1 ? `${item.count} ${item.name}` : item.name))
  const more = kept.items.length - names.length
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', ')
}
