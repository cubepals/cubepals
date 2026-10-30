// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sending a file straight to the store: its fingerprint first, so the control plane can check
 * the bytes it gets are the ones chosen, then a PUT to the link it signed, with progress, that the
 * player can stop.
 */

/** The file's SHA-512, in hex, as the control plane checks it. */
export async function sha512Of(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-512', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether a failure is the player stopping the upload, which needs no message. */
export const isStopped = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

/**
 * Puts the file at a presigned link; `onProgress` hears how many bytes have gone, and `signal`
 * stops it, failing with an error `isStopped` knows.
 */
export function putFile(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(new DOMException('The upload was stopped.', 'AbortError'))
    if (signal?.aborted) return stopped()
    // fetch can't report upload progress; XMLHttpRequest can.
    const request = new XMLHttpRequest()
    signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.onabort = stopped
    request.open('PUT', url)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`The upload was refused (${request.status}). Try again.`))
    request.onerror = () => reject(new Error('The upload stopped. Check your connection and try again.'))
    request.send(file)
  })
}
