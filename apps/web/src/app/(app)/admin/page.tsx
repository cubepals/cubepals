// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { type SubmitEvent, useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../lib/api'
import { useDebounced } from '../../../lib/hooks'
import {
  Badge,
  Button,
  EmptyState,
  FormRow,
  FormSection,
  Note,
  Select,
  Skeleton,
  TextField,
} from '../../../ui'
import { StandingBadge } from './standing'
import { AdminTabs } from './tabs'

/** Platform admins: every account, found by name or email. */
export default function AdminPage() {
  const trpc = useTRPC()
  const [search, setSearch] = useState('')
  const settled = useDebounced(search.trim(), 300)
  const accounts = useQuery({
    ...trpc.admin.accounts.queryOptions({ search: settled }),
    placeholderData: (previous) => previous,
  })

  if (accounts.isError && isNotFound(accounts.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <FormSection
        title="Accounts"
        description={
          accounts.data ? `${accounts.data.total} ${accounts.data.total === 1 ? 'account' : 'accounts'}` : ''
        }
      >
        <TextField
          label="Find an account"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
        {accounts.isError && <Note tone="danger">{messageOf(accounts.error)}</Note>}
        {accounts.isPending ? (
          <Skeleton width="100%" height={120} />
        ) : (
          <div className="bk-list">
            {accounts.data?.accounts.length === 0 && (
              <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
                No account by that name or email.
              </p>
            )}
            {accounts.data?.accounts.map((account) => (
              <FormRow
                key={account.userId}
                label={
                  <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
                    <Link href={`/admin/accounts/${account.userId}`}>{account.name || account.email}</Link>
                    <StandingBadge account={account} />
                    {account.admin && <Badge tone="info">Admin</Badge>}
                    {account.test && <Badge tone="outline">Test</Badge>}
                  </span>
                }
                description={`${account.email}${account.emailVerified ? '' : ' (unconfirmed)'} · ${account.plan} · ${account.servers} ${account.servers === 1 ? 'server' : 'servers'}`}
                control={null}
              />
            ))}
          </div>
        )}
      </FormSection>
      <NewTestAccount />
    </>
  )
}

/**
 * An account to test Cubepals with, for an inbox the admin reads: it is confirmed already, has no
 * password, and is on the plan picked without paying for it.
 */
function NewTestAccount() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState('free')
  const create = useMutation(
    trpc.admin.createTestAccount.mutationOptions({
      onSuccess: () => {
        setEmail('')
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
    }),
  )
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    create.mutate({ email: email.trim(), plan })
  }
  return (
    <FormSection
      title="New test account"
      description="For testing Cubepals where players play. Use an inbox you read: sign in with Google, or set a password with Forgot password. It never pays, and it is left out of the numbers, billing and analytics."
    >
      <form onSubmit={submit} className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <TextField
            label="Email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Select
            label="Plan"
            value={plan}
            options={[
              { value: 'free', label: 'Free' },
              { value: 'plus', label: 'Plus' },
            ]}
            onChange={(event) => setPlan(event.target.value)}
          />
        </div>
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={email.trim() === '' || create.isPending}
          >
            Make test account
          </Button>
          {create.data && (
            <Link className="type-body-sm" href={`/admin/accounts/${create.data.userId}`}>
              Open it
            </Link>
          )}
          {create.isError && <span className="type-body-sm">{messageOf(create.error)}</span>}
        </div>
      </form>
    </FormSection>
  )
}
