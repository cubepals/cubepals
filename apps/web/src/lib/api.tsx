// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { AppErrorCode } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
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

const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

export { useTRPC, useTRPCClient }

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
          // shown for half an hour is let go. A read nobody answered is asked again for about a
          // minute, at React Query's doubling delays, with the page keeping what it last showed
          // meanwhile: a deploy restarting the control plane takes less than that, and isn't
          // worth a page of "couldn't be reached".
          queries: {
            staleTime: 30_000,
            gcTime: 30 * MINUTE_MS,
            retry: (failures, error) => failures < (unanswered(error) ? 6 : 1),
            refetchOnWindowFocus: true,
          },
        },
      }),
  )
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => OUTSIDE.has(op.path),
          true: httpLink({ url: '/api/trpc' }),
          // A call made as the page is being left (`context: { leaving: true }`) is sent with
          // `keepalive`, which the browser finishes after the page has gone.
          false: splitLink({
            condition: (op) => op.context.leaving === true,
            true: httpLink({
              url: '/api/trpc',
              fetch: (url, init) => fetch(url, { ...init, keepalive: true }),
            }),
            false: httpBatchLink({ url: '/api/trpc' }),
          }),
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

/**
 * Whether a request got no answer in the API's own shape: nothing came back at all, or something
 * between the browser and the control plane answered instead (the Worker, or Fly's proxy while the
 * control plane restarts). Asking again is safe for a read, and for a change sent with the request
 * id it was first sent with.
 */
export function unanswered(error: unknown): boolean {
  return error instanceof TRPCClientError && error.shape === undefined
}

/** The sentence to show for a failed request: the API already words its refusals for people. */
export function messageOf(error: unknown): string {
  if (!(error instanceof TRPCClientError)) return 'Something went wrong on our side. Try again in a moment.'
  if (!unanswered(error)) return error.message
  // Without an answer in the API's own shape the browser's words for it ("Failed to fetch") are its
  // own, not a person's. Only a browser that knows it is offline makes it the connection: nothing
  // at all came back otherwise, and an answer that wasn't the API's came from Cubepals' side.
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return 'You’re offline. Check your connection and try again.'
  return error.cause instanceof TypeError
    ? 'Cubepals couldn’t be reached. Try again in a moment.'
    : 'Something on Cubepals’ side didn’t answer. Try again in a moment.'
}

/** Which refusal it was, for the few places that act on one rather than only show it. */
/** The API said there is nothing there, or nothing this person may see. */
export function isNotFound(error: unknown): boolean {
  return error instanceof TRPCClientError && (error as TRPCClientError<AppRouter>).data?.code === 'NOT_FOUND'
}

export function codeOf(error: unknown): AppErrorCode | null {
  if (!(error instanceof TRPCClientError)) return null
  return (error as TRPCClientError<AppRouter>).data?.appCode ?? null
}
