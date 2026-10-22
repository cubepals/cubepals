// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deletes that can be undone: shown as gone at once, sent when the time to undo ends. Only the
 * waiting lives here; what a page shows for one, and the call that deletes, are the page's.
 */

import { SECOND_MS } from '@blockly/contracts/durations'

/** How long a deleted thing can be brought back before it is deleted for good. */
export const UNDO_MS = 8 * SECOND_MS

/**
 * Deletes that wait to be sent. A delete is shown at once and sent when `UNDO_MS` ends, so an
 * undo costs nothing: the API never heard of it. Leaving the page sends what is waiting right
 * away, marked as leaving so the request can outlive the page. A delete that failed is kept
 * with why, for the line that puts the thing back.
 *
 * Plain state with a subscription, for `useSyncExternalStore`: it lives outside any component, so
 * a delete goes on when the popover that started it closes.
 */
export class UndoableDeletes {
  private readonly waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; send: Send }>()
  /** Moved here from `waiting` as the call goes out, so a second send finds nothing to send. */
  private readonly sending = new Set<string>()
  private readonly refused = new Map<string, unknown>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  /** Hides `id` and sends its delete once the time to undo is up. */
  start(id: string, send: Send): void {
    this.cancel(id)
    this.refused.delete(id)
    this.waiting.set(id, { timer: setTimeout(() => void this.send(id, false), UNDO_MS), send })
    this.changed()
  }

  /** Brings `id` back, as it was: nothing was sent. */
  undo(id: string): void {
    this.cancel(id)
    this.changed()
  }

  /** Sends every delete waiting now, for a page that is being left. */
  leave(): void {
    for (const id of [...this.waiting.keys()]) void this.send(id, true)
  }

  isWaiting(id: string): boolean {
    return this.waiting.has(id) || this.sending.has(id)
  }

  /** Why `id` could not be deleted, as thrown, until the next try. */
  refusal(id: string): { error: unknown } | undefined {
    return this.refused.has(id) ? { error: this.refused.get(id) } : undefined
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes whenever what is waiting or refused does. */
  snapshot = (): number => this.version

  private cancel(id: string): void {
    const entry = this.waiting.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.waiting.delete(id)
  }

  private async send(id: string, leaving: boolean): Promise<void> {
    const entry = this.waiting.get(id)
    if (entry === undefined) return
    this.cancel(id)
    this.sending.add(id)
    try {
      await entry.send(leaving)
    } catch (error) {
      this.refused.set(id, error)
    } finally {
      this.sending.delete(id)
      this.changed()
    }
  }

  private changed(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

/** Sends the delete. `leaving` is true when the page is going, so the request must outlive it. */
type Send = (leaving: boolean) => Promise<unknown>
