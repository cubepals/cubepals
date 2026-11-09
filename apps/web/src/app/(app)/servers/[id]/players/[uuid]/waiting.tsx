// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What waits on a player's page for their next join: finding one of a kind, the line that says it
 * with a way to take it back, and reading the page again after a change. Used by the trips and
 * game mode (`page.tsx`) and the console buttons (`powers.tsx`); what each says is theirs.
 */
import type { PlayerView, WaitingView } from '@blockly/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '../../../../../../lib/api'
import { Button } from '../../../../../../ui'

/** What waits of one kind for them, if anything. */
export function waitingOf<K extends WaitingView['kind']>(
  player: PlayerView,
  kind: K,
): Extract<WaitingView, { kind: K }> | undefined {
  return player.waiting.find((w): w is Extract<WaitingView, { kind: K }> => w.kind === kind)
}

/** Something kept for when they next join, and the way to take it back. */
export function Waiting({
  serverId,
  player,
  kind,
  children,
}: {
  serverId: string
  player: PlayerView
  kind: WaitingView['kind']
  children: string
}) {
  const trpc = useTRPC()
  const refresh = useRefresh(serverId, player.uuid)
  const cancel = useMutation(trpc.players.cancel.mutationOptions({ onSettled: refresh }))
  return (
    <div className="bk-row" style={{ gap: 'var(--space-12)', flexWrap: 'wrap' }}>
      <p className="bk-field__help" style={{ margin: 0 }}>
        {children}
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate({ serverId, playerUuid: player.uuid, kind })}
      >
        Cancel
      </Button>
    </div>
  )
}

export function useRefresh(serverId: string, playerUuid: string) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return () =>
    void queries.invalidateQueries({ queryKey: trpc.players.get.queryKey({ serverId, playerUuid }) })
}
