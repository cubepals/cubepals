// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rules for what a revision places itself: how carried files name the running world, how they
 * are named and diffed, and which changes to them are undone with the snapshot from before
 * (docs/modpack-system.md § Carried files).
 */
import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../mods/artifact.ts'
import { fileLabel, movesCarried, onLevel, RUNNING_LEVEL } from './carried.ts'
import { defaultSettings, describeChanges, type RevisionDraft, rewritesWorld } from './revision.ts'

const draft = (patch: Partial<RevisionDraft> = {}): RevisionDraft => ({
  gameVersion: '26.2',
  loader: 'paper',
  loaderVersion: '12',
  settings: defaultSettings({ name: 'Hearts', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  ...patch,
})

const addon = (sha512: string, dir?: string): PinnedMod => ({
  source: { catalog: 'modrinth', projectId: 'aoneblock', versionId: 'a-1' },
  name: 'AOneBlock',
  versionLabel: '1.28.0',
  artifact: {
    ref: { kind: 'remote', url: 'https://cdn.example.test/a.jar' },
    sha512,
    sizeBytes: 1,
    fileName: 'a.jar',
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['26.1.2'],
  origin: 'user',
  requiredBy: [],
  ...(dir === undefined ? {} : { dir }),
})

describe('files Cubepals carries', () => {
  test('a file names the world the server runs wherever it says so, and is otherwise as written', () => {
    const arena = {
      path: 'plugins/Duels/config.yml',
      content: `A: ${RUNNING_LEVEL}\nB: ${RUNNING_LEVEL}_nether\n`,
    }
    expect(onLevel(arena, 'world')).toEqual({ path: arena.path, content: 'A: world\nB: world_nether\n' })
    expect(onLevel(arena, 'world-2').content).toBe('A: world-2\nB: world-2_nether\n')
    const plain = { path: 'plugins/LifeStealZ/config.yml', content: 'world: {{level}}\n' }
    expect(onLevel(plain, 'world-2')).toEqual(plain)
  })

  test('a file is named by the plugin it sets up, not by its path', () => {
    expect(fileLabel('plugins/LifeStealZ/config.yml')).toBe('LifeStealZ settings')
    expect(fileLabel('plugins/OldCombatMechanics/config.yml')).toBe('OldCombatMechanics settings')
    expect(fileLabel('bukkit.yml')).toBe('bukkit.yml')
  })

  test('the diff lists carried files the way it lists mods', () => {
    const before = draft({ files: [{ path: 'plugins/LifeStealZ/config.yml', content: 'maxHearts: 20\n' }] })
    const after = draft({
      files: [
        { path: 'plugins/LifeStealZ/config.yml', content: 'maxHearts: 15\n' },
        { path: 'plugins/OldCombatMechanics/config.yml', content: 'x: 1\n' },
      ],
    })
    expect(describeChanges(before, after)).toEqual([
      {
        field: 'files',
        added: ['OldCombatMechanics settings'],
        removed: [],
        changed: ['LifeStealZ settings'],
      },
    ])
    expect(describeChanges(after, before)).toEqual([
      {
        field: 'files',
        added: [],
        removed: ['OldCombatMechanics settings'],
        changed: ['LifeStealZ settings'],
      },
    ])
    expect(describeChanges(before, before)).toEqual([])
  })

  test('another file or a plugin moved to a folder of its own is undone with the snapshot from before', () => {
    const before = draft({ files: [{ path: 'plugins/LifeStealZ/config.yml', content: 'maxHearts: 20\n' }] })
    const after = draft({ files: [{ path: 'plugins/LifeStealZ/config.yml', content: 'maxHearts: 15\n' }] })
    expect(rewritesWorld(before, after)).toBe(true)
    expect(rewritesWorld(before, { ...before })).toBe(false)
    expect(
      movesCarried(
        { mods: [addon('a'.repeat(128))] },
        { mods: [addon('a'.repeat(128), 'plugins/BentoBox/addons')] },
      ),
    ).toBe(true)
    expect(
      movesCarried(
        { mods: [addon('a'.repeat(128), 'plugins/BentoBox/addons')] },
        { mods: [addon('b'.repeat(128), 'plugins/BentoBox/addons')] },
      ),
    ).toBe(true)
    // A plugin in the plugins folder changes the way any mod does.
    expect(movesCarried({ mods: [addon('a'.repeat(128))] }, { mods: [addon('b'.repeat(128))] })).toBe(false)
  })
})
