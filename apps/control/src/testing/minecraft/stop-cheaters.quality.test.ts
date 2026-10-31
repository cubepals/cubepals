// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Stop cheaters preserves owner configuration, restores backups, and grants exemptions precisely. */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { USER_MARK } from '../../minecraft/moderation.ts'
import {
  DEFAULT_PUNISHMENTS,
  GRIM,
  PRINT_MARK,
  PUNISHMENTS_FILE,
  parseUnchecked,
  readStopCheatersMark,
  runsOwnGrim,
  STOP_CHEATERS_ENV,
  STOP_CHEATERS_STEP,
  stopCheatersEnv,
  uncheckedCommand,
} from '../../minecraft/stop-cheaters.ts'

const uuid = 'abcdef01-2345-6789-abcd-ef0123456789'
const pin: PinnedMod = {
  source: { catalog: 'upload', uploadId: 'uploaded' },
  name: 'Something else',
  versionLabel: '1',
  artifact: {
    ref: { kind: 'remote', url: 'https://example.test/plugin.jar' },
    sha512: 'a'.repeat(128),
    sizeBytes: 1,
    fileName: 'plugin.jar',
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['1.21.11'],
  origin: 'user',
  requiredBy: [],
}

test('catalog identity or the normalized plugin name identifies an owner-provided Grim', () => {
  expect(runsOwnGrim([])).toBe(false)
  expect(runsOwnGrim([pin])).toBe(false)
  expect(runsOwnGrim([{ ...pin, name: 'GrimACExtra' }])).toBe(false)
  expect(runsOwnGrim([{ ...pin, source: { catalog: 'modrinth', projectId: 'other', versionId: 'v' } }])).toBe(
    false,
  )
  expect(runsOwnGrim([{ ...pin, source: { catalog: 'modrinth', projectId: GRIM, versionId: 'v' } }])).toBe(
    true,
  )
  for (const name of ['GrimAC', ' GRIM AC ', 'Grim\tA\nC']) expect(runsOwnGrim([{ ...pin, name }])).toBe(true)
})

test('the public default reports every advertised check without executing punishment commands', () => {
  const parsed = Bun.YAML.parse(DEFAULT_PUNISHMENTS) as {
    Punishments: Record<string, { checks: string[]; commands: string[]; 'remove-violations-after': number }>
  }
  const expected = {
    Simulation: ['Simulation', 'GroundSpoof', 'Timer', 'TimerLimit', 'NoFall'],
    Knockback: ['Knockback', 'Explosion'],
    Post: ['Post'],
    BadPackets: ['BadPackets', 'PacketOrder', 'Crash'],
    Reach: ['Reach'],
    Combat: ['Killaura', 'Aim'],
    Autoclicker: ['Autoclicker'],
    Misc: [
      'Vehicle',
      'Sprint',
      'Place',
      'Baritone',
      'FastBreak',
      'TransactionOrder',
      'Elytra',
      'Chat',
      'Exploit',
    ],
  }
  expect(Object.keys(parsed.Punishments).sort()).toEqual(Object.keys(expected).sort())
  for (const [group, checks] of Object.entries(expected)) {
    const settings = parsed.Punishments[group]
    expect(settings?.checks).toEqual(checks)
    expect(settings?.['remove-violations-after']).toBeGreaterThan(0)
    expect(settings?.commands).toHaveLength(2)
    expect(settings?.commands[0]).toMatch(/^[1-9]\d*:[1-9]\d* \[alert\]$/)
    expect(settings?.commands[1]).toMatch(/^[1-9]\d*:[1-9]\d* \[log\]$/)
  }
})

test('environment encoding preserves Unicode and shell syntax as data and does not duplicate ownership headers', () => {
  expect(stopCheatersEnv(null)).toEqual({})
  const content = "Punishments: {}\n# café ' $(touch escaped)\n"
  const env = stopCheatersEnv({ punishments: content, takeOver: false })
  expect(Object.keys(env)).toEqual([STOP_CHEATERS_ENV])
  const decoded = Buffer.from(env[STOP_CHEATERS_ENV] ?? '', 'base64').toString('utf8')
  expect(decoded).toStartWith('# Written by Cubepals at every start while Stop cheaters is on.\n')
  expect(decoded).toEndWith(content)
  const again = stopCheatersEnv({ punishments: decoded, takeOver: true })
  expect(Buffer.from(again[STOP_CHEATERS_ENV] ?? '', 'base64').toString('utf8')).toBe(decoded)
  expect(again.BLOCKLY_STOP_CHEATERS_OURS).toBe('TRUE')
})

test('only explicit true exemptions identify unchecked players, and names may be absent', () => {
  const record = (identity: string, name: string, permissions: string) =>
    `${USER_MARK}\nuuid: ${identity}\n${name}\npermissions:\n${permissions}\n`
  const second = '01234567-89ab-cdef-0123-456789abcdef'
  const accepted = [
    record(`'${uuid.toUpperCase()}'`, "name: 'Steve'", "  - 'grim.exempt'"),
    record(second, 'name: null', '  - grim.exempt:\n      value: true'),
    record(uuid, '', ' - grim.exempt'),
  ].join('')
  expect(parseUnchecked(accepted)).toEqual([
    { uuid, name: 'Steve' },
    { uuid: second, name: '' },
    { uuid, name: '' },
  ])
  for (const permissions of [
    '  - grim.exempt:\n      value: false',
    '  - grimXexempt',
    '  - grim.exempt.extra',
    '  - other.grim.exempt',
    '  - grim.exempt: false',
    '  - grim.exempt:\n      value: true-ish',
    '',
  ])
    expect(parseUnchecked(record(uuid, 'name: Player', permissions))).toEqual([])
  expect(parseUnchecked(record('invalid', 'name: Player', '- grim.exempt'))).toEqual([])
  expect(parseUnchecked('')).toEqual([])
  expect(uncheckedCommand(uuid, true)).toBe(`lp user ${uuid} permission set grim.exempt true`)
  expect(uncheckedCommand(uuid, false)).toBe(`lp user ${uuid} permission unset grim.exempt`)
  expect(readStopCheatersMark(' own\n')).toBe('own')
  expect(readStopCheatersMark(' ours\n')).toBe('ours')
  for (const mark of [undefined, '', 'unknown', 'ownership', 'OURs'])
    expect(readStopCheatersMark(mark)).toBeNull()
})

const volumes: string[] = []
afterEach(() => {
  for (const volume of volumes.splice(0)) rmSync(volume, { recursive: true, force: true })
})
const volume = () => {
  const data = mkdtempSync(join(tmpdir(), 'quality-grim-'))
  volumes.push(data)
  mkdirSync(join(data, 'plugins/GrimAC'), { recursive: true })
  return data
}
const kept = `${PUNISHMENTS_FILE}.before-cubepals`
const mark = '.blockly-stop-cheaters'
const read = (data: string, path: string) =>
  existsSync(join(data, path)) ? readFileSync(join(data, path), 'utf8') : null
const config = 'Punishments:\n  Reach:\n    commands:\n      - "5:5 [alert]"\n'
const builtin =
  'Punishments:\n  Reach:\n    commands:\n      - "5:5 [log]"\n      - \'5:5 [webhook]\'\n      - "5:5 [proxy]"\n'

/** The volume-link integration tests exercise unlinked; these fixtures contain regular paths only. */
const start = (data: string, env: Record<string, string>) =>
  Bun.spawn(['/bin/sh', '-c', `unlinked() { :; }; ${STOP_CHEATERS_STEP.replaceAll('/data', data)}`], {
    cwd: data,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited
const enabled = (takeOver = false) => stopCheatersEnv({ punishments: config, takeOver })

test('enabling writes managed content, repeated starts update it, and disabling removes only the managed file', async () => {
  const data = volume()
  expect(await start(data, enabled())).toBe(0)
  expect(read(data, PUNISHMENTS_FILE)).toEndWith(config)
  expect(read(data, mark)?.trim()).toBe('ours')
  expect(read(data, kept)).toBeNull()
  const update = `# harmless settings update\n${config}`
  expect(await start(data, stopCheatersEnv({ punishments: update, takeOver: false }))).toBe(0)
  expect(read(data, PUNISHMENTS_FILE)).toEndWith(update)
  expect(read(data, kept)).toBeNull()
  const printed = Bun.spawn(['/bin/sh', '-c', PRINT_MARK], {
    cwd: data,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdout: 'pipe',
  })
  expect(await new Response(printed.stdout).text()).toBe('ours\n')
  expect(await printed.exited).toBe(0)
  expect(await start(data, {})).toBe(0)
  expect(read(data, PUNISHMENTS_FILE)).toBeNull()
  expect(read(data, mark)).toBeNull()
  expect(await start(data, {})).toBe(0)
})

test('built-in settings are backed up and restored while an existing backup is never overwritten', async () => {
  const data = volume()
  writeFileSync(join(data, PUNISHMENTS_FILE), builtin)
  expect(await start(data, enabled())).toBe(0)
  expect(read(data, kept)).toBe(builtin)
  expect(await start(data, {})).toBe(0)
  expect(read(data, PUNISHMENTS_FILE)).toBe(builtin)
  expect(read(data, kept)).toBeNull()
  writeFileSync(join(data, kept), 'older owner configuration\n')
  expect(await start(data, enabled())).toBe(0)
  expect(read(data, kept)).toBe('older owner configuration\n')
  const backups = readdirSync(join(data, 'plugins/GrimAC')).filter((name) =>
    /\.before-cubepals\.\d+$/.test(name),
  )
  expect(backups).toHaveLength(1)
  expect(read(data, `plugins/GrimAC/${backups[0]}`)).toBe(builtin)
})

test('owner commands and unreadable command structures remain untouched until explicit takeover', async () => {
  for (const owner of [
    'Punishments: {}\n',
    'commands: ["5:5 kick Player"]\n',
    'commands:\n  - "5:5 kick Player"\n',
  ]) {
    const data = volume()
    writeFileSync(join(data, PUNISHMENTS_FILE), owner)
    expect(await start(data, enabled())).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toBe(owner)
    expect(read(data, mark)?.trim()).toBe('own')
    expect(read(data, kept)).toBeNull()
    expect(await start(data, {})).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toBe(owner)
    expect(read(data, mark)).toBeNull()
    expect(await start(data, enabled(true))).toBe(0)
    expect(read(data, kept)).toBe(owner)
    expect(read(data, PUNISHMENTS_FILE)).toEndWith(config)
    expect(await start(data, {})).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toBe(owner)
  }
})

test('a later owner edit survives disabling and a failed write reports failure without claiming success', async () => {
  const data = volume()
  expect(await start(data, enabled())).toBe(0)
  writeFileSync(join(data, PUNISHMENTS_FILE), 'owner edited this after start\n')
  expect(await start(data, {})).toBe(0)
  expect(read(data, PUNISHMENTS_FILE)).toBe('owner edited this after start\n')
  expect(read(data, mark)).toBeNull()
  const broken = volume()
  expect(await start(broken, { [STOP_CHEATERS_ENV]: 'invalid base64!' })).not.toBe(0)
  expect(read(broken, mark)).toBeNull()
  const blocked = volume()
  rmSync(join(blocked, 'plugins'), { recursive: true })
  writeFileSync(join(blocked, 'plugins'), 'not a directory')
  expect(await start(blocked, enabled())).not.toBe(0)
  expect(read(blocked, mark)).toBeNull()
})
