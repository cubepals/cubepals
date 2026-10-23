// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each template's setup as `SetupService.resolve` works it out, kept for the create page's
 * previews, so choosing what to play doesn't ask Modrinth and Hangar again on every click.
 *
 * - **Key:** the template's key and the release asked for, or none for the newest it runs on.
 *   Nothing else goes into a template's resolution: not who asks, not the party size and not the
 *   plan, which the preview judges afresh on every ask.
 * - **Kept:** a resolved setup, and a refusal (`mods_conflict`, `invalid_choice`), which is as much
 *   an answer. Anything else, such as a catalog that didn't answer, is dropped as soon as it fails
 *   and asked again next time. Asks while one is being worked out wait for that one.
 * - **Dropped:** `TEMPLATE_KEPT_MS` after it was asked, and at once when it failed another way. A
 *   release Blockly doesn't offer is never kept, so made-up versions can't fill it.
 *
 * A pack or a copy, anything but a template, is resolved afresh on every ask, for whoever asks.
 * Not for making a server: creating resolves afresh, so it pins the builds the catalog lists then.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { offeredVersions } from '../../minecraft/versions.ts'
import type { Actor } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { ResolvedSetup, SetupService, SetupSource } from './service.ts'

/** How long a template's resolution is kept: a mod's newest build moves rarely, and slowly. */
export const TEMPLATE_KEPT_MS = 10 * MINUTE_MS

export class ResolvedTemplates {
  readonly #setups: Pick<SetupService, 'resolve'>
  readonly #now: () => number
  readonly #keptMs: number
  readonly #kept = new Map<string, { at: number; answer: Promise<ResolvedSetup> }>()

  constructor(
    setups: Pick<SetupService, 'resolve'>,
    keptMs = TEMPLATE_KEPT_MS,
    now: () => number = Date.now,
  ) {
    this.#setups = setups
    this.#keptMs = keptMs
    this.#now = now
  }

  /** `SetupService.resolve`, answered from what is kept for a template. */
  resolve(source: SetupSource, viewer: Actor | null): Promise<ResolvedSetup> {
    if (source.kind !== 'template') return this.#setups.resolve(source, viewer)
    const { gameVersion } = source
    if (gameVersion !== undefined && !offeredVersions().some((offered) => offered.id === gameVersion))
      return this.#setups.resolve(source, null)
    const key = `${source.key}@${gameVersion ?? ''}`
    const now = this.#now()
    const kept = this.#kept.get(key)
    if (kept !== undefined && now - kept.at < this.#keptMs) return kept.answer
    // A template is the same setup for everyone, so nobody's account is asked about.
    const entry = { at: now, answer: this.#setups.resolve(source, null) }
    this.#kept.set(key, entry)
    entry.answer.catch((error: unknown) => {
      if (refusal(error)) return
      if (this.#kept.get(key) === entry) this.#kept.delete(key)
    })
    return entry.answer
  }
}

const refusal = (error: unknown) =>
  error instanceof AppError && (error.code === 'mods_conflict' || error.code === 'invalid_choice')
