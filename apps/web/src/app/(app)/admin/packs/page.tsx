'use client'

import type { CuratedPackAdminView, CuratedReleaseAdminView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { whenTaken } from '../../../../lib/present'
import {
  Badge,
  Button,
  EmptyState,
  FormRow,
  FormSection,
  Modal,
  Note,
  Skeleton,
  TextField,
} from '../../../../ui'
import { AdminTabs } from '../tabs'
import { Compatibility } from './compatibility'

/**
 * Packs Blockly offers by name (docs/modpack-templates.md). Which packs and releases exist is the
 * review in the code; each release is fetched and checked by itself, and nothing reaches people
 * making a server until an admin offers it here. Withdrawing one takes it from new servers only.
 * Below them, templates whose plugins lag, and the versions Cubepals tested (`compatibility.tsx`).
 */
export default function CuratedPacksPage() {
  const trpc = useTRPC()
  const packs = useQuery(trpc.admin.curatedPacks.queryOptions())
  if (packs.isError && isNotFound(packs.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      {packs.isError && <Note tone="danger">{messageOf(packs.error)}</Note>}
      {packs.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : packs.data?.length === 0 ? (
        <EmptyState
          title="No curated packs"
          description="A pack is added by reviewing it in the code (app/curation/packs.ts)."
        />
      ) : (
        packs.data?.map((pack) => <Pack key={pack.key} pack={pack} />)
      )}
      {!packs.isError && <Compatibility />}
    </>
  )
}

const STATES: Record<
  CuratedReleaseAdminView['state'],
  { label: string; tone: 'neutral' | 'grass' | 'info' | 'danger' | 'outline' }
> = {
  pending: { label: 'Being checked', tone: 'outline' },
  verified: { label: 'Checked, not offered', tone: 'info' },
  published: { label: 'Offered', tone: 'grass' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  refused: { label: 'Refused', tone: 'danger' },
}

function Pack({ pack }: { pack: CuratedPackAdminView }) {
  return (
    <FormSection
      title={pack.name}
      description={`By ${pack.authors} · ${
        pack.distribution === 'mirror'
          ? 'its licences let Cubepals keep its own copy'
          : 'servers fetch it from its authors'
      } · review: ${pack.review}`}
    >
      {pack.held !== null && <Note tone="info">Not to be offered yet: {pack.held}</Note>}
      {pack.releases.length === 0 ? (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Its releases are queued to be checked.
        </p>
      ) : (
        pack.releases.map((release) => <Release key={release.version} pack={pack} release={release} />)
      )}
    </FormSection>
  )
}

function Release({ pack, release }: { pack: CuratedPackAdminView; release: CuratedReleaseAdminView }) {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const queries = useQueryClient()
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.curatedPacks.queryKey() })
  const publish = useMutation(trpc.admin.publishRelease.mutationOptions({ onSuccess: refresh }))
  const retry = useMutation(trpc.admin.retryRelease.mutationOptions({ onSuccess: refresh }))
  const [withdrawing, setWithdrawing] = useState(false)
  const ref = { key: pack.key, version: release.version }
  const state = STATES[release.state]
  const facts = release.facts
  const when = release.publishedAt ?? release.verifiedAt ?? release.withdrawnAt
  return (
    <>
      <FormRow
        label={
          <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
            {release.version} <Badge tone={state.tone}>{state.label}</Badge>
            {release.distribution !== null && (
              <Badge tone="outline">
                {release.distribution === 'mirror' ? 'Cubepals’ copy' : 'From its authors'}
              </Badge>
            )}
          </span>
        }
        description={[
          facts === null
            ? null
            : `Minecraft ${facts.gameVersion} · ${facts.loaderLabel} · ${facts.mods} mods · ${facts.checkedFiles} files checked from ${facts.hosts.join(', ') || 'the pack itself'}`,
          facts === null ? null : licenceLine(facts.licences),
          when === null ? null : whenTaken(when, now),
          `by ${release.changedBy}`,
        ]
          .filter((part) => part !== null)
          .join(' · ')}
        control={
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
            {(release.state === 'verified' || release.state === 'withdrawn') && pack.held === null && (
              <Button
                variant="primary"
                size="sm"
                disabled={publish.isPending}
                onClick={() => publish.mutate(ref)}
              >
                Offer
              </Button>
            )}
            {(release.state === 'verified' || release.state === 'published') && (
              <Button variant="ghost" size="sm" onClick={() => setWithdrawing(true)}>
                Withdraw
              </Button>
            )}
            {release.state === 'refused' && (
              <Button
                variant="outline"
                size="sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate(ref)}
              >
                Check again
              </Button>
            )}
          </div>
        }
      />
      {release.refusal !== null && (
        <Note tone="danger">
          {release.refusal}
          {release.detail !== null && (
            <span className="type-mono-sm" style={{ display: 'block', marginBlockStart: 'var(--space-4)' }}>
              {release.detail}
            </span>
          )}
        </Note>
      )}
      {release.withdrawnReason !== null && release.state === 'withdrawn' && (
        <Note tone="info">Withdrawn: {release.withdrawnReason}</Note>
      )}
      {facts !== null && facts.mirrorBlockers.length > 0 && (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          A copy of Cubepals’ own would need permission for: {facts.mirrorBlockers.join(', ')}.
        </p>
      )}
      {facts !== null && facts.code.length > 0 && (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Runs as code besides its mods: {facts.code.join(', ')}.
        </p>
      )}
      {(publish.isError || retry.isError) && (
        <Note tone="danger">{messageOf(publish.error ?? retry.error)}</Note>
      )}
      {withdrawing && (
        <Withdraw pack={pack} release={release} onClose={() => setWithdrawing(false)} onDone={refresh} />
      )}
    </>
  )
}

/** How many of a release's works carry each kind of licence, as a line: "open 12 · copyleft 16". */
function licenceLine(kinds: Record<string, number>): string {
  const order = ['open', 'copyleft', 'reserved', 'custom', 'noncommercial', 'unknown']
  return order
    .filter((kind) => (kinds[kind] ?? 0) > 0)
    .map((kind) => `${kind} ${kinds[kind]}`)
    .join(' · ')
}

/** Taking a release from new servers, with why: the audit log and the next admin read it. */
function Withdraw({
  pack,
  release,
  onClose,
  onDone,
}: {
  pack: CuratedPackAdminView
  release: CuratedReleaseAdminView
  onClose: () => void
  onDone: () => Promise<unknown>
}) {
  const trpc = useTRPC()
  const [reason, setReason] = useState('')
  const withdraw = useMutation(
    trpc.admin.withdrawRelease.mutationOptions({
      onSuccess: async () => {
        await onDone()
        onClose()
      },
    }),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={`Withdraw ${pack.name} ${release.version}?`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim() === '' || withdraw.isPending}
            onClick={() =>
              withdraw.mutate({ key: pack.key, version: release.version, reason: reason.trim() })
            }
          >
            Withdraw
          </Button>
        </>
      }
    >
      <p className="type-body-sm">
        Nobody new can make a server of it. Servers that play it keep it, and their owners can still go back
        to it.
      </p>
      <TextField
        label="Why"
        maxLength={300}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {withdraw.isError && <Note tone="danger">{messageOf(withdraw.error)}</Note>}
    </Modal>
  )
}
