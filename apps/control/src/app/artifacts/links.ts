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

  /**
   * The picture an owner gave their server, by its hash. It is theirs alone, so the link carries
   * the server's own token, as its jars' do.
   */
  ownIcon(serverId: string, sha256: string): string {
    const token = deriveServerSecret(this.#secrets.current.key, serverId, 'artifacts')
    return `${this.#base}/runtime/v1/icons/${serverId}/${sha256}.png?t=${token}`
  }

  /** Where the server's join reporter posts its players' joins, with its own token as its jars have. */
  joinsReport(serverId: string): string {
    const token = deriveServerSecret(this.#secrets.current.key, serverId, 'artifacts')
    return `${this.#base}/runtime/v1/servers/${serverId}/joins?t=${token}`
  }

  /** Links signed with the current key; links from earlier keys still work during a rotation. */
  forServer(serverId: string): (artifact: ModArtifact) => string {
    const token = deriveServerSecret(this.#secrets.current.key, serverId, 'artifacts')
    return (artifact) =>
      `${this.#base}/runtime/v1/artifacts/${serverId}/${artifact.sha512}/${encodeURIComponent(diskName(artifact))}?t=${token}`
  }
}
