'use client'

/**
 * Downloading an archive's world: asked for, then, while Cubepals makes it, waited on with the
 * button saying so, and opened once it's ready. A small world is ready by the time the ask
 * answers. Gives each Download button its props, and the note for a download that didn't work.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { Note } from '../../../../../ui'

export function useWorldDownload(serverId: string): {
  button: (backupId: string) => { disabled: boolean; busy?: string; onClick: () => void }
  note: ReactNode
} {
  const trpc = useTRPC()
  const [waiting, setWaiting] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const ask = useMutation(
    trpc.backups.download.mutationOptions({
      onSuccess: (state, { backupId }) => {
        // The link answers with the file as an attachment: the page stays where it is.
        if (state.status === 'ready') window.location.assign(state.url)
        else if (state.status === 'making') setWaiting(backupId)
        else setFailed(state.message)
      },
    }),
  )
  const made = useQuery({
    ...trpc.backups.downloadState.queryOptions({ serverId, backupId: waiting ?? '' }),
    enabled: waiting !== null,
    refetchInterval: 2_000,
    // An answer from an earlier wait is never this one's.
    gcTime: 0,
  })
  useEffect(() => {
    const state = made.data
    if (waiting === null || state === undefined || state.status === 'making') return
    setWaiting(null)
    if (state.status === 'ready') window.location.assign(state.url)
    else setFailed(state.message)
  }, [made.data, waiting])

  const message = ask.error ? messageOf(ask.error) : failed
  return {
    button: (backupId) => ({
      disabled: ask.isPending || waiting !== null,
      ...(waiting === backupId || (ask.isPending && ask.variables?.backupId === backupId)
        ? { busy: 'Getting it ready' }
        : {}),
      onClick: () => {
        setFailed(null)
        ask.mutate({ serverId, backupId })
      },
    }),
    note: message && <Note tone="danger">{message}</Note>,
  }
}
