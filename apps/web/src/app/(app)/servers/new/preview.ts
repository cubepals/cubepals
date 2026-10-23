// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a choice on the create page would make, asked of the control plane: each choice the page
 * shows is asked ahead, once, so a click finds its answer already here. Not the rules about what
 * fits a plan; those stay the control plane's, and this only carries its answers.
 */
import type { CreateOptions, PartySize, SetupPreview, SetupSourceInput } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { noop, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { codeOf, useTRPC } from '../../../../lib/api'

type Trpc = ReturnType<typeof useTRPC>
type Answer = { source: SetupSourceInput; would: SetupPreview }

/** How long the page trusts a preview it asked for: the control plane keeps a template's longer. */
export const PREVIEW_FRESH_MS = 5 * MINUTE_MS

/** The one question a preview is, for the page, the bar and the asks ahead alike. */
export function previewQuery(trpc: Trpc, from: SetupSourceInput, partySize: PartySize) {
  return { ...trpc.servers.setupPreview.queryOptions({ from, partySize }), staleTime: PREVIEW_FRESH_MS }
}

/** Its mods don't run on that release, or its server type isn't offered there. */
const refusal = (error: unknown) => codeOf(error) === 'mods_conflict' || codeOf(error) === 'invalid_choice'

/**
 * What a choice would make, and the choice that makes it. A version someone picked comes along to
 * each template they look at; one that can't run on it is asked for without, so it lands on the
 * newest release it runs on, and the bar says why.
 */
export async function previewOf(
  queries: Pick<QueryClient, 'query'>,
  trpc: Trpc,
  asked: SetupSourceInput,
  partySize: PartySize,
): Promise<Answer> {
  const ask = (from: SetupSourceInput) => queries.query(previewQuery(trpc, from, partySize))
  try {
    return { source: asked, would: await ask(asked) }
  } catch (error) {
    if (asked.kind !== 'template' || asked.gameVersion === undefined || !refusal(error)) throw error
    const newest = { kind: 'template', key: asked.key } as const
    return { source: newest, would: await ask(newest) }
  }
}

/**
 * `previewOf`'s answer from what the page already has, without waiting: the preview, or the
 * refusal it was answered with. Null when it has no fresh answer, or the last ask failed some
 * other way, which is asked again.
 */
export function knownPreviewOf(
  queries: Pick<QueryClient, 'getQueryState'>,
  trpc: Trpc,
  asked: SetupSourceInput,
  partySize: PartySize,
  now = Date.now(),
): Answer | { refused: unknown } | null {
  const state = queries.getQueryState(previewQuery(trpc, asked, partySize).queryKey)
  if (state === undefined) return null
  if (state.status === 'success' && now - state.dataUpdatedAt < PREVIEW_FRESH_MS)
    return { source: asked, would: state.data as SetupPreview }
  if (state.status !== 'error' || now - state.errorUpdatedAt >= PREVIEW_FRESH_MS || !refusal(state.error))
    return null
  if (asked.kind !== 'template' || asked.gameVersion === undefined) return { refused: state.error }
  return knownPreviewOf(queries, trpc, { kind: 'template', key: asked.key }, partySize, now)
}

/**
 * Every template and named pack the page offers. With a version picked, each template at it and
 * at its newest, where one that can't run on it lands.
 */
export function choicesAhead(
  live: Pick<CreateOptions, 'templates' | 'packs'>,
  version: string | undefined,
): SetupSourceInput[] {
  return [
    ...live.templates.flatMap(({ key }): SetupSourceInput[] => [
      { kind: 'template', key },
      ...(version === undefined ? [] : [{ kind: 'template', key, gameVersion: version } as const]),
    ]),
    ...live.packs.map(({ key }): SetupSourceInput => ({ kind: 'curated', key })),
  ]
}

/**
 * `choicesAhead` asked about once the page knows who it judges them for, so a click finds its
 * answer here. A page that offers no choices, as one copying a friend's server, asks nothing.
 */
export function useChoicesAhead({
  live,
  partySize,
  version,
  offers,
}: {
  live: Pick<CreateOptions, 'templates' | 'packs'> | undefined
  partySize: PartySize
  version: string | undefined
  offers: boolean
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  useEffect(() => {
    if (live === undefined || !offers) return
    for (const from of choicesAhead(live, version))
      queries.query(previewQuery(trpc, from, partySize)).catch(noop)
  }, [queries, trpc, live, partySize, version, offers])
}
