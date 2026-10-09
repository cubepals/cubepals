'use client'

import type { AccountDetailView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { type SubmitEvent, useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../../lib/api'
import { useNow } from '../../../../../lib/hooks'
import { newId } from '../../../../../lib/ids'
import { said, useOutcome } from '../../../../../lib/outcome'
import { whenTaken } from '../../../../../lib/present'
import * as rules from '../../../../../lib/rules'
import {
  Badge,
  Button,
  DangerZone,
  EmptyState,
  FormRow,
  FormSection,
  Modal,
  Note,
  Select,
  Skeleton,
  TextField,
  Toggle,
} from '../../../../../ui'
import { StandingBadge } from '../../standing'

/** One account, as an admin runs it: standing, plan and limits, restrictions, and what was done. */
export default function AccountPage() {
  const { userId } = useParams<{ userId: string }>()
  const trpc = useTRPC()
  const account = useQuery(trpc.admin.account.queryOptions({ userId }))
  if (account.isPending) return <Skeleton width={240} height={36} />
  if (account.isError)
    return isNotFound(account.error) ? (
      <EmptyState title="Nothing here" description="No such account, or this page isn't yours to see." />
    ) : (
      <Note tone="danger">{messageOf(account.error)}</Note>
    )
  return <Account account={account.data} />
}

function Account({ account }: { account: AccountDetailView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(60_000)
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const [closing, setClosing] = useState<'suspend' | 'terminate' | null>(null)
  const [stopping, setStopping] = useState<AccountDetailView['serverList'][number] | null>(null)
  const reinstate = useMutation(trpc.admin.reinstate.mutationOptions({ onSuccess: refresh }))
  const grant = useMutation(trpc.admin.grantAdmin.mutationOptions({ onSuccess: refresh }))
  const revoke = useMutation(trpc.admin.revokeAdmin.mutationOptions({ onSuccess: refresh }))
  const failure = reinstate.error ?? grant.error ?? revoke.error

  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1
          className="type-display-md bk-row bk-wrap"
          style={{ color: 'var(--ink)', gap: 'var(--space-12)' }}
        >
          {account.name || account.email}
          <StandingBadge account={account} />
          {account.admin && <Badge tone="info">Admin</Badge>}
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          {account.email}
          {account.emailVerified ? '' : ' (unconfirmed)'} · joined{' '}
          {whenTaken(account.createdAt, now).toLowerCase()}
        </p>
      </header>
      {failure && <Note tone="danger">{messageOf(failure)}</Note>}

      <FormSection
        title="Standing"
        description={
          account.status === 'active'
            ? 'In good standing.'
            : `${account.status === 'suspended' ? 'Suspended' : 'Closed'}: ${account.reason ?? 'no reason given'}.`
        }
        actions={
          account.status === 'suspended' ? (
            <Button
              variant="primary"
              disabled={reinstate.isPending}
              onClick={() => reinstate.mutate({ userId: account.userId })}
            >
              Reinstate
            </Button>
          ) : undefined
        }
      >
        <Plan account={account} />
        <Limits account={account} />
      </FormSection>

      <Restrictions account={account} />

      <FormSection
        title="Admin"
        description="Admins run Cubepals: accounts, their standing and their plans."
        actions={
          account.admin ? (
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ userId: account.userId })}
            >
              Remove admin
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={grant.isPending}
              onClick={() => grant.mutate({ userId: account.userId })}
            >
              Make admin
            </Button>
          )
        }
      >
        <p className="type-body">{account.admin ? 'This account is an admin.' : 'A regular account.'}</p>
      </FormSection>

      <FormSection title="Servers" description="Every server the account has that isn't purged.">
        {account.serverList.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            None.
          </p>
        ) : (
          account.serverList.map((server) => (
            <FormRow
              key={server.id}
              label={
                <span className="bk-row" style={{ gap: 'var(--space-8)' }}>
                  {server.name}
                  {server.deleted && <Badge tone="outline">In the trash</Badge>}
                </span>
              }
              description={`${server.slug} · ${server.status}`}
              control={
                server.status === 'running' ? (
                  <Button variant="outline" size="sm" onClick={() => setStopping(server)}>
                    Stop for maintenance
                  </Button>
                ) : null
              }
            />
          ))
        )}
      </FormSection>
      {stopping && <MaintenanceStop server={stopping} onClose={() => setStopping(null)} />}

      <FormSection title="History" description="What admins and Cubepals did to this account.">
        {account.history.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            Nothing yet.
          </p>
        ) : (
          account.history.map((entry) => (
            <FormRow
              key={`${entry.at}-${entry.action}`}
              label={<span className="type-mono-sm">{entry.action}</span>}
              description={`${whenTaken(entry.at, now)} · ${entry.actor}${
                Object.keys(entry.data).length > 0 ? ` · ${JSON.stringify(entry.data)}` : ''
              }`}
              control={null}
            />
          ))
        )}
      </FormSection>

      {account.status !== 'terminated' && (
        <DangerZone
          items={[
            ...(account.status === 'active'
              ? [
                  {
                    label: 'Suspend',
                    description: 'Stops its servers and lets it do nothing but look, until reinstated.',
                    action: (
                      <Button variant="danger" onClick={() => setClosing('suspend')}>
                        Suspend account
                      </Button>
                    ),
                  },
                ]
              : []),
            {
              label: 'Close',
              description:
                'Deletes every server for good, backups on the provider with them. It can’t be undone.',
              action: (
                <Button variant="danger" onClick={() => setClosing('terminate')}>
                  Close account
                </Button>
              ),
            },
          ]}
        />
      )}
      {closing && <Close account={account} kind={closing} onClose={() => setClosing(null)} />}
    </>
  )
}

/** One server stopped for the platform's upkeep: its owner sees Blockly did it, and can start it again. */
function MaintenanceStop({
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

function Plan({ account }: { account: AccountDetailView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [plan, setPlan] = useState(account.plan)
  const saved = useOutcome(undefined)
  const save = useMutation(
    trpc.admin.setPlan.mutationOptions({
      onSuccess: () => {
        saved.settled()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
      onError: () => saved.refused(),
    }),
  )
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <Select
        label="Plan"
        help="Set by billing where there is billing; an admin can comp one."
        value={plan}
        options={account.plans.map((p) => ({ value: p, label: p[0]?.toUpperCase() + p.slice(1) }))}
        onChange={(event) => setPlan(event.target.value)}
      />
      <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
        <Button
          variant="outline"
          size="sm"
          {...said(saved)}
          disabled={plan === account.plan || save.isPending}
          onClick={() => save.mutate({ userId: account.userId, plan })}
        >
          Save plan
        </Button>
        {save.isError && <span className="type-body-sm">{messageOf(save.error)}</span>}
      </div>
    </div>
  )
}

function Limits({ account }: { account: AccountDetailView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [servers, setServers] = useState(account.limits.maxServers?.toString() ?? '')
  const [running, setRunning] = useState(account.limits.maxRunning?.toString() ?? '')
  const saved = useOutcome(undefined)
  const save = useMutation(
    trpc.admin.setLimits.mutationOptions({
      onSuccess: () => {
        saved.settled()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
      onError: () => saved.refused(),
    }),
  )
  const number = (value: string) => (value.trim() === '' ? null : Number.parseInt(value, 10))
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    save.mutate({ userId: account.userId, maxServers: number(servers), maxRunning: number(running) })
  }
  return (
    <form onSubmit={submit} className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
        <TextField
          label="Servers, instead of the plan's"
          optional
          inputMode="numeric"
          value={servers}
          error={rules.wholeNumber(servers)}
          onChange={(event) => setServers(event.target.value)}
        />
        <TextField
          label="Running at once, instead of the plan's"
          optional
          inputMode="numeric"
          value={running}
          error={rules.wholeNumber(running)}
          onChange={(event) => setRunning(event.target.value)}
        />
      </div>
      <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
        <Button type="submit" variant="outline" size="sm" {...said(saved)} disabled={save.isPending}>
          Save limits
        </Button>
        {save.isError && <span className="type-body-sm">{messageOf(save.error)}</span>}
      </div>
    </form>
  )
}

function Restrictions({ account }: { account: AccountDetailView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const save = useMutation(
    trpc.admin.setRestrictions.mutationOptions({
      onSuccess: () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() }),
    }),
  )
  const set = (change: Partial<AccountDetailView['restrictions']>) =>
    save.mutate({ userId: account.userId, ...account.restrictions, ...change })
  return (
    <FormSection
      title="Restrictions"
      description="Narrower than a suspension: the rest of the account works."
    >
      {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
      <FormRow
        label="No creating or starting servers"
        control={
          <Toggle
            ariaLabel="No creating or starting servers"
            checked={account.restrictions.provisioning}
            disabled={save.isPending}
            onChange={(on) => set({ provisioning: on })}
          />
        }
      />
      <FormRow
        label="No public listing"
        control={
          <Toggle
            ariaLabel="No public listing"
            checked={account.restrictions.publicListing}
            disabled={save.isPending}
            onChange={(on) => set({ publicListing: on })}
          />
        }
      />
      <FormRow
        label="Read-only console"
        control={
          <Toggle
            ariaLabel="Read-only console"
            checked={account.restrictions.consoleCommands}
            disabled={save.isPending}
            onChange={(on) => set({ consoleCommands: on })}
          />
        }
      />
    </FormSection>
  )
}

/** Suspending asks why; closing asks why and for the email, since it can't be undone. */
function Close({
  account,
  kind,
  onClose,
}: {
  account: AccountDetailView
  kind: 'suspend' | 'terminate'
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const done = {
    onSuccess: () => {
      onClose()
      return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
    },
  }
  const suspend = useMutation(trpc.admin.suspend.mutationOptions(done))
  const terminate = useMutation(trpc.admin.terminate.mutationOptions(done))
  const pending = suspend.isPending || terminate.isPending
  const failure = suspend.error ?? terminate.error
  const ready = reason.trim().length > 0 && (kind === 'suspend' || typed.trim() === account.email)
  return (
    <Modal
      open
      onClose={onClose}
      title={
        kind === 'suspend'
          ? `Suspend ${account.name || account.email}?`
          : `Close ${account.name || account.email}’s account?`
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ready || pending}
            onClick={() =>
              kind === 'suspend'
                ? suspend.mutate({ userId: account.userId, reason })
                : terminate.mutate({ userId: account.userId, reason })
            }
          >
            {kind === 'suspend' ? 'Suspend' : 'Close for good'}
          </Button>
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <p>
          {kind === 'suspend'
            ? 'Its running servers stop, and it can’t start, create or change anything until reinstated.'
            : `All ${account.serverList.length} of its servers are deleted and purged within minutes.`}
        </p>
        <TextField
          label="Why"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        {kind === 'terminate' && (
          <TextField
            label={`Type ${account.email} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        )}
        {failure && <Note tone="danger">{messageOf(failure)}</Note>}
      </div>
    </Modal>
  )
}
