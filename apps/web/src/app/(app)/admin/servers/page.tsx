// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { FleetPage } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced, useNow } from '../../../../lib/hooks'
import { EmptyState, FormSection, Note, Skeleton, TextField } from '../../../../ui'
import { AdminTabs } from '../tabs'
import { Region } from './region'
import { dollars } from './words'

/**
 * Platform admins: every server, by where it runs, with how each place's servers are and what they
 * cost this month. A search by name, owner, or what the provider calls a server narrows the same
 * view. The provider's own console shows the owner and name too, as each machine's tags.
 */
export default function ServersPage() {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const [search, setSearch] = useState('')
  const settled = useDebounced(search.trim(), 300)
  const servers = useQuery({
    ...trpc.admin.servers.queryOptions({ search: settled }),
    placeholderData: (previous) => previous,
  })

  if (servers.isError && isNotFound(servers.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  const page = servers.data
  const fleetEmpty = page !== undefined && page.total === 0 && settled === ''
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <FormSection title="Servers" description={page ? summary(page) : ''}>
        {!fleetEmpty && (
          <TextField
            label="Find a server"
            placeholder="Name, address, owner, or the provider's name for it"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        )}
        {servers.isError && <Note tone="danger">{messageOf(servers.error)}</Note>}
        {servers.isPending && <Skeleton width="100%" height={120} />}
        {page?.total === 0 && settled !== '' && (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            No server by that name, owner or id.
          </p>
        )}
      </FormSection>
      {fleetEmpty && (
        <EmptyState
          title="No servers yet"
          description="Each one shows up here as soon as someone makes it, under the provider and region it runs in."
        />
      )}
      {page?.regions.map((region) => (
        <Region
          key={`${region.provider}/${region.region}`}
          region={region}
          servers={page.servers.filter(
            (server) =>
              (server.runtime?.provider ?? null) === region.provider && server.region === region.region,
          )}
          now={now}
        />
      ))}
    </>
  )
}

/** "12 servers in 3 places, $41.20 this month at the provider's list prices." */
function summary(page: FleetPage): string {
  if (page.total === 0) return ''
  const places = page.regions.length
  const billed = page.regions.filter((region) => region.month.costCents !== null)
  const cost = billed.reduce((sum, region) => sum + (region.month.costCents ?? 0), 0)
  return [
    `${page.total} ${page.total === 1 ? 'server' : 'servers'}`,
    places > 1 ? ` in ${places} places` : '',
    billed.length > 0 ? `, ${dollars(cost)} this month at the provider's list prices` : '',
    page.servers.length < page.total ? `. The newest ${page.servers.length} are listed` : '',
    '.',
  ].join('')
}
