'use client'

import type { AppErrorCode } from '@blockly/contracts'
import type { AppRouter } from '@blockly/control/router'
import {
  type DehydratedState,
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, httpLink, splitLink, TRPCClientError } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { type ReactNode, useState } from 'react'

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

/**
 * Calls answered by a catalog outside Cubepals (Modrinth, CurseForge), each sent on its own. A
 * batch answers only when its slowest call does, and a catalog that is slow or rate-limited would
 * hold back everything asked for beside it, the create page's own choices included.
 */
const OUTSIDE = new Set([
  'servers.searchModpacks',
  'servers.packFromLink',
  'servers.packVersions',
  'mods.search',
])

/**
 * The browser only ever talks to its own origin: /api is rewritten to the control plane, so
 * cookies stay host-only and no API address is ever baked into the bundle.
 *
 * `data` is what the server already read for this page (lib/first-paint.ts), so it is drawn with
 * it rather than fetched again after it loads.
 */
export function ApiProvider({ data, children }: { data?: DehydratedState; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // An answer is shown again at once on every later visit, and asked for anew behind it
          // once it is half a minute old: realtime hints refresh what changes sooner. One not
          // shown for half an hour is let go.
          queries: { staleTime: 30_000, gcTime: 30 * 60_000, retry: 1, refetchOnWindowFocus: true },
        },
      }),
  )
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => OUTSIDE.has(op.path),
          true: httpLink({ url: '/api/trpc' }),
          false: httpBatchLink({ url: '/api/trpc' }),
        }),
      ],
    }),
  )
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <HydrationBoundary state={data}>{children}</HydrationBoundary>
      </TRPCProvider>
    </QueryClientProvider>
  )
}

/** The sentence to show for a failed request: the API already words its refusals for people. */
export function messageOf(error: unknown): string {
  // Without an answer in the API's own shape the request never reached it: a dropped connection,
  // or something in between answering instead. The browser's words for that ("Failed to fetch")
  // are its own, not a person's.
  if (error instanceof TRPCClientError)
    return error.shape === undefined
      ? 'Cubepals couldn’t be reached. Check your connection and try again.'
      : error.message
  return 'Something went wrong on our side. Try again in a moment.'
}

/** Which refusal it was, for the few places that act on one rather than only show it. */
/** The API said there is nothing there, or nothing this person may see. */
export function isNotFound(error: unknown): boolean {
  return (
    error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === 'NOT_FOUND'
  )
}

export function codeOf(error: unknown): AppErrorCode | null {
  if (!(error instanceof TRPCClientError)) return null
  return (error.data as { appCode?: AppErrorCode | null } | undefined)?.appCode ?? null
}
