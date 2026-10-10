/**
 * What the signed-in pages are drawn with on their first paint, asked of the control plane on the
 * server with the browser's own cookie, so a page opened from an address or a reload arrives with
 * its data instead of a skeleton. Server-side only.
 *
 * It holds what nearly every page reads: who is signed in, their plan and what they use of it,
 * their servers and their trash, and the plans. One batched request, asked beside the session
 * check rather than after it. A page's own reads (one server, its backups) are not here: the app
 * asks for those before a link to them is followed (`app/(app)/prefetch.ts`).
 *
 * Nothing here holds a page up for long: past FIRST_PAINT_BUDGET_MS the page is sent without it
 * and asks in the browser, as it did before.
 */
import type { AppRouter } from '@blockly/control/router'
import { type DehydratedState, dehydrate, noop, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { headers } from 'next/headers'
import { apiUpstream } from './upstream'

/** The most the first paint waits on these before the page goes without them. */
const FIRST_PAINT_BUDGET_MS = 1_500

export async function firstPaint(): Promise<DehydratedState> {
  const queryClient = new QueryClient()
  const cookie = (await headers()).get('cookie')
  if (!cookie) return dehydrate(queryClient)
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUpstream()}/api/trpc`,
        headers: { cookie },
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            cache: 'no-store',
            signal: AbortSignal.timeout(FIRST_PAINT_BUDGET_MS),
          }),
      }),
    ],
  })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  // A read that fails is left out, and the page asks for it again in the browser.
  await Promise.all([
    queryClient.query(trpc.account.me.queryOptions()).catch(noop),
    queryClient.query(trpc.account.overview.queryOptions()).catch(noop),
    queryClient.query(trpc.servers.list.queryOptions()).catch(noop),
    queryClient.query(trpc.servers.trash.queryOptions()).catch(noop),
    queryClient.query(trpc.billing.plans.queryOptions()).catch(noop),
  ])
  return dehydrate(queryClient)
}
