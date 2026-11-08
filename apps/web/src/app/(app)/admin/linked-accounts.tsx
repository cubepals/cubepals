// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Accounts that look like one person's free hours, on the admin accounts page: each pair with what
 * links it and how sure Cubepals is of its group, a hold or a release for the newer account, and
 * Handled for a new pair. Only a group Cubepals is sure of shares its free hours; the others are
 * here to look at. Holding stops the account's free servers starting, and deletes nothing;
 * releasing gives it its own free hours again, for good; Handled marks the pair dealt with, which
 * takes it off the alert, and changes nothing else.
 */
import type { FreeLinkView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { messageOf, useTRPC } from '../../../lib/api'
import { useNow } from '../../../lib/hooks'
import { whenTaken } from '../../../lib/present'
import { Badge, Button, FormRow, FormSection, Note, Skeleton } from '../../../ui'

/** What links a pair, strongest first, with its score and its group's confidence, in a line. */
function why(link: FreeLinkView): string {
  const { signals } = link
  const seen = [
    signals.inbox >= 1 && 'one inbox',
    signals.mainPlayer > 0 && `one main player (${percent(signals.mainPlayer)})`,
    signals.playersMoved > 0 &&
      `the other’s players, after its free hours ran out (${percent(signals.playersMoved)})`,
    signals.signedUpClose > 0 && `signed up close together (${percent(signals.signedUpClose)})`,
    signals.network >= 1 && 'one network',
  ]
    .filter((said) => said !== false)
    .join(', ')
  const sure = `score ${percent(link.score)}, group ${percent(link.confidence)}`
  const what = link.shared ? 'they share free hours' : 'nothing changes for them'
  return `${seen.charAt(0).toUpperCase()}${seen.slice(1)}; ${sure}: ${what}.`
}

const percent = (n: number) => `${Math.round(n * 100)}%`

export function LinkedAccounts() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(MINUTE_MS)
  const links = useQuery(trpc.admin.freeLinks.queryOptions())
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const hold = useMutation(trpc.admin.holdFree.mutationOptions({ onSuccess: refresh }))
  const release = useMutation(trpc.admin.releaseFree.mutationOptions({ onSuccess: refresh }))
  const handled = useMutation(trpc.admin.handledFreeLink.mutationOptions({ onSuccess: refresh }))
  const pending = hold.isPending || release.isPending || handled.isPending
  const failure = links.error ?? hold.error ?? release.error ?? handled.error

  return (
    <FormSection
      title="Linked accounts"
      description="Accounts that look like one person using the free hours twice. Pairs Cubepals is sure of already share one set of free hours; the others only show here. Hold stops the newer account’s free servers starting and deletes nothing. Release gives it its own free hours again, for good. Handled marks the pair as dealt with and changes nothing else."
    >
      {failure && <Note tone="danger">{messageOf(failure)}</Note>}
      {links.isPending ? (
        <Skeleton width="100%" height={80} />
      ) : links.data?.length === 0 ? (
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          None.
        </p>
      ) : (
        links.data?.map((link) => (
          <FormRow
            key={`${link.account.userId}-${link.linked.userId}`}
            label={
              <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
                <Link href={`/admin/accounts/${link.account.userId}`}>{link.account.email}</Link>
                <span>→</span>
                <Link href={`/admin/accounts/${link.linked.userId}`}>{link.linked.email}</Link>
                {link.account.held && <Badge tone="danger">Held</Badge>}
                {link.shared && <Badge tone="neutral">Sharing</Badge>}
                {!link.reviewed && <Badge tone="info">New</Badge>}
              </span>
            }
            description={`${why(link)} Linked ${whenTaken(link.since, now).toLowerCase()}.`}
            control={
              <span className="bk-row" style={{ gap: 'var(--space-8)' }}>
                {!link.account.held && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => hold.mutate({ userId: link.account.userId })}
                  >
                    Hold
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => release.mutate({ userId: link.account.userId })}
                >
                  Release
                </Button>
                {!link.reviewed && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      handled.mutate({ accountId: link.account.userId, linkedId: link.linked.userId })
                    }
                  >
                    Handled
                  </Button>
                )}
              </span>
            }
          />
        ))
      )}
    </FormSection>
  )
}
