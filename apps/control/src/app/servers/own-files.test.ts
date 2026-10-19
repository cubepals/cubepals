// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files Cubepals owns, as a start places them: each set a revision carries as Cubepals has it
 * now, never one it doesn't carry, and nothing else of the revision.
 */
import { describe, expect, test } from 'bun:test'
import { type CarriedFile, RUNNING_LEVEL } from '../../domain/revision/carried.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { ARCADE_DATAPACK, ARCADE_FILES } from '../../minecraft/arcade.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { WAITING_DATAPACK, WAITING_FILES } from '../../minecraft/duels-waiting.ts'
import { moderationFiles } from '../../minecraft/moderation.ts'
import { CHAT_FILTER } from '../moderation/chat-filter.ts'
import { DUELS_STRUCTURES } from '../setups/duels-structures.ts'
import { withCurrentOwnFiles } from './own-files.ts'

const revision = (files: CarriedFile[]): ServerRevision => ({
  id: 'r',
  serverId: 's',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'paper',
  loaderVersion: '1',
  settings: defaultSettings({ name: 'Duels', gameMode: 'adventure', maxPlayers: 20 }),
  mods: [],
  modpack: null,
  files,
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
})

const older = (files: readonly CarriedFile[]) =>
  files.map((file) => ({ ...file, content: `${file.content}older` }))
const byPath = (files: readonly CarriedFile[]) => [...files].sort((a, b) => a.path.localeCompare(b.path))

describe('the files Cubepals owns, at a start', () => {
  test("a Duels server made earlier gets Duels' arena, kit, permissions and waiting datapack as they are now, its maps' structures with it", () => {
    const then = [
      ...older(DUELS_FILES),
      ...older(WAITING_FILES),
      { path: `${WAITING_DATAPACK}/data/cubepals/function/gone.mcfunction`, content: 'say gone' },
      ...older(moderationFiles(CHAT_FILTER)),
    ]
    expect(byPath(withCurrentOwnFiles(revision(then)).files)).toEqual(
      byPath([...DUELS_FILES, ...WAITING_FILES, ...DUELS_STRUCTURES, ...moderationFiles(CHAT_FILTER)]),
    )
  })

  test('the chat filter stays as its owner left it, and moderation tools turned off stay off', () => {
    const filterOff = withCurrentOwnFiles(revision([...ARCADE_FILES, ...older(moderationFiles(null))]))
    expect(byPath(filterOff.files)).toEqual(byPath([...ARCADE_FILES, ...moderationFiles(null)]))
    const toolsOff = withCurrentOwnFiles(revision([...older(ARCADE_FILES)]))
    expect(byPath(toolsOff.files)).toEqual(byPath(ARCADE_FILES))
  })

  test('a server carrying none of them is left as it is, and other files beside them are kept', () => {
    const plain = revision([{ path: 'plugins/LifeStealZ/config.yml', content: 'startHearts: 7\n' }])
    expect(withCurrentOwnFiles(plain)).toBe(plain)
    const beside = withCurrentOwnFiles(revision([...plain.files, ...older(ARCADE_FILES)]))
    expect(byPath(beside.files)).toEqual(byPath([...plain.files, ...ARCADE_FILES]))
    expect(
      beside.files.every(
        (file) =>
          file.path.startsWith(`${ARCADE_DATAPACK}/`) ||
          file.path.startsWith(`${RUNNING_LEVEL}/data/minecraft/maps/`) ||
          file.path.startsWith('plugins/LifeStealZ/'),
      ),
    ).toBe(true)
  })
})
