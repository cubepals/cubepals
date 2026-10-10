// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A player's access, on their own page: whether they are on the list of who can join, an
 * operator, or banned. The same changes the Players tab makes, through the same `access.*` calls,
 * so there is one way to each; delivered at once while the server runs, at its next start if not.
 */
import type { AccessEntryView, AccessList, PlayerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../../lib/api'
import { FormSection, Note, Toggle } from '../../../../../../ui'

export function AccessSwitches({
  serverId,
  player,
  running,
}: {
  serverId: string
  player: PlayerView
  running: boolean
}) {
  const trpc = useTRPC()
  const access = useQuery(trpc.access.get.queryOptions({ serverId }))
  if (!access.isSuccess) return null
  const entry = (list: AccessList) =>
    access.data.entries.find((e) => e.list === list && e.player.uuid === player.uuid)
  const whitelistOn = access.data.pendingWhitelistEnabled ?? access.data.whitelistEnabled
  return (
    <FormSection title="Access">
      <Switch
        serverId={serverId}
        player={player}
        list="whitelist"
        label="Can join"
        entry={entry('whitelist')}
        running={running}
        help={whitelistOn ? undefined : 'Anyone with the address can join right now.'}
      />
      <Switch
        serverId={serverId}
        player={player}
        list="operator"
        label="Operator"
        entry={entry('operator')}
        running={running}
      />
      <Switch
        serverId={serverId}
        player={player}
        list="ban"
        label="Banned"
        entry={entry('ban')}
        running={running}
      />
    </FormSection>
  )
}

function Switch({
  serverId,
  player,
  list,
  label,
  entry,
  running,
  help,
}: {
  serverId: string
  player: PlayerView
  list: AccessList
  label: string
  entry: AccessEntryView | undefined
  running: boolean
  help?: string | undefined
}) {
  const { add, remove } = useListChange(list)
  const on = entry !== undefined && entry.state !== 'pending_remove' && entry.state !== 'rejected'
  const failed = add.error ?? remove.error
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
      <Toggle
        label={label}
        checked={on}
        disabled={add.isPending || remove.isPending}
        onChange={(next) =>
          next
            ? add.mutate({ serverId, name: player.name })
            : remove.mutate({ serverId, playerUuid: player.uuid })
        }
      />
      <SwitchHelp entry={entry} running={running} help={help} />
      {failed && <Note tone="danger">{messageOf(failed)}</Note>}
    </div>
  )
}

/** Whether the change has reached the server yet, or why it didn't; otherwise what the switch means here. */
function SwitchHelp({
  entry,
  running,
  help,
}: {
  entry: AccessEntryView | undefined
  running: boolean
  help: string | undefined
}) {
  const line =
    entry?.state === 'pending_add' || entry?.state === 'pending_remove'
      ? running
        ? 'Applying…'
        : 'This takes effect when the server starts.'
      : entry?.state === 'rejected'
        ? (entry.error ?? 'The server did not accept this.')
        : help
  return line ? <p className="bk-field__help">{line}</p> : null
}

/** The same calls the Players tab makes for this list. */
function useListChange(list: AccessList) {
  const trpc = useTRPC()
  const add = useMutation(
    list === 'whitelist'
      ? trpc.access.addToWhitelist.mutationOptions()
      : list === 'operator'
        ? trpc.access.op.mutationOptions()
        : trpc.access.ban.mutationOptions(),
  )
  const remove = useMutation(
    list === 'whitelist'
      ? trpc.access.removeFromWhitelist.mutationOptions()
      : list === 'operator'
        ? trpc.access.deop.mutationOptions()
        : trpc.access.pardon.mutationOptions(),
  )
  return { add, remove }
}
