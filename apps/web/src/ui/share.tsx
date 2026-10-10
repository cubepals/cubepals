// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ShareView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Share2 } from 'lucide-react'
import { useState } from 'react'
import { messageOf, useTRPC } from '../lib/api'
import { said, useOutcome } from '../lib/outcome'
import { presentIneligible } from '../lib/present'
import { Button } from './Button'
import { Toggle } from './fields'
import { ICON } from './index'
import { CopyField, Modal } from './interactive'
import { Note, Skeleton } from './surfaces'

/**
 * One Share action, wherever a server is (§15.6). Everything about giving the server to someone
 * else lives behind it: the invite link friends open, the address to paste into Minecraft, the
 * switch that makes a page anyone can find, and whether others may make one like it. The one
 * other place to copy the invite link is the Players page, where an owner looks for their friends.
 */
export function ShareButton({ serverId, name }: { serverId: string; name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<Share2 {...ICON} aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Share
      </Button>
      {open && <ShareSheet serverId={serverId} name={name} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareSheet({ serverId, name, onClose }: { serverId: string; name: string; onClose: () => void }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const share = useQuery(trpc.sharing.own.queryOptions({ serverId }))
  const put = (next: ShareView) => queries.setQueryData(trpc.sharing.own.queryKey({ serverId }), next)
  const setPublic = useMutation(trpc.listings.setPublic.mutationOptions({ onSuccess: put }))
  const setCopyable = useMutation(trpc.listings.setCopyable.mutationOptions({ onSuccess: put }))
  const renewed = useOutcome(undefined)
  const reset = useMutation(
    trpc.servers.resetInvite.mutationOptions({
      onSuccess: (next) => {
        put(next)
        renewed.settled()
      },
      onError: () => renewed.refused(),
    }),
  )
  const view = share.data

  return (
    <Modal
      open
      onClose={onClose}
      title={`Share ${name}`}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {share.isPending && <Skeleton width="100%" height={120} />}
      {share.isError && <Note tone="danger">{messageOf(share.error)}</Note>}
      {view && (
        <div className="bk-stack" style={{ gap: 'var(--space-20)' }}>
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="bk-field__label">Invite a friend</span>
            <CopyField value={view.inviteUrl} label="Copy invite" />
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              {view.whitelistOnly
                ? 'It shows them what to install, and adds them to the players who may join.'
                : 'It shows them what to install and where to paste the address.'}{' '}
              <Button
                variant="ghost"
                size="sm"
                {...said(renewed, { done: 'New link made', failed: 'Didn’t make one' })}
                disabled={reset.isPending}
                onClick={() => reset.mutate({ serverId })}
              >
                {reset.isPending ? 'Making a new link…' : 'Make a new link'}
              </Button>
            </p>
          </div>

          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="bk-field__label">Or just the address</span>
            <CopyField value={view.joinAddress} />
          </div>

          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <Toggle
              label="Anyone can find it"
              checked={view.public}
              disabled={setPublic.isPending}
              onChange={(next) => setPublic.mutate({ serverId, public: next })}
            />
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              Gives it a page anyone can open, and puts it in Cubepals’ directory.
            </p>
            {view.public && <CopyField value={view.pageUrl} label="Copy page" />}
            {view.public && !view.listed && (
              <Note tone="info">
                {view.moderation === 'removed'
                  ? `Cubepals removed this from the directory${view.moderationNote ? `: ${view.moderationNote}` : '.'}`
                  : view.directoryPaused
                    ? 'Cubepals paused the directory for a moment; the page still works.'
                    : view.reasons.length > 0
                      ? presentIneligible(view.reasons[0] ?? { code: 'unknown' })
                      : 'It joins the directory shortly.'}
              </Note>
            )}
          </div>

          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <Toggle
              label="Others can make one like it"
              checked={view.copying.on}
              disabled={view.copying.locked || setCopyable.isPending}
              onChange={(next) => setCopyable.mutate({ serverId, copyable: next })}
            />
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              {view.copying.why ??
                'Its page offers a server set up the same way, with a world of their own. Yours stays yours.'}
            </p>
          </div>
          {(setPublic.error ?? setCopyable.error ?? reset.error) && (
            <Note tone="danger">{messageOf(setPublic.error ?? setCopyable.error ?? reset.error)}</Note>
          )}
        </div>
      )}
    </Modal>
  )
}
