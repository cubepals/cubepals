// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Versions Cubepals ran itself on a Minecraft release and server type their catalog doesn't list
 * them for. Catalogs trail what really runs: BSkyBlock lists nothing past 26.1.1, yet it makes its
 * worlds on Paper 26.2. This file is the review, as `packs.ts` is for packs: a record is here only
 * after someone booted that exact version on that target with Cubepals' own build, and wrote down
 * what showed it working.
 *
 * A record covers one version id, never "any version of this project": a newer release isn't
 * covered until someone tests it. Resolution (`domain/mods/resolve.ts`) counts a record as a fit
 * only where nothing the catalog lists fits, so it never changes a set that resolved before.
 *
 * Adding one is a change to this file, reviewed like any other. Players never see a record; the
 * admins' page shows each with when it was tested (`templates-view.ts`).
 */
import type { Loader } from '../../domain/revision/revision.ts'

/** One version, booted on one release and server type, and what showed it working. */
export interface TestedVersion {
  catalog: string
  projectId: string
  /** The exact version that ran; no other version of the project is covered. */
  versionId: string
  /** The project and version as its authors name them, for the admins' page. */
  name: string
  versionLabel: string
  /** Where it ran. */
  gameVersion: string
  loader: Loader
  /** The server build it ran on, as Cubepals pins it. */
  build: string
  /** The day it was tested, as `YYYY-MM-DD`. */
  testedOn: string
  testedBy: string
  /** What showed it working: a log line, or where the boot log is written up. */
  evidence: string
}

/** The boot test of cubepals/cubepals#10, on the builds Cubepals pins for Paper. */
const BENTOBOX_BOOT = {
  catalog: 'modrinth',
  loader: 'paper',
  testedOn: '2026-10-09',
  testedBy: 'v0id-user, through a Claude Code session',
} as const

/** BentoBox's addons from cubepals/cubepals#10, each on both releases it booted on. */
const BENTOBOX_ADDONS = [
  { projectId: 'ASGn77Qd', versionId: '3kLVOQCM', name: 'BSkyBlock', versionLabel: '1.20.0' },
  { projectId: 'qq7CK8U4', versionId: 'SO3SQFxw', name: 'AOneBlock', versionLabel: '1.28.0' },
  { projectId: 'OWzL9XSJ', versionId: '55hL6XOg', name: 'Level', versionLabel: '2.29.0' },
  { projectId: 'P08aFayx', versionId: '4yAHWSTz', name: 'Warps', versionLabel: '1.19.1' },
] as const

const BENTOBOX_BUILDS = [
  { gameVersion: '26.2', build: 'Paper 26.2-132' },
  { gameVersion: '26.1.2', build: 'Paper 26.1.2-74' },
] as const

export const TESTED: readonly TestedVersion[] = BENTOBOX_BUILDS.flatMap(({ gameVersion, build }) =>
  BENTOBOX_ADDONS.map((addon) => ({
    ...BENTOBOX_BOOT,
    ...addon,
    gameVersion,
    build,
    evidence: `cubepals/cubepals#10: with BentoBox 3.23.3 and the addons in plugins/BentoBox/addons, "[BentoBox] Enabling ${addon.name} (${addon.versionLabel})..." and "Added world BSkyBlock (NORMAL)", "Added world OneBlock (NORMAL)"; 0 errors in the log.`,
  })),
)

/** The records for one release and server type: what resolving for it may count as fitting. */
export const testedOn = (
  records: readonly TestedVersion[],
  target: { gameVersion: string; loader: Loader },
): TestedVersion[] =>
  records.filter((record) => record.gameVersion === target.gameVersion && record.loader === target.loader)
