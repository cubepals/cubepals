'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../lib/api'
import { useDebounced } from '../../../lib/hooks'
import { Badge, EmptyState, FormRow, FormSection, Note, Skeleton, TextField } from '../../../ui'
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
                  </span>
                }
                description={`${account.email}${account.emailVerified ? '' : ' (unconfirmed)'} · ${account.plan} · ${account.servers} ${account.servers === 1 ? 'server' : 'servers'}`}
                control={null}
              />
            ))}
          </div>
        )}
      </FormSection>
    </>
  )
}
