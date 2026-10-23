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
 * Not for making a server: creating resolves afresh, so it pins the builds the catalog lists then.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { offeredVersions } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import type { ResolvedSetup, SetupSource } from './service.ts'

type TemplateSource = SetupSource & { kind: 'template' }

/** How long a template's resolution is kept: a mod's newest build moves rarely, and slowly. */
export const TEMPLATE_KEPT_MS = 10 * MINUTE_MS

export class ResolvedTemplates {
  readonly #resolve: (source: TemplateSource) => Promise<ResolvedSetup>
  readonly #now: () => number
  readonly #keptMs: number
  readonly #kept = new Map<string, { at: number; answer: Promise<ResolvedSetup> }>()

  constructor(
    resolve: (source: TemplateSource) => Promise<ResolvedSetup>,
    options: { now?: () => number; keptMs?: number } = {},
  ) {
    this.#resolve = resolve
    this.#now = options.now ?? Date.now
    this.#keptMs = options.keptMs ?? TEMPLATE_KEPT_MS
  }

  get(source: TemplateSource): Promise<ResolvedSetup> {
    const { gameVersion } = source
    if (gameVersion !== undefined && !offeredVersions().some((offered) => offered.id === gameVersion))
      return this.#resolve(source)
    const key = `${source.key}@${gameVersion ?? ''}`
    const now = this.#now()
    const kept = this.#kept.get(key)
    if (kept !== undefined && now - kept.at < this.#keptMs) return kept.answer
    const entry = { at: now, answer: this.#resolve(source) }
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
