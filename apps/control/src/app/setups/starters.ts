// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a template's world can start: one that starts on an archive (`minecraft/starter.ts`)
 * can only once the archive is in this deployment's archive store, which the store itself says,
 * not a setting. Until then the template isn't offered, so nobody makes a server whose first
 * start would stop. A template that generates its world is always ready. Not the archive's
 * upload (`scripts/arcade-upload.ts`) or how a server fetches it (`artifacts/service.ts`).
 */
import { starterOf } from '../../minecraft/starter.ts'
import type { ArchiveStore } from '../ports/optional.ts'

export class StarterWorlds {
  readonly #store: ArchiveStore | null
  /**
   * The archives found in the store. One found stays found: an archive is never taken out while a
   * template names it. One missing is asked about again next time, so the template is offered as
   * soon as the archive is put there.
   */
  readonly #found = new Set<string>()

  constructor(store: ArchiveStore | null) {
    this.#store = store
  }

  /** Whether a world of this type can start here: it generates, or its archive is stored. */
  async ready(levelType: string): Promise<boolean> {
    const starter = starterOf(levelType)
    if (starter === null) return true
    if (starter.ref.kind !== 'stored' || this.#store === null) return false
    const { key } = starter.ref
    if (this.#found.has(key)) return true
    if ((await this.#store.head(key).catch(() => null)) === null) return false
    this.#found.add(key)
    return true
  }
}
