// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import {
  ActionButton,
  Button,
  DangerZone,
  ICON,
  LoadFailed,
  Modal,
  Note,
  PageSkeleton,
  Skeleton,
  TextField,
} from '../../../../../ui'
import { useServer } from '../use-server'
import { Advanced } from './advanced'
import { GameSettings } from './game'
import { History } from './history'
import { Identity } from './identity'
import { Location } from './location'
import { ChangeState } from './shared'
import { SizeSettings, VersionSettings } from './version'

export default function SettingsPage() {
  const server = useServer()
  const trpc = useTRPC()
  const options = useQuery(trpc.servers.settingsOptions.queryOptions({ serverId: server.id }))
  if (server.isPending) return <PageSkeleton title="Settings" sections={[2, 4]} />
  if (server.isError) return <LoadFailed error={messageOf(server.error)} onRetry={() => server.refetch()} />
  const view = server.data

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Settings
      </h1>

      <ChangeState view={view} />
      {view.movesToSize && (
        <Note tone="info">
          This server is on a size your plan no longer offers. It keeps running as it is; your next change
          here moves it to {view.movesToSize.label}.
        </Note>
      )}
      <Identity view={view} />
      {options.isError ? (
        <Note tone="danger">{messageOf(options.error)}</Note>
      ) : options.isPending ? (
        <Skeleton width="100%" height={240} />
      ) : (
        <>
          <GameSettings view={view} options={options.data} />
          <VersionSettings view={view} options={options.data} />
          <SizeSettings view={view} options={options.data} />
        </>
      )}

      {options.data && <Location view={view} options={options.data} />}

      <History view={view} />
      <Advanced view={view} options={options.data} />
      <DeleteServer serverId={view.id} name={view.name} />
    </>
  )
}

function DeleteServer({ serverId, name }: { serverId: string; name: string }) {
  const trpc = useTRPC()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const capabilities = useQuery(trpc.platform.capabilities.queryOptions())
  const overview = useQuery(trpc.account.overview.queryOptions())
  const days = overview.data?.entitlements.trashRetentionDays
  const remove = useMutation(
    trpc.servers.delete.mutationOptions({
      onSuccess: () => router.push('/servers/trash'),
    }),
  )
  return (
    <>
      <DangerZone
        items={[
          {
            label: 'Delete server',
            description: `The world and everything in it goes away. You can restore it from the trash for ${days === undefined ? 'a few days' : `${days} ${days === 1 ? 'day' : 'days'}`}.`,
            action: (
              <Button variant="danger" onClick={() => setOpen(true)}>
                Delete server
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setTyped('')
        }}
        title={
          <>
            Delete <strong>{name}</strong>?
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ActionButton
              phases={{
                remove: {
                  icon: <Trash2 {...ICON} aria-hidden />,
                  label: 'Delete server',
                  working: 'Deleting it',
                  failed: 'Didn’t delete',
                  variant: 'danger',
                  run: () => remove.mutateAsync({ serverId, confirmName: typed }),
                },
              }}
              now="remove"
              disabled={typed.trim() !== name.trim()}
            />
          </>
        }
      >
        <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
          <p>
            The server stops and its address stops working. It waits in your trash, where you can restore it
            for {days === undefined ? 'a few days' : `${days} ${days === 1 ? 'day' : 'days'}`}; then it is
            gone for good.
          </p>
          {capabilities.data && !capabilities.data.archives && (
            <Note tone="info">
              Its backups go with it then: this Cubepals deployment keeps no copy of a server after it is
              purged.
            </Note>
          )}
          <TextField
            label={`Type ${name} to confirm`}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
        </div>
      </Modal>
    </>
  )
}
