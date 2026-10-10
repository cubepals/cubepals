// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What each signed-in page reads before it can show anything, asked for before its link is
 * followed: when the pointer reaches the link, when it takes keyboard focus, when a finger lands on
 * it, or when the link is one a page already shows (a server's card). The page then opens on data
 * already in the cache instead of a skeleton.
 *
 * Only a page's first reads are here, the ones it waits on; what it fills in later asks for itself.
 * Each read respects the cache's staleTime (lib/api.tsx), so a link hovered again asks again only
 * once what it holds is old. What every page reads anyway is already in the cache from the first
 * paint (lib/first-paint.ts).
 */
import { noop, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTRPC } from '../../lib/api'

type Trpc = ReturnType<typeof useTRPC>

/** What the pages' links spread on themselves, and asking for a page's reads outright. */
export function usePrefetch() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return useMemo(() => {
    const page = (href: string) => prefetchPage(trpc, queries, href)
    return {
      page,
      /** A link's handlers: intent to follow it starts its page's reads. */
      intent: (href: string) => {
        const go = () => page(href)
        return { onMouseEnter: go, onFocus: go, onTouchStart: go }
      },
    }
  }, [trpc, queries])
}

function prefetchPage(trpc: Trpc, queries: QueryClient, href: string) {
  const [, section, id, tab] = (href.split(/[?#]/)[0] ?? '').split('/')
  if (section === 'account') {
    queries.query(trpc.account.me.queryOptions()).catch(noop)
    queries.query(trpc.account.overview.queryOptions()).catch(noop)
    queries.query(trpc.billing.plans.queryOptions()).catch(noop)
  } else if (section === 'checkout') {
    queries.query(trpc.account.overview.queryOptions()).catch(noop)
  } else if (section === 'admin' && id === undefined) {
    queries.query(trpc.admin.accounts.queryOptions({ search: '' })).catch(noop)
  } else if (section === 'servers' && id === undefined) {
    queries.query(trpc.servers.list.queryOptions()).catch(noop)
    queries.query(trpc.servers.trash.queryOptions()).catch(noop)
    queries.query(trpc.account.overview.queryOptions()).catch(noop)
  } else if (section === 'servers' && id === 'trash') {
    queries.query(trpc.servers.trash.queryOptions()).catch(noop)
    queries.query(trpc.servers.purgedArchives.queryOptions()).catch(noop)
    queries.query(trpc.platform.capabilities.queryOptions()).catch(noop)
  } else if (section === 'servers' && id !== undefined && id !== 'new') {
    prefetchServer(trpc, queries, id, tab)
  }
}

/** One server's page: the server itself, then what the tab waits on. */
function prefetchServer(trpc: Trpc, queries: QueryClient, serverId: string, tab: string | undefined) {
  // The list already holds each server as its own page reads it: a server shown there opens on
  // that, with no request, and is asked for again behind it once it is old.
  const getKey = trpc.servers.get.queryKey({ serverId })
  const listed = queries.getQueryState(trpc.servers.list.queryKey())
  const view = listed?.data?.find((server) => server.id === serverId)
  if (view !== undefined && queries.getQueryData(getKey) === undefined)
    queries.setQueryData(getKey, view, { updatedAt: listed?.dataUpdatedAt })
  queries.query(trpc.servers.get.queryOptions({ serverId })).catch(noop)
  if (tab === undefined || tab === 'players') {
    queries.query(trpc.access.get.queryOptions({ serverId })).catch(noop)
    queries.query(trpc.sharing.own.queryOptions({ serverId })).catch(noop)
  }
  // A mod search answers from a catalog outside Cubepals, and is asked for only on the page.
  if (tab === 'mods') queries.query(trpc.mods.list.queryOptions({ serverId })).catch(noop)
  if (tab === 'world') queries.query(trpc.worlds.list.queryOptions({ serverId })).catch(noop)
  if (tab === 'backups') queries.query(trpc.backups.list.queryOptions({ serverId })).catch(noop)
  if (tab === 'backups' || tab === 'settings')
    queries.query(trpc.platform.capabilities.queryOptions()).catch(noop)
  if (tab === 'settings') {
    queries.query(trpc.servers.settingsOptions.queryOptions({ serverId })).catch(noop)
    queries.query(trpc.servers.revisions.queryOptions({ serverId })).catch(noop)
    queries.query(trpc.account.overview.queryOptions()).catch(noop)
  }
}
