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
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
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
    void queries.prefetchQuery(trpc.account.me.queryOptions())
    void queries.prefetchQuery(trpc.account.overview.queryOptions())
    void queries.prefetchQuery(trpc.billing.plans.queryOptions())
  } else if (section === 'checkout') {
    void queries.prefetchQuery(trpc.account.overview.queryOptions())
  } else if (section === 'admin' && id === undefined) {
    void queries.prefetchQuery(trpc.admin.accounts.queryOptions({ search: '' }))
  } else if (section === 'servers' && id === undefined) {
    void queries.prefetchQuery(trpc.servers.list.queryOptions())
    void queries.prefetchQuery(trpc.servers.trash.queryOptions())
    void queries.prefetchQuery(trpc.account.overview.queryOptions())
  } else if (section === 'servers' && id === 'trash') {
    void queries.prefetchQuery(trpc.servers.trash.queryOptions())
    void queries.prefetchQuery(trpc.servers.purgedArchives.queryOptions())
    void queries.prefetchQuery(trpc.platform.capabilities.queryOptions())
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
  void queries.prefetchQuery(trpc.servers.get.queryOptions({ serverId }))
  if (tab === undefined || tab === 'players') {
    void queries.prefetchQuery(trpc.access.get.queryOptions({ serverId }))
    void queries.prefetchQuery(trpc.sharing.own.queryOptions({ serverId }))
  }
  // A mod search answers from a catalog outside Cubepals, and is asked for only on the page.
  if (tab === 'mods') void queries.prefetchQuery(trpc.mods.list.queryOptions({ serverId }))
  if (tab === 'world') void queries.prefetchQuery(trpc.worlds.list.queryOptions({ serverId }))
  if (tab === 'backups') void queries.prefetchQuery(trpc.backups.list.queryOptions({ serverId }))
  if (tab === 'backups' || tab === 'settings')
    void queries.prefetchQuery(trpc.platform.capabilities.queryOptions())
  if (tab === 'settings') {
    void queries.prefetchQuery(trpc.servers.settingsOptions.queryOptions({ serverId }))
    void queries.prefetchQuery(trpc.servers.revisions.queryOptions({ serverId }))
    void queries.prefetchQuery(trpc.account.overview.queryOptions())
  }
}
