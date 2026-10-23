// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Choosing what to play on the create page: whether a choice counts as picked, and why not where
 * it doesn't. Choosing something Blockly can't run is answered where the choice was made, not at a
 * button that does nothing. It is the question the bar asks too, so there is one rule about what
 * fits a plan, in one place, asked earlier: the control plane's (`preview.ts`).
 *
 * Each template and named pack is asked about ahead (`useChoicesAhead`), so a click on one is
 * settled on the spot; one whose answer is still on its way is picked at once, and let go again if
 * the answer refuses it. A pack found by search or a file of their own is checked before it counts
 * as picked: nothing asked about it ahead.
 */
import type { PartySize, SetupSourceInput } from '@blockly/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { knownPreviewOf, previewOf } from './preview'

type Answer = Awaited<ReturnType<typeof previewOf>> | { refused: unknown }

export function useChoosing({
  from,
  setFrom,
  judgedAt,
  moveOn,
}: {
  from: SetupSourceInput | null
  setFrom: (from: SetupSourceInput | null) => void
  /** The party a choice is judged for. */
  judgedAt: PartySize
  /** Moves on from a failed create's message, as changing anything does. */
  moveOn: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  // Why the last thing they picked can't be made, said where they picked it.
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null)
  // What is being checked before it counts as picked: a pack's id or an upload's.
  const [checking, setChecking] = useState<string | null>(null)
  // The last choice made: an answer that comes after another click is let go.
  const latest = useRef(0)

  /** The control plane's answer about a choice, as the page keeps it; `before` is what was chosen until then. */
  const settle = (answer: Answer, key: string, before: SetupSourceInput | null): boolean => {
    if ('refused' in answer) {
      setFrom(before)
      setRefused({ key, message: messageOf(answer.refused) })
      return false
    }
    // What another plan runs stays chosen, with that plan offered under it; what no plan runs is
    // refused where it was picked.
    const { size } = answer.would
    if (!size.allowed && size.plan == null) {
      setFrom(before)
      setRefused({ key, message: size.reason ?? 'That needs more power than your plan.' })
      return false
    }
    setFrom(answer.source)
    return true
  }

  /** Whether the choice counts as picked; `key` is where a refusal is said. */
  const choose = async (asked: SetupSourceInput, key: string): Promise<boolean> => {
    if (checking !== null) return false
    const turn = ++latest.current
    setRefused(null)
    moveOn()
    const known = knownPreviewOf(queries, trpc, asked, judgedAt)
    if (known !== null) return settle(known, key, from)
    const before = from
    const ahead = asked.kind === 'template' || asked.kind === 'curated'
    if (ahead) setFrom(asked)
    else setChecking(key)
    try {
      const answer = await previewOf(queries, trpc, asked, judgedAt).catch((error: unknown) => ({
        refused: error,
      }))
      return turn === latest.current && settle(answer, key, before)
    } finally {
      if (!ahead) setChecking(null)
    }
  }

  return { choose, checking, refused, setRefused }
}
