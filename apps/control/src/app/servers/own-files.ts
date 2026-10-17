// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files Cubepals owns on a server, as they are now rather than as they were when the server was
 * made: a template's files go into a server's first revision and stay there, so without this a
 * server made from the Arcade or Duels would keep playing the games as they were on the day it was
 * made. At every start, each set of files Cubepals owns that a server's revision carries is placed
 * as Cubepals has it now: the Arcade's datapack, Duels' waiting datapack, Duels' arena, kit and
 * permissions, and the moderation tools' files, with the chat filter on or off as its owner left
 * it. A set the revision doesn't carry is never added, so turning the moderation tools off stays
 * off; nothing else on the server changes, its world included, nor anything its owner added.
 *
 * Only a start places them (`specs.ts`): a running server is never restarted for them, and one
 * asleep wakes as it went to sleep. Not what a revision holds, which stays as it was made.
 */
import type { CarriedFile } from '../../domain/revision/carried.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { ARCADE_DATAPACK, ARCADE_FILES } from '../../minecraft/arcade.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { WAITING_DATAPACK, WAITING_FILES } from '../../minecraft/duels-waiting.ts'
import { isModerationFile, moderationFiles } from '../../minecraft/moderation.ts'
import { CHAT_FILTER } from '../moderation/chat-filter.ts'

/** The chat filter's file, which the moderation tools carry only while the filter is on. */
const CHAT_FILTER_FILE = 'plugins/ChatSentinel/config.yml'

/** One set of files Cubepals owns: which carried files are its, and what it holds now, given what the revision carries. */
interface OwnSet {
  owns: (file: CarriedFile) => boolean
  now: (carried: readonly CarriedFile[]) => readonly CarriedFile[]
}

const inFolder = (folder: string) => (file: CarriedFile) => file.path.startsWith(`${folder}/`)
const DUELS_PATHS = new Set(DUELS_FILES.map((file) => file.path))

const OWN_SETS: readonly OwnSet[] = [
  { owns: inFolder(ARCADE_DATAPACK), now: () => ARCADE_FILES },
  { owns: inFolder(WAITING_DATAPACK), now: () => WAITING_FILES },
  { owns: (file) => DUELS_PATHS.has(file.path), now: () => DUELS_FILES },
  {
    owns: isModerationFile,
    now: (carried) =>
      moderationFiles(carried.some((file) => file.path === CHAT_FILTER_FILE) ? CHAT_FILTER : null),
  },
]

/** A revision with every set of files Cubepals owns that it carries as Cubepals has it now; the rest as it was. */
export function withCurrentOwnFiles(revision: ServerRevision): ServerRevision {
  let files: readonly CarriedFile[] = revision.files
  for (const set of OWN_SETS) {
    const carried = files.filter(set.owns)
    if (carried.length === 0) continue
    files = [...files.filter((file) => !set.owns(file)), ...set.now(carried)]
  }
  return files === revision.files ? revision : { ...revision, files: [...files] }
}
