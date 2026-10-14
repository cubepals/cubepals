// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Db } from '@blockly/db'
import { loadOwnIcon } from './persistence.ts'

/**
 * The pictures owners gave their servers, as pages draw them. A server's runtime fetches its own
 * through `ArtifactService.ownIcon`, with its token, the same as its jars (§15.2).
 */
export class ServerIcons {
  readonly #db: Db

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  /**
   * A page drawing a server's picture. The address names the server and the picture's hash, so it
   * is known only to whoever was shown it, and never finds another server's.
   */
  forPage(serverId: string, sha256: string): Promise<Buffer | null> {
    return loadOwnIcon(this.#db, serverId, sha256)
  }
}
