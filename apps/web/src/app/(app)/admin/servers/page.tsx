'use client'

import type { FleetServerView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced } from '../../../../lib/hooks'
import { Badge, EmptyState, FormRow, FormSection, Note, Skeleton, TextField } from '../../../../ui'
import { AdminTabs } from '../tabs'

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/**
 * Platform admins: every server, found by its name, its owner, or what the provider calls it, with
 * where it lives there and what it cost this month. The provider's own console shows the owner and
 * name too, as each machine's tags.
 */
export default function ServersPage() {
  const trpc = useTRPC()
  const [search, setSearch] = useState('')
  const settled = useDebounced(search.trim(), 300)
  const servers = useQuery({
    ...trpc.admin.servers.queryOptions({ search: settled }),
    placeholderData: (previous) => previous,
  })

  if (servers.isError && isNotFound(servers.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  const shown = servers.data?.servers.length ?? 0
  const total = servers.data?.total ?? 0
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <FormSection
        title="Servers"
        description={
          servers.data
            ? `${total} ${total === 1 ? 'server' : 'servers'}${shown < total ? `, the newest ${shown} shown` : ''}. Costs are this month's so far, at the provider's list prices.`
            : ''
        }
      >
        <TextField
          label="Find a server"
          placeholder="Name, address, owner, or the provider's name for it"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
        {servers.isError && <Note tone="danger">{messageOf(servers.error)}</Note>}
        {servers.isPending ? (
          <Skeleton width="100%" height={120} />
        ) : (
          <div className="bk-list">
            {shown === 0 && (
              <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
                No server by that name, owner or id.
              </p>
            )}
            {servers.data?.servers.map((server) => (
              <Server key={server.id} server={server} />
            ))}
          </div>
        )}
      </FormSection>
    </>
  )
}

function Server({ server }: { server: FleetServerView }) {
  const where = server.provider?.names.map((name) => `${name.label} ${name.value}`).join(' · ')
  return (
    <FormRow
      label={
        <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          {server.name}
          {server.deleted && <Badge tone="outline">In the trash</Badge>}
          <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            <Link href={`/admin/accounts/${server.owner.userId}`}>
              {server.owner.name || server.owner.email}
            </Link>
          </span>
        </span>
      }
      description={
        <>
          {server.slug} · {server.status} · {server.size} · {server.owner.email} · {server.owner.plan}
          {server.runtime && (
            <>
              {' · '}
              on {server.runtime.provider}
              {!server.runtime.runs && ' (not run here)'}
              {server.runtime.moveTo && `, moving to ${server.runtime.moveTo}`}
            </>
          )}
          <br />
          <span className="type-mono-sm">{where ?? 'Nothing at the provider yet'}</span>
          {server.provider?.link && (
            <>
              {' '}
              <a href={server.provider.link} target="_blank" rel="noreferrer">
                Open at the provider
              </a>
            </>
          )}
        </>
      }
      control={
        <span className="type-body-sm bk-num" style={{ whiteSpace: 'nowrap' }}>
          {server.month.hours} h
          {server.month.costCents === null ? '' : ` · ${dollars(server.month.costCents)}`}
        </span>
      }
    />
  )
}
