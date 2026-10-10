// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads and writes the strings a fake runtime issues as handles: `<provider>:v1:` for a server's
 * machine, `<provider>-snap:v1:` for a snapshot. Only the fake reads them; everyone else stores the
 * string. It does not decide whether a handle still names anything, or belongs to this
 * deployment: the runtime, which holds the boxes and the deployment id, does (`fake-runtime.ts`).
 */

import { z } from 'zod'
import type { RuntimeHandle, SnapshotHandle } from '../../../app/ports/runtime.ts'

const Handle = z.object({
  deployment: z.string(),
  key: z.string(),
  generation: z.number().int(),
  address: z.number().int().optional(),
})
/** What a handle names: a server's box at one generation, and where it was, with moving addresses. */
export type FakeRef = z.infer<typeof Handle>

const Snapshot = z.object({ key: z.string(), id: z.string() })
/** What a snapshot handle names: one snapshot of a server's box. */
export type SnapshotRef = z.infer<typeof Snapshot>

const pack = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const unpack = (text: string): unknown => JSON.parse(Buffer.from(text, 'base64url').toString())

/** The handles of one fake provider, under prefixes made of its id. */
export class FakeHandles {
  readonly #provider: string
  readonly #handlePrefix: string
  readonly #snapshotPrefix: string

  constructor(provider: string) {
    this.#provider = provider
    this.#handlePrefix = `${provider}:v1:`
    this.#snapshotPrefix = `${provider}-snap:v1:`
  }

  owns(handle: string): boolean {
    return handle.startsWith(this.#handlePrefix)
  }

  ownsSnapshot(snapshot: string): boolean {
    return snapshot.startsWith(this.#snapshotPrefix)
  }

  issue(ref: FakeRef): RuntimeHandle {
    return `${this.#handlePrefix}${pack(ref)}` as RuntimeHandle
  }

  read(handle: string): FakeRef {
    if (!handle.startsWith(this.#handlePrefix))
      throw new Error(`This handle was not issued by the ${this.#provider} runtime`)
    return Handle.parse(unpack(handle.slice(this.#handlePrefix.length)))
  }

  issueSnapshot(ref: SnapshotRef): SnapshotHandle {
    return `${this.#snapshotPrefix}${pack(ref)}` as SnapshotHandle
  }

  readSnapshot(snapshot: string): SnapshotRef {
    if (!snapshot.startsWith(this.#snapshotPrefix))
      throw new Error(`This snapshot was not taken by the ${this.#provider} runtime`)
    return Snapshot.parse(unpack(snapshot.slice(this.#snapshotPrefix.length)))
  }
}

/** The server key inside a handle any fake issued, for the fake workload's logs. */
export const fakeHandleKey = (handle: RuntimeHandle): string => {
  const payload = /^[a-z0-9-]+:v1:(.+)$/.exec(handle)?.[1]
  if (payload === undefined) throw new Error('This handle was not issued by a fake runtime')
  return Handle.parse(unpack(payload)).key
}
