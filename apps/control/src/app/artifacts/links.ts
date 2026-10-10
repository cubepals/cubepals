// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModArtifact } from '../../domain/mods/artifact.ts'
import { diskName } from '../../minecraft/jars.ts'
import { deriveServerSecret, type SecretKeyring } from '../secrets.ts'

/**
 * Stable links to a revision's artifacts, as game runtimes fetch them (§15.2). No expiry and no
 * per-build nonce: the same revision always yields the same spec, and boots never depend on a
 * presigned URL still being valid.
 */
export class ArtifactLinks {
  readonly #base: string
  readonly #secrets: SecretKeyring

  constructor(runtimeFacingUrl: string, secrets: SecretKeyring) {
    this.#base = runtimeFacingUrl.replace(/\/$/, '')
    this.#secrets = secrets
  }

  /**
   * Blockly's own icon, by key. It is the same picture for every server that picks it, so the
   * link carries no token and the image may cache it.
   */
  icon(key: string): string {
    return `${this.#base}/runtime/v1/icons/${encodeURIComponent(key)}.png`
  }

  /** Links signed with the current key; links from earlier keys still work during a rotation. */
  forServer(serverId: string): (artifact: ModArtifact) => string {
    const token = deriveServerSecret(this.#secrets.current.key, serverId, 'artifacts')
    return (artifact) =>
      `${this.#base}/runtime/v1/artifacts/${serverId}/${artifact.sha512}/${encodeURIComponent(diskName(artifact))}?t=${token}`
  }
}
