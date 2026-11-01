// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which changes restart a running server, and so may wait for its players to leave. */
import { describe, expect, test } from 'bun:test'
import { defaultSettings, type RevisionDraft } from '../../domain/revision/revision.ts'
import { restartsFor, waitsForPlayers } from './restart-wait.ts'

const draft = (patch: Partial<RevisionDraft> = {}): RevisionDraft => ({
  acknowledgedRevoked: [],
  files: [],
  gameVersion: '26.3',
  loader: 'paper',
  loaderVersion: null,
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 4 }),
  mods: [],
  modpack: null,
  reason: 'settings_changed',
  basedOnRevisionId: null,
  ...patch,
})

const withSettings = (settings: Partial<RevisionDraft['settings']>, gameVersion = '26.3') =>
  draft({ gameVersion, settings: { ...draft().settings, ...settings } })

describe('what restarts a running server', () => {
  test('nothing changed restarts nothing', () => {
    expect(restartsFor(draft(), draft())).toBe(false)
  })

  test('settings the game takes as people play, and the server list’s, never restart it', () => {
    expect(restartsFor(draft(), withSettings({ difficulty: 'hard' }))).toBe(false)
    expect(restartsFor(draft(), withSettings({ defaultGameMode: 'creative' }))).toBe(false)
    expect(restartsFor(draft(), withSettings({ motd: 'Come on in' }))).toBe(false)
    expect(restartsFor(draft(), withSettings({ difficulty: 'hard', motd: 'Hard now' }))).toBe(false)
  })

  test('one the game reads only as it starts restarts it, alone or among live ones', () => {
    expect(restartsFor(draft(), withSettings({ viewDistance: 4 }))).toBe(true)
    expect(restartsFor(draft(), withSettings({ difficulty: 'hard', maxPlayers: 2 }))).toBe(true)
    expect(restartsFor(draft(), withSettings({ onlineMode: false }))).toBe(true)
    expect(restartsFor(draft(), withSettings({ bedrock: false }))).toBe(true)
  })

  test('PvP is live from the release that made it a game rule, and a restart before it', () => {
    expect(restartsFor(withSettings({}, '26.3'), withSettings({ pvp: false }, '26.3'))).toBe(false)
    expect(restartsFor(withSettings({}, '1.21.8'), withSettings({ pvp: false }, '1.21.8'))).toBe(true)
  })

  test('anything but settings restarts it: a version, a server type, mods, files', () => {
    expect(restartsFor(draft(), draft({ gameVersion: '26.4' }))).toBe(true)
    expect(restartsFor(draft(), draft({ loader: 'fabric' }))).toBe(true)
    expect(restartsFor(draft(), draft({ files: [{ path: 'a.yml', content: 'x' }] }))).toBe(true)
  })
})

describe('whether a change waits for players', () => {
  const running = {
    id: 'not-read',
    lifecycle: { status: 'running' as const, stopReason: null, failure: null },
  }
  const never = {} as Parameters<typeof waitsForPlayers>[0]

  test('only where the owner chose to wait, on a running server', async () => {
    // Neither reads who is on: there is no one to wait for.
    expect(await waitsForPlayers(never, running, 'now')).toBe(false)
    expect(
      await waitsForPlayers(
        never,
        { ...running, lifecycle: { ...running.lifecycle, status: 'stopped' } },
        'empty',
      ),
    ).toBe(false)
  })
})
