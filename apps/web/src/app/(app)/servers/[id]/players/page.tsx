'use client'

import type { AccessEntryView, AccessList, AccessView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type SubmitEvent, useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { said, useOutcome } from '../../../../../lib/outcome'
import { joinLine, packToInstall } from '../../../../../lib/present'
import * as rules from '../../../../../lib/rules'
import { useChecked } from '../../../../../lib/use-checked'
import {
  Badge,
  Button,
  CopyField,
  EmptyState,
  FormSection,
  LoadFailed,
  Note,
  PlayerRow,
  Skeleton,
  SuggestField,
  Toggle,
} from '../../../../../ui'
import { useServer } from '../use-server'

export default function PlayersPage() {
  const server = useServer()
  const trpc = useTRPC()
  const access = useQuery(trpc.access.get.queryOptions({ serverId: server.id }))
  const { mutate: refresh } = useMutation(trpc.access.refresh.mutationOptions())

  // Opening the page asks the server what changed in game; the list updates when the sync lands.
  useEffect(() => {
    refresh({ serverId: server.id })
  }, [refresh, server.id])

  if (server.isPending || access.isPending) return <Skeleton width={240} height={36} />
  if (server.isError || access.isError)
    return (
      <EmptyState
        danger
        title="We could not load the players"
        description={messageOf(server.error ?? access.error)}
      />
    )

  const running = server.data.status === 'running'
  // Where the server doesn't check accounts, the name typed here is exactly who can join.
  const nameHelp = server.data.settings.onlineMode
    ? undefined
    : 'Exactly as it is in the game: capitals count.'
  const whitelistOn = access.data.pendingWhitelistEnabled ?? access.data.whitelistEnabled
  const online = server.data.players?.people ?? []
  const invite = <InviteCard server={server.data} whitelistOnly={whitelistOn} />

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Players
      </h1>

      {/* While nobody is on, inviting people is what the page is for. Once someone is, the players
          come first and the same invitation waits just below them. */}
      {online.length === 0 ? (
        <EmptyState
          title="Nobody's online right now"
          action={<div style={{ width: 'min(var(--width-form), 100%)', textAlign: 'left' }}>{invite}</div>}
        />
      ) : (
        <>
          <OnlineNow serverId={server.id} people={online} />
          {invite}
        </>
      )}

      <PlayedHere serverId={server.id} known={access.data.players} />

      <FormSection title="Who can join" description="Anyone with the address, or only the people you add.">
        <WhitelistToggle
          serverId={server.id}
          enabled={whitelistOn}
          pending={access.data.pendingWhitelistEnabled !== null}
          running={running}
        />
        {whitelistOn && (
          <AccessSection
            serverId={server.id}
            list="whitelist"
            entries={access.data.entries}
            known={access.data.players}
            running={running}
            addLabel="Add a player"
            nameHelp={nameHelp}
            empty="Nobody yet. Add yourself first, then your friends."
          />
        )}
      </FormSection>

      <FormSection
        title="Operators"
        description="Operators can use every command in the game and join even when the server is full."
      >
        <AccessSection
          serverId={server.id}
          list="operator"
          entries={access.data.entries}
          known={access.data.players}
          running={running}
          addLabel="Make someone an operator"
          nameHelp={nameHelp}
          empty="No operators yet."
        />
      </FormSection>

      <FormSection title="Banned players" description="Banned players cannot join, whoever else is allowed.">
        {access.data.liftedIpBans.length > 0 && (
          <Note tone="info">
            {access.data.liftedIpBans.length === 1
              ? `Someone banned the address ${access.data.liftedIpBans[0]?.ip} in game, and Cubepals lifted it.`
              : `Someone banned ${access.data.liftedIpBans.length} addresses in game, and Cubepals lifted them.`}{' '}
            Every player reaches your server through the same Cubepals address, so an IP ban would lock
            everyone out. Ban the player instead.
          </Note>
        )}
        <AccessSection
          serverId={server.id}
          list="ban"
          entries={access.data.entries}
          known={access.data.players}
          running={running}
          addLabel="Ban a player"
          nameHelp={nameHelp}
          empty="Nobody is banned."
        />
      </FormSection>
    </>
  )
}

/** Each player's own page, which their row opens. */
const pageOf = (serverId: string, uuid: string) => `/servers/${serverId}/players/${uuid}`

function OnlineNow({ serverId, people }: { serverId: string; people: { name: string; uuid: string }[] }) {
  return (
    <section className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <h2 className="type-heading-md" style={{ color: 'var(--ink)' }}>
        Online now
      </h2>
      <div className="bk-list">
        {people.map((player) => (
          <PlayerRow
            key={player.uuid}
            name={player.name}
            uuid={player.uuid}
            meta="Playing now"
            href={pageOf(serverId, player.uuid)}
          />
        ))}
      </div>
    </section>
  )
}

/** Everyone who has played here and isn't on now, each a way to their page. */
function PlayedHere({ serverId, known }: { serverId: string; known: AccessView['players'] }) {
  const away = known.filter((player) => !player.online)
  if (away.length === 0) return null
  return (
    <FormSection title="Who has played here">
      <div className="bk-list">
        {away.map((player) => (
          <PlayerRow
            key={player.uuid}
            name={player.name}
            uuid={player.uuid}
            online={false}
            href={pageOf(serverId, player.uuid)}
          />
        ))}
      </div>
    </FormSection>
  )
}

/**
 * The invite link, the same one behind Share: it opens a friend's own page, with the address,
 * what to install and, where only listed people can join, a way onto the list. The address is
 * under it for whoever would rather paste that into Minecraft themselves.
 */
function InviteCard({ server, whitelistOnly }: { server: ServerView; whitelistOnly: boolean }) {
  const trpc = useTRPC()
  const share = useQuery(trpc.sharing.own.queryOptions({ serverId: server.id }))
  return (
    <FormSection
      title="Invite your friends"
      description={
        whitelistOnly
          ? 'The link shows them what to install, and adds them to the players who may join.'
          : 'The link shows them what to install and where to paste the address.'
      }
    >
      {share.isPending ? (
        <Skeleton width="100%" height={52} />
      ) : share.isError ? (
        <LoadFailed error={messageOf(share.error)} onRetry={() => void share.refetch()} />
      ) : (
        <CopyField value={share.data.inviteUrl} label="Copy link" />
      )}
      <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <span className="bk-field__label">Or just the address</span>
        <CopyField value={server.joinAddress} />
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {joinLine(server.gameVersion, packToInstall(server))}
        </p>
      </div>
    </FormSection>
  )
}

function WhitelistToggle({
  serverId,
  enabled,
  pending,
  running,
}: {
  serverId: string
  enabled: boolean
  pending: boolean
  running: boolean
}) {
  const trpc = useTRPC()
  // "Applied." once the server has the change: seen waiting for it after the press, then not.
  const applied = useOutcome(undefined)
  const [asked, setAsked] = useState<'no' | 'sent' | 'waiting'>('no')
  const set = useMutation(trpc.access.setWhitelist.mutationOptions({ onSuccess: () => setAsked('sent') }))
  useEffect(() => {
    if (asked === 'sent' && pending) setAsked('waiting')
    else if (asked === 'waiting' && !pending) {
      setAsked('no')
      applied.settled()
    }
  }, [asked, pending, applied])
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <Toggle
        label="Only people I add can join"
        checked={enabled}
        disabled={set.isPending}
        onChange={(next) => set.mutate({ serverId, enabled: next })}
      />
      {pending ? (
        <p className="bk-field__help">
          {running ? 'Applying…' : 'This takes effect when the server starts.'}
        </p>
      ) : (
        applied.said === 'done' && <p className="bk-field__help">Applied.</p>
      )}
      {set.isError && <Note tone="danger">{messageOf(set.error)}</Note>}
    </div>
  )
}

const REMOVE: Record<AccessList, string> = { whitelist: 'Remove', operator: 'Remove', ban: 'Unban' }

function AccessSection({
  serverId,
  list,
  entries,
  known,
  running,
  addLabel,
  empty,
  nameHelp,
}: {
  serverId: string
  list: AccessList
  entries: AccessEntryView[]
  /** Everyone who has played here, offered as the name is typed. */
  known: AccessView['players']
  running: boolean
  addLabel: string
  empty: string
  nameHelp: string | undefined
}) {
  const trpc = useTRPC()
  const [name, setName] = useState('')
  const checked = useChecked(rules.playerName, name)
  // The name is on the list as soon as the request lands; its row says when the game has it.
  const outcome = useOutcome(undefined)
  const options = {
    onSuccess: () => {
      setName('')
      outcome.settled()
    },
    onError: () => outcome.refused(),
  }
  const add = useMutation(
    list === 'whitelist'
      ? trpc.access.addToWhitelist.mutationOptions(options)
      : list === 'operator'
        ? trpc.access.op.mutationOptions(options)
        : trpc.access.ban.mutationOptions(options),
  )
  const remove = useMutation(
    list === 'whitelist'
      ? trpc.access.removeFromWhitelist.mutationOptions()
      : list === 'operator'
        ? trpc.access.deop.mutationOptions()
        : trpc.access.pardon.mutationOptions(),
  )
  const shown = entries.filter((e) => e.list === list)
  // Who has played here, less whoever this list already has: by who they are, or by the name.
  const offered = known
    .filter((player) => !shown.some((e) => e.player.uuid === player.uuid || e.player.name === player.name))
    .map((player) => (player.online ? { value: player.name, note: 'Playing now' } : { value: player.name }))

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (name.trim()) add.mutate({ serverId, name: name.trim() })
  }

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
      <form onSubmit={submit}>
        <SuggestField
          label={addLabel}
          placeholder="Minecraft name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          suggestions={offered}
          onPick={setName}
          error={(add.isError ? messageOf(add.error) : null) ?? checked.error}
          help={nameHelp}
          onChange={(event) => setName(event.target.value)}
          {...checked.field}
          trailing={
            <Button
              variant="outline"
              type="submit"
              {...said(
                outcome,
                list === 'ban'
                  ? { done: 'Banned', failed: 'Didn’t ban' }
                  : { done: 'Added', failed: 'Didn’t add' },
              )}
              disabled={!name.trim() || add.isPending}
            >
              {list === 'ban' ? 'Ban' : 'Add'}
            </Button>
          }
        />
      </form>
      {shown.length === 0 ? (
        <p className="bk-field__help">{empty}</p>
      ) : (
        <div className="bk-list">
          {shown.map((entry) => (
            <PlayerRow
              key={entry.player.uuid}
              name={entry.player.name}
              uuid={entry.player.uuid}
              online={entry.state !== 'pending_remove'}
              href={pageOf(serverId, entry.player.uuid)}
              meta={metaOf(entry, running)}
              {...(entry.state === 'rejected' ? { metaTone: 'danger' as const } : {})}
              {...(list === 'operator' && entry.state === 'active'
                ? { badge: <Badge tone="grass">Operator</Badge> }
                : {})}
              action={
                entry.state === 'pending_remove' ? undefined : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ serverId, playerUuid: entry.player.uuid })}
                  >
                    {REMOVE[list]}
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function metaOf(entry: AccessEntryView, running: boolean): string | undefined {
  switch (entry.state) {
    case 'pending_add':
      return entry.error
        ? `Not applied yet — ${entry.error}`
        : running
          ? 'Adding…'
          : 'Added when the server starts'
    case 'pending_remove':
      return running ? 'Removing…' : 'Removed when the server starts'
    case 'rejected':
      return entry.error ?? 'The server did not accept this'
    case 'active':
      return entry.origin === 'game' ? 'Added in game' : (entry.reason ?? undefined)
  }
}
