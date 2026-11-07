// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's resume key (`resumesOn`, `specs.ts`) is made of, kept part by part beside what a
 * boot applied, so a wake that boots where it could have resumed says which part changed since
 * the machine went to sleep: one field of what drift compares (`drift:image`, `drift:env.MOTD`),
 * or what only a start reads (`compat`, `stopCheaters`, `ownFiles`, `identity`).
 *
 * Only says; it decides nothing. The key itself is built as before, from the same parts, so a
 * deploy of this changes no server's key and boots nothing.
 */
import { createHash } from 'node:crypto'
import type { ResumePartsJson } from '@blockly/db'
import type { RuntimeSpec } from '../ports/runtime.ts'

/** A short digest: enough to tell two values of one part apart, and small on every applied row. */
const short = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
    .slice(0, 12)

/**
 * The drift spec (`withoutPlanLimits`) field by field, each variable of its environment on its
 * own, so a changed part names the one field: `image`, `env.MOTD`, `labels`. What its digest
 * leaves out (`specDigest`) is left out here too: its secrets, never kept even as a digest, what a
 * runtime may leave behind when it moves storage, and the key itself.
 */
function driftFields(spec: RuntimeSpec): Record<string, string> {
  const {
    env,
    secrets: _secrets,
    resumesOn: _resumesOn,
    storage: { reconstructible: _reconstructible, ...storage },
    ...rest
  } = spec
  const fields: Record<string, string> = { storage: short(storage) }
  for (const [name, value] of Object.entries(rest)) fields[name] = short(value)
  for (const [name, value] of Object.entries(env)) fields[`env.${name}`] = short(value)
  return fields
}

/** The parts of a resume key, from what `specs.ts` builds the key with; an empty array adds nothing. */
export function resumeParts(parts: {
  drift: RuntimeSpec
  compat: readonly string[]
  stopCheaters: readonly string[]
  ownFiles: readonly string[]
  identity: string
}): ResumePartsJson {
  const of = (values: readonly string[]) => (values.length === 0 ? '' : short(values))
  return {
    drift: driftFields(parts.drift),
    compat: of(parts.compat),
    stopCheaters: of(parts.stopCheaters),
    ownFiles: of(parts.ownFiles),
    identity: short(parts.identity),
  }
}

/**
 * Which parts differ, from what the machine went to sleep on (`before`) to what a start would run
 * now: `drift:<field>` for each field of the drift spec added, gone or changed, and the name of
 * each start-only part. `unknown` where the boot before kept no parts to compare with.
 */
export function changedParts(before: ResumePartsJson | undefined, now: ResumePartsJson): string[] {
  if (before === undefined) return ['unknown']
  const fields = new Set([...Object.keys(before.drift), ...Object.keys(now.drift)])
  const drift = [...fields].filter((field) => before.drift[field] !== now.drift[field]).sort()
  const startOnly = (['compat', 'stopCheaters', 'ownFiles', 'identity'] as const).filter(
    (part) => before[part] !== now[part],
  )
  return [...drift.map((field) => `drift:${field}`), ...startOnly]
}
