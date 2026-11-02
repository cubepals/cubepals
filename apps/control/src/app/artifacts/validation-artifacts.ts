// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Check-scoped access to exact artifacts through the ordinary signed runtime download route. */
import type { Queryable } from '@blockly/db'
import { validationActive, validationResource } from '../mods/validation-records.ts'

/** Undefined is a normal server; null is a check that may not fetch these bytes. */
export async function validationArtifact(q: Queryable, runtimeId: string, sha512: string) {
  const record = await validationResource(q, runtimeId)
  if (record === null) return undefined
  if (!validationActive(record)) return null
  const mod = [...record.plan.mods, ...record.plan.compat].find((mod) => mod.artifact.sha512 === sha512)
  const artifact =
    mod?.artifact ?? (record.plan.modpack?.artifact.sha512 === sha512 ? record.plan.modpack.artifact : null)
  return artifact === null
    ? null
    : { mod: mod ?? null, artifact, pinnedAt: record.createdAt, refreshedAt: null }
}
