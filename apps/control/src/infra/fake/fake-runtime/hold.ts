// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holds the next few calls of one verb until a test lets them go, as a provider call that hangs
 * does. It does not decide where in a verb the hold sits, or which calls reach it: the verb does
 * (`stop`, `exportSnapshot` and `release` in `fake-runtime.ts`).
 */

export class Hold {
  #count = 0
  #released: Promise<void> = Promise.resolve()

  /**
   * The next `count` calls wait until the returned function lets them all go at once. Asked again,
   * it counts afresh; calls already waiting stay on the release they were held under.
   */
  hold(count: number): () => void {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#count = count
    this.#released = promise
    return () => resolve()
  }

  /**
   * What this call waits on when it is one of those held, or null when it isn't: the caller awaits
   * only a hold, so a call nobody holds goes on without yielding.
   */
  take(): Promise<void> | null {
    if (this.#count <= 0) return null
    this.#count--
    return this.#released
  }
}
