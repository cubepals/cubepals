// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A request whose connection was dropped before it was answered, made once more. Staging's API
 * runs on machines that stop when idle and wake on a request, and Fly's proxy can reset a request
 * that arrives as one wakes: a nightly's check lost one sign-up of six that way, with
 * `ECONNRESET: The socket connection was closed unexpectedly`, while the five beside it went
 * through. Only for work that is safe to make again, such as signing up under a new address.
 *
 * Not for an answer that came back, whatever it says: only a connection that gave none.
 */

/** Whether `error` is a connection that closed with no answer, as Bun's `fetch` and Node's sockets say it. */
export function droppedConnection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const said = error instanceof Error ? error.message : String(error)
  return code === 'ECONNRESET' || /ECONNRESET|socket connection was closed unexpectedly/i.test(said)
}

/** `make`'s answer; made once more where its connection was dropped, and no more than that. */
export async function onceMoreIfDropped<T>(make: () => Promise<T>): Promise<T> {
  try {
    return await make()
  } catch (error) {
    if (!droppedConnection(error)) throw error
    return make()
  }
}
