'use client'

import type { AuditEntryView } from '@blockly/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced, useNow } from '../../../../lib/hooks'
import { whenTaken } from '../../../../lib/present'
import { Button, EmptyState, FormSection, Note, Select, Skeleton, TextField } from '../../../../ui'
import { AdminTabs } from '../tabs'

/** The families of actions the log records, as the filter offers them. */
const FAMILIES = [
  { value: '', label: 'Everything' },
  { value: 'account.', label: 'Accounts: standing, plans, admins, passwords' },
  { value: 'server.', label: 'Servers: lifecycle, settings, backups, worlds' },
  { value: 'console.', label: 'Console commands' },
  { value: 'access.', label: 'Access: whitelist, operators, bans' },
  { value: 'listing.', label: 'Listings and moderation' },
  { value: 'mods.', label: 'Mod uploads' },
  { value: 'operation.', label: 'Blocked operations' },
  { value: 'platform.', label: 'Kill switches and caps' },
  { value: 'catalog.', label: 'Mod catalog' },
  { value: 'billing.', label: 'Billing: checkouts, payments, extra play, coupons' },
]

/** Everything admins, owners and Blockly itself did, newest first. */
export default function AuditPage() {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const [action, setAction] = useState('')
  const [who, setWho] = useState('')
  const [subject, setSubject] = useState('')
  const filters = { action, who: useDebounced(who.trim(), 300), subject: useDebounced(subject.trim(), 300) }
  const log = useInfiniteQuery(
    trpc.admin.audit.infiniteQueryOptions(filters, { getNextPageParam: (page) => page.next }),
  )

  if (log.isError && isNotFound(log.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? []
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <FormSection
        title="Audit log"
        description="Every change to an account, a server or the platform, and who made it."
      >
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <Select
            label="What"
            value={action}
            options={FAMILIES}
            onChange={(event) => setAction(event.target.value)}
          />
          <TextField
            label="Who"
            placeholder="Email, account id, or system:billing"
            value={who}
            autoComplete="off"
            onChange={(event) => setWho(event.target.value)}
          />
          <TextField
            label="About"
            placeholder="Server or account id"
            value={subject}
            autoComplete="off"
            mono
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        {log.isError && <Note tone="danger">{messageOf(log.error)}</Note>}
        {log.isPending ? (
          <Skeleton width="100%" height={200} />
        ) : entries.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            Nothing matches.
          </p>
        ) : (
          <ol className="bk-log">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} now={now} onSubject={setSubject} />
            ))}
          </ol>
        )}
        {log.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            disabled={log.isFetchingNextPage}
            onClick={() => log.fetchNextPage()}
          >
            {log.isFetchingNextPage ? 'Loading…' : 'Older entries'}
          </Button>
        )}
      </FormSection>
    </>
  )
}

/** One entry: what happened and to what, then when and by whom, then its details. */
function Entry({
  entry,
  now,
  onSubject,
}: {
  entry: AuditEntryView
  now: number
  onSubject: (id: string) => void
}) {
  const person = entry.actor.match(/^(user|admin):(.+)$/)
  const details = Object.keys(entry.data).length > 0 ? JSON.stringify(entry.data) : null
  return (
    <li className="bk-log__entry">
      <div className="bk-log__head">
        <span className="type-mono-sm">{entry.action}</span>
        {entry.subjectType === 'account' ? (
          <Link href={`/admin/accounts/${entry.subjectId}`}>{entry.subjectName ?? entry.subjectId}</Link>
        ) : entry.subjectType === 'server' ? (
          <button type="button" className="bk-linkbutton" onClick={() => onSubject(entry.subjectId)}>
            {entry.subjectName ?? entry.subjectId}
          </button>
        ) : (
          <span className="type-mono-sm">
            {entry.subjectType}:{entry.subjectId}
          </span>
        )}
      </div>
      <div className="bk-log__meta">
        {whenTaken(entry.at, now)} ·{' '}
        {person ? (
          <Link href={`/admin/accounts/${person[2]}`}>
            {entry.actorEmail ?? person[2]}
            {person[1] === 'admin' ? ' as admin' : ''}
          </Link>
        ) : (
          <span className="type-mono-sm">{entry.actor}</span>
        )}
      </div>
      {details && <code className="bk-log__data">{details}</code>}
    </li>
  )
}
