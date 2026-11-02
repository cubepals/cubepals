// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Verification uses a fresh world and exact gameplay inputs, independent of player revision ownership. */
import { expect, test } from 'bun:test'
import type { ModValidationPlanJson } from '@blockly/db'
import { defaultSettings } from '../../domain/revision/revision.ts'
import { Cdn } from '../../testing/cdn.ts'
import { validationKey, validationRevision, validationSpec } from './validation-plan.ts'

function plan(): ModValidationPlanJson {
  const mod = new Cdn().publish('plan')
  return {
    gameVersion: '26.3',
    loader: 'fabric',
    loaderVersion: '0.19.5',
    settings: defaultSettings({ name: 'Plan', gameMode: 'survival', maxPlayers: 1 }),
    mods: [{ ...mod, dir: 'mods' }],
    compat: [],
    files: [],
    modpack: null,
    memoryTier: '3g',
    storageGb: 5,
    provider: 'fake',
    regionKey: 'local',
  }
}

test('validation revisions have their own identity and no player acknowledgment or parent', () => {
  const revision = validationRevision(plan(), 'isolated-check')
  expect(revision).toMatchObject({
    id: 'isolated-check',
    serverId: 'isolated-check',
    number: 1,
    reason: 'created',
    basedOnRevisionId: null,
    acknowledgedRevoked: [],
    createdBy: 'system:mod-validation',
  })
})

test('gameplay settings and installation locations invalidate proof while a display name does not', () => {
  const original = plan()
  const key = validationKey(original)
  const mod = original.mods[0]
  if (!mod) throw new Error('The fixture needs a mod')
  for (const changed of [
    { ...original, settings: { ...original.settings, pvp: !original.settings.pvp } },
    { ...original, mods: [{ ...mod, dir: 'plugins' }] },
    { ...original, mods: [{ ...mod, artifact: { ...mod.artifact, fileName: 'different.jar' } }] },
    { ...original, compat: [mod] },
    { ...original, provider: 'another-provider' },
    { ...original, regionKey: 'another-region' },
    { ...original, storageGb: 6 },
  ])
    expect(validationKey(changed)).not.toBe(key)
  expect(validationKey({ ...original, settings: { ...original.settings, motd: 'Renamed' } })).toBe(key)
})

test('the runtime always gets a normal seeded world and a private RCON password', () => {
  const spec = validationSpec(plan(), 'isolated-check', 'one-use-password', () => 'https://example.test/jar')
  expect(spec.env).toMatchObject({
    LEVEL: 'world',
    LEVEL_TYPE: 'minecraft:normal',
    SEED: '0',
    HARDCORE: 'false',
  })
  expect(spec.secrets.RCON_PASSWORD).toBe('one-use-password')
  expect(spec.labels).toMatchObject({
    'blockly.server': 'isolated-check',
    'blockly.purpose': 'mod-validation',
  })
  expect(spec.ports.every((port) => port.audience.length === 1 && port.audience[0] === 'control')).toBe(true)
})
