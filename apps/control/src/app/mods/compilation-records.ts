// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** One explanation record for every distinct completed resolution, shared by all ModService callers. */
import { createHash } from 'node:crypto'
import { type Db, schema } from '@blockly/db'
import type { CatalogData, Resolution, ResolveRequest } from '../../domain/mods/resolve.ts'

export async function recordCompilation(
  db: Db,
  request: ResolveRequest,
  result: Resolution,
  data: CatalogData,
) {
  if (result.kind === 'need') return
  const evidence = {
    target: request.target,
    requested: request.wanted,
    selected:
      result.kind === 'resolved'
        ? result.mods.map((mod) => ({ name: mod.name, sha512: mod.artifact.sha512 }))
        : [],
    omitted: result.kind === 'resolved' ? (result.decisions ?? []) : [],
    conflicts: result.kind === 'conflicts' ? result.conflicts : [],
    unknown: [...(data.needs ?? [])].flatMap(([id, needs]) => (needs == null ? [id] : [])).sort(),
  }
  const key = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
  await db.insert(schema.modCompilations).values({ key, evidence }).onConflictDoNothing()
}
