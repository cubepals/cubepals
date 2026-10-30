// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A file sent to be read on a worker, as the pages that take a pack or a world send one: begun,
 * put straight to the store with its progress (`upload.ts`), which the player can stop, finished,
 * and the import it became handed back to watch. What the import says, and what the page makes of it, is the page's.
 */
import { useEffect, useRef, useState } from 'react'
import { messageOf } from './api'
import { isStopped, putFile } from './upload'

/** How the control plane takes the file: where to put it, then that it arrived. */
export interface ImportSending {
  begin(file: { fileName: string; sizeBytes: number }): Promise<{
    ticket: string
    url: string
    headers: Record<string, string>
  }>
  finish(ticket: string): Promise<{ importId: string }>
}

export function useSentImport(sending: ImportSending, onStart?: () => void) {
  const [progress, setProgress] = useState<{ name: string; sent: number; total: number } | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const stopping = useRef<AbortController | null>(null)
  const send = async (file: File) => {
    onStart?.()
    setFailure(null)
    setImportId(null)
    const controller = new AbortController()
    stopping.current = controller
    try {
      setProgress({ name: file.name, sent: 0, total: file.size })
      const start = await sending.begin({ fileName: file.name, sizeBytes: file.size })
      await putFile(
        start.url,
        start.headers,
        file,
        (sent) => setProgress({ name: file.name, sent, total: file.size }),
        controller.signal,
      )
      setImportId((await sending.finish(start.ticket)).importId)
    } catch (error) {
      if (!isStopped(error)) setFailure(messageOf(error))
    } finally {
      stopping.current = null
      setProgress(null)
    }
  }
  /** Stops the file going up; nothing is said, since the player asked. */
  const stop = () => stopping.current?.abort()
  return { progress, importId, failure, send, stop }
}

/**
 * An import read, handed to `onReady` once. The pages pass a new `onReady` on every render, and
 * handing it over again would reopen a question someone just answered or cancelled.
 */
export function useHandedOnce<Read extends { status: string; importId: string }>(
  read: Read | undefined,
  onReady: (read: Extract<Read, { status: 'ready' }>) => void,
): void {
  const [handed, setHanded] = useState<string | null>(null)
  useEffect(() => {
    if (read?.status !== 'ready' || read.importId === handed) return
    setHanded(read.importId)
    onReady(read as Extract<Read, { status: 'ready' }>)
  }, [read, onReady, handed])
}
