// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CurseForge, as far as Blockly may use it (docs/modpack-system.md § CurseForge). Its API terms
 * (14 Aug 2024, §3.1) rule out using the API for any product that competes with CurseForge, and
 * CurseForge sells servers itself since 8 Sep 2026; its site's terms rule out automated
 * downloads. So Blockly reads the links people paste, to tell them where to download a server
 * pack in their own browser, and downloads nothing from CurseForge.
 *
 * `files` is where a written agreement with Overwolf would plug in: a deployment holding one
 * implements it with the API, and a CurseForge export's mods resolve through it. Without one it
 * is null, and an export is refused with the way that works instead.
 */
export interface CurseForge {
  /** What a pasted link points at, and its files page, where a person downloads a server pack. */
  linkOf(url: string): CurseForgeLink | null
  readonly files: CurseForgeFiles | null
}

export interface CurseForgeLink {
  kind: 'modpack' | 'mod' | 'other'
  /** Its name as the link spells it, for a sentence. */
  name: string
  /** The page listing its files, server packs among them. */
  filesPage: string
}

/** Resolving an export's mods by project and file id: needs CurseForge's written permission. */
interface CurseForgeFiles {
  resolve(
    ids: ReadonlyArray<{ projectId: number; fileId: number }>,
  ): Promise<
    ReadonlyMap<string, { url: string | null; fileName: string; sha1: string | null; sizeBytes: number }>
  >
}
