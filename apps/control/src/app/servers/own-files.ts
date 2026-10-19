// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files Cubepals owns on a server, as they are now rather than as they were when the server was
 * made: a template's files go into a server's first revision and stay there, so without this a
 * server made from the Arcade or Duels would keep playing the games as they were on the day it was
 * made. At every start, each set of files Cubepals owns that a server's revision carries is placed
 * as Cubepals has it now: the Arcade's datapack and the maps its signs show, Duels' waiting
 * datapack with its maps' structures and its signs' maps, Duels' arena, kit and permissions, and
 * the moderation tools' files, with the chat filter on or off as its owner left it. A set the revision doesn't carry is never
 * added, so turning the moderation tools off stays off; nothing else on the server changes, its
 * world's blocks included, nor anything its owner added.
 *
 * Servers operators flag official also get files from private configuration (`OfficialFiles`),
 * placed over the revision's files at those paths and never stored in a revision.
 *
 * Only a start places them (`specs.ts`): a running server is never restarted for them. One asleep
 * on older ones boots at its next wake, once, to place them, and wakes as it slept after that. Not
 * what a revision holds, which stays as it was made.
 */
import type { CarriedFile } from '../../domain/revision/carried.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { ARCADE_DATAPACK, ARCADE_FILES } from '../../minecraft/arcade.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { WAITING_DATAPACK, WAITING_FILES } from '../../minecraft/duels-waiting.ts'
import { isModerationFile, moderationFiles } from '../../minecraft/moderation.ts'
import { CHAT_FILTER } from '../moderation/chat-filter.ts'
import { DUELS_STRUCTURES } from '../setups/duels-structures.ts'

/** The chat filter's file, which the moderation tools carry only while the filter is on. */
const CHAT_FILTER_FILE = 'plugins/ChatSentinel/config.yml'

/** One set of files Cubepals owns: which carried files are its, and what it holds now, given what the revision carries. */
interface OwnSet {
  owns: (file: CarriedFile) => boolean
  now: (carried: readonly CarriedFile[]) => readonly CarriedFile[]
}

const inFolder = (folder: string) => (file: CarriedFile) => file.path.startsWith(`${folder}/`)
/** A datapack and the other files that come with it, the maps its signs show. */
const withFiles = (folder: string, files: readonly CarriedFile[]) => {
  const others = new Set(files.filter((file) => !inFolder(folder)(file)).map((file) => file.path))
  return (file: CarriedFile) => inFolder(folder)(file) || others.has(file.path)
}
const DUELS_PATHS = new Set(DUELS_FILES.map((file) => file.path))

const OWN_SETS: readonly OwnSet[] = [
  { owns: withFiles(ARCADE_DATAPACK, ARCADE_FILES), now: () => ARCADE_FILES },
  {
    owns: withFiles(WAITING_DATAPACK, WAITING_FILES),
    now: () => [...WAITING_FILES, ...DUELS_STRUCTURES],
  },
  { owns: (file) => DUELS_PATHS.has(file.path), now: () => DUELS_FILES },
  {
    owns: isModerationFile,
    now: (carried) =>
      moderationFiles(carried.some((file) => file.path === CHAT_FILTER_FILE) ? CHAT_FILTER : null),
  },
]

/** A server as OFFICIAL_SERVER_FILES names it: by its id or its slug. */
interface NamedServer {
  id: string
  slug: string
}

/** Files private configuration places on the servers operators flag official, at every start. */
export interface OfficialFiles {
  /** The files for this server alone: the shared ones, then those named for it. The flag is the caller's to check. */
  forStart(server: NamedServer): readonly CarriedFile[]
  /**
   * The paths a world download leaves out: those of an official server, and of one named in the
   * settings that is no longer official, whose disk still holds what an earlier start placed.
   */
  leftOutOfDownload(server: NamedServer, official: boolean): ReadonlySet<string>
}

/** No files: what a deployment without the configuration does. */
export const noOfficialFiles: OfficialFiles = {
  forStart: () => [],
  leftOutOfDownload: () => new Set(),
}

/** The shared section of OFFICIAL_SERVER_FILES, for every official server. */
const SHARED_FILES = '*'

/**
 * The files OFFICIAL_SERVER_FILES holds: a section for every official server under `*`, and one
 * for each server by its id or slug, a path under /data to its content. A server's own section
 * wins at a path both name, its id's over its slug's.
 */
export const officialFilesOf = (
  sections: Readonly<Record<string, Readonly<Record<string, string>>>>,
): OfficialFiles => {
  const own = (server: NamedServer) => [sections[server.slug], sections[server.id]]
  const forStart = (server: NamedServer): readonly CarriedFile[] => {
    const merged = Object.assign({}, sections[SHARED_FILES], ...own(server))
    return Object.entries<string>(merged).map(([path, content]): CarriedFile => ({ path, content }))
  }
  return {
    forStart,
    leftOutOfDownload: (server, official) =>
      new Set(official || own(server).some(Boolean) ? forStart(server).map((file) => file.path) : []),
  }
}

/**
 * A revision with every set of files Cubepals owns that it carries as Cubepals has it now, and
 * `official` placed over its files at their paths; the rest as it was.
 */
export function withCurrentOwnFiles(
  revision: ServerRevision,
  official: readonly CarriedFile[] = [],
): ServerRevision {
  let files: readonly CarriedFile[] = revision.files
  for (const set of OWN_SETS) {
    const carried = files.filter(set.owns)
    if (carried.length === 0) continue
    files = [...files.filter((file) => !set.owns(file)), ...set.now(carried)]
  }
  if (official.length > 0) {
    const placed = new Set(official.map((file) => file.path))
    files = [...files.filter((file) => !placed.has(file.path)), ...official]
  }
  return files === revision.files ? revision : { ...revision, files: [...files] }
}
