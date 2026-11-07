// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the control plane runs over RCON (a backup's `save-off`, `save-all flush` and `save-on`)
 * stays out of operators' chat in the game, and turning that off restarts no running server and
 * boots no sleeping one: drift doesn't compare it, so it arrives at each server's next start.
 */
import { describe, expect, test } from 'bun:test'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { RCON_ECHO_ENV, toRuntimeSpec } from '../../minecraft/runtime-spec.ts'
import { specDigest, withoutPlanLimits } from './specs.ts'

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.3',
  loader: 'fabric',
  loaderVersion: '0.20.1',
  settings: defaultSettings({ name: 'Friends', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

const input = {
  serverId: 's-1',
  revision,
  world: {
    id: 'w',
    serverId: 's-1',
    levelName: 'world',
    name: 'World',
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    generatedOnVersion: '26.3',
  },
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'http://x/x.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

const drift = (spec: ReturnType<typeof toRuntimeSpec>) => specDigest(withoutPlanLimits(spec))

describe('RCON in operators’ chat', () => {
  test('every server is told not to repeat RCON’s commands to its operators', () => {
    // The image writes it to `server.properties` as `broadcast-rcon-to-ops`.
    expect(RCON_ECHO_ENV).toBe('BROADCAST_RCON_TO_OPS')
    expect(toRuntimeSpec(input).env[RCON_ECHO_ENV]).toBe('FALSE')
  })

  test('a server from before it keeps its drift digest', () => {
    const now = toRuntimeSpec(input)
    const { [RCON_ECHO_ENV]: _echo, ...before } = now.env
    expect(drift({ ...now, env: before })).toBe(drift(now))
  })
})
