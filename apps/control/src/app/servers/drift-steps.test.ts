// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drift digest holds none of the text of Blockly's own steps before the image starts: a new
 * text of a step neither restarts a running server nor boots a sleeping one. What a step acts on is
 * in the environment, which drift compares, so a change to that still reaches a running server.
 */
import { describe, expect, test } from 'bun:test'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { CARRIED_STEP, FILES_VARIABLES } from '../../minecraft/carried.ts'
import { toRuntimeSpec } from '../../minecraft/runtime-spec.ts'
import { readList } from '../../minecraft/step-lists.ts'
import { specDigest, withoutPlanLimits } from './specs.ts'

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.1.2',
  loader: 'paper',
  loaderVersion: '40',
  settings: defaultSettings({ name: 'Arcade', gameMode: 'adventure', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [{ path: 'plugins/LibertyBans/config.yml', content: 'x: 1\n' }],
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
    generatedOnVersion: '26.1.2',
  },
  memoryTier: '4g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'http://x/x.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: 'http://x/icon.png',
  brandPack: null,
}

const drift = (spec: ReturnType<typeof toRuntimeSpec>) => specDigest(withoutPlanLimits(spec))

/** The carried step as it would read had it never taken its files compressed. */
const EARLIER_STEP = CARRIED_STEP.replace(`${readList('files', FILES_VARIABLES)} `, '').replaceAll(
  '"$files"',
  '"$BLOCKLY_FILES"',
)

describe('the drift digest and the text of Blockly’s own steps', () => {
  test('a server with carried files keeps its drift digest when a step’s text changes', () => {
    expect(EARLIER_STEP).not.toBe(CARRIED_STEP)
    const now = toRuntimeSpec(input)
    const withScript = (change: (script: string) => string) => ({
      ...now,
      entrypoint: (now.entrypoint ?? []).map((part, i) => (i === 2 ? change(part) : part)),
    })
    expect(drift(withScript((script) => script.replace(CARRIED_STEP, EARLIER_STEP)))).toBe(drift(now))
    expect(drift(withScript((script) => `echo a new step; ${script}`))).toBe(drift(now))
  })

  test('a change to what a step acts on still moves it', () => {
    const now = toRuntimeSpec(input)
    const changed = toRuntimeSpec({
      ...input,
      revision: { ...revision, files: [{ path: 'plugins/LibertyBans/config.yml', content: 'x: 2\n' }] },
    })
    expect(drift(changed)).not.toBe(drift(now))
  })
})
