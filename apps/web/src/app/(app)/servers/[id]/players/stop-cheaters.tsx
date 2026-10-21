// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Stop cheaters, first in the Players page's Moderation section: one switch wherever the server
 * can run it, with or without the moderation tools, and what it does; one line where it can't; and
 * the players it removed, each opening their own page. Not for the tools themselves, or the line on
 * restarting, which the section says once for every switch in it (`moderation.tsx`).
 */
import { REMOVAL_MESSAGES, type RemovalReason, type StopCheatersView } from '@blockly/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { timeAgo } from '../../../../../lib/present'
import { Button, Note, PlayerRow, Toggle } from '../../../../../ui'
import { useChanged } from '../settings/shared'

/** What the page says of a removal: what the player read, without the part that is only theirs. */
export const removalLine = (reason: RemovalReason) => REMOVAL_MESSAGES[reason].replace(' You can rejoin.', '')

/** A sentence's start: "just now" after a full stop reads "Just now". */
export const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Why Cubepals turned it on, where it did and says so. */
const WHY: Partial<Record<NonNullable<StopCheatersView['why']>, string>> = {
  browse: 'Cubepals turned this on when your server joined Browse.',
  template: 'Cubepals turned this on because strangers join Duels and Arcade servers.',
}

export function StopCheaters({
  serverId,
  view,
  tools,
}: {
  serverId: string
  view: StopCheatersView
  /** Whether the moderation tools are on, which add the ban. */
  tools: boolean
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(serverId)
  const refresh = (server: Parameters<typeof changed>[0]) => {
    changed(server)
    void queries.invalidateQueries({ queryKey: trpc.moderation.get.queryKey({ serverId }) })
  }
  const set = useMutation(trpc.moderation.setStopCheaters.mutationOptions({ onSuccess: refresh }))
  const ours = useMutation(trpc.moderation.useOurStopCheaters.mutationOptions({ onSuccess: refresh }))
  const { available } = view

  if (available.kind === 'modded')
    return (
      <p className="bk-field__help">
        Stop cheaters runs on plain Minecraft and Paper servers. Mods change how players move, so it can’t
        tell a cheat from a mod here.
      </p>
    )

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <Toggle
        label="Stop cheaters"
        checked={view.effective}
        disabled={set.isPending}
        onChange={(on) => set.mutate({ serverId, on, requestId: crypto.randomUUID() })}
      />
      {available.kind === 'release' ? (
        <p className="bk-field__help">Arrives when it runs on Minecraft {available.release}.</p>
      ) : (
        <p className="bk-field__help">
          Moves the game can’t make are undone, and a player who keeps cheating is removed. They can rejoin.
          {tools && ' Someone who keeps sending what no game can is banned for a while.'}
        </p>
      )}
      {view.effective && view.why !== null && WHY[view.why] && (
        <p className="bk-field__help">{WHY[view.why]}</p>
      )}
      {view.own && (
        <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <p className="bk-field__help">On, with your own Grim settings.</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={ours.isPending}
            onClick={() => ours.mutate({ serverId, requestId: crypto.randomUUID() })}
          >
            Use Cubepals’ settings
          </Button>
        </div>
      )}
      {(set.isError || ours.isError) && <Note tone="danger">{messageOf(set.error ?? ours.error)}</Note>}
      {view.removals.length > 0 && <Removed serverId={serverId} view={view} />}
    </div>
  )
}

/** The newest removals, as player rows that open each player's page. */
function Removed({ serverId, view }: { serverId: string; view: StopCheatersView }) {
  const now = Date.now()
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)', marginTop: 'var(--space-8)' }}>
      <h3 className="type-heading-sm" style={{ color: 'var(--ink)' }}>
        Removed by Stop cheaters
      </h3>
      <p className="bk-field__help">{view.today === 1 ? '1 today.' : `${view.today} today.`}</p>
      <div className="bk-list">
        {view.removals.map((removal) => (
          <PlayerRow
            key={`${removal.player.uuid}-${removal.at}`}
            name={removal.player.name || 'A player'}
            uuid={removal.player.uuid}
            online={false}
            meta={`${removalLine(removal.reason)} ${upper(timeAgo(removal.at, now))}.`}
            href={`/servers/${serverId}/players/${removal.player.uuid}`}
          />
        ))}
      </div>
    </div>
  )
}
