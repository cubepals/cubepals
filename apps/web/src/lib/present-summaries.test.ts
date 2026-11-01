// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Dates, mod plans and listing refusals keep the words and distinctions people act on. */
import { expect, test } from 'bun:test'
import type {
  ModConflictView,
  ModPlanView,
  ModView,
  RevisionChangeView,
  RevisionView,
  WorldView,
} from '@blockly/contracts'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { PICK_ANOTHER_NAME } from '@blockly/contracts/names'
import {
  bytes,
  clockTime,
  datapacksSaid,
  dayOf,
  levelTypeLabel,
  loaderWithBuild,
  presentChange,
  presentConflict,
  presentIneligible,
  presentPlan,
  revisionTitle,
  runsOnPaper,
  settingLabel,
  sizeLabel,
  timeAgo,
  whenItGoes,
  whenTaken,
} from './present'

const now = Date.UTC(2026, 0, 6, 12, 30)
const iso = (at: number) => new Date(at).toISOString()
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

test('future moments distinguish today, tomorrow and a named weekday', () => {
  expect(clockTime(iso(now))).toBe(clock(now))
  expect(whenItGoes(iso(now), now)).toBe(`today at ${clock(now)}`)
  expect(whenItGoes(iso(now + DAY_MS), now)).toBe(`tomorrow at ${clock(now + DAY_MS)}`)
  const later = now + 3 * DAY_MS
  expect(whenItGoes(iso(later), now)).toBe(
    `${new Date(later).toLocaleDateString([], { weekday: 'long' })} at ${clock(later)}`,
  )
})

for (const [elapsed, unit, count] of [
  [MINUTE_MS, 'minute', 1],
  [2 * MINUTE_MS, 'minute', 2],
  [HOUR_MS, 'hour', 1],
  [2 * HOUR_MS, 'hour', 2],
  [DAY_MS, 'day', 1],
  [2 * DAY_MS, 'day', 2],
  [31 * DAY_MS, 'month', 1],
  [61 * DAY_MS, 'month', 2],
  [366 * DAY_MS, 'year', 1],
  [731 * DAY_MS, 'year', 2],
] as const) {
  test(`history reports ${count} ${unit} using the platform's plural rules`, () => {
    const words = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
    expect(timeAgo(iso(now - elapsed), now)).toBe(words.format(-count, unit))
  })
}
test('a new, future or unreadable history timestamp has a safe immediate label', () => {
  for (const at of [iso(now), iso(now - 59 * SECOND_MS), iso(now + MINUTE_MS), 'not-a-date'])
    expect(timeAgo(at, now)).toBe('just now')
})
test('backup dates distinguish today, yesterday and older calendar dates', () => {
  expect(whenTaken(iso(now), now)).toBe(`Today, ${clock(now)}`)
  expect(whenTaken(iso(now - DAY_MS), now)).toBe(`Yesterday, ${clock(now - DAY_MS)}`)
  const before = now - 3 * DAY_MS
  const day = new Date(before).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  expect(dayOf(iso(before))).toBe(day)
  expect(whenTaken(iso(before), now)).toBe(`${day}, ${clock(before)}`)
})

test('sizes and pinned server builds retain their public labels', () => {
  expect(sizeLabel('3g')).toBe('3 GB')
  expect(sizeLabel('12g')).toBe('12 GB')
  expect(loaderWithBuild('vanilla', null)).toBe('Vanilla')
  expect(loaderWithBuild('vanilla', '123')).toBe('Vanilla on Paper')
  expect(loaderWithBuild('paper', '123')).toBe('Paper build 123')
  expect(loaderWithBuild('fabric', '0.16')).toBe('Fabric 0.16')
  expect(runsOnPaper({ loader: 'vanilla', loaderVersion: '123' })).toBe(true)
  expect(runsOnPaper({ loader: 'vanilla', loaderVersion: null })).toBe(false)
  expect(runsOnPaper({ loader: 'paper', loaderVersion: '123' })).toBe(false)
  expect(settingLabel('keepInventory')).toBe('Keep items when you die')
  expect(settingLabel('futureSetting')).toBe('futureSetting')
})
for (const [reason, title] of Object.entries({
  created: 'Created',
  settings_changed: 'Settings changed',
  version_changed: 'Version changed',
  mods_changed: 'Mods changed',
  rollback: 'Went back',
  restore: 'Restored from a backup',
}))
  test(`revision reason ${reason} is worded for the owner`, () => {
    expect(revisionTitle({ reason } as RevisionView)).toBe(title)
  })

const target = { gameVersion: '26.2', loader: 'fabric' } as const
const conflicts: Array<[ModConflictView, string]> = [
  [{ kind: 'unavailable', mod: 'Iris', projectId: 'iris' }, "Iris isn't available on Modrinth any more."],
  [{ kind: 'no_fitting_version', mod: 'Iris', projectId: 'iris' }, 'Iris has no version for Fabric 26.2.'],
  [
    { kind: 'needs_newer_release', mod: 'Iris', projectId: 'iris', from: null },
    "Iris's builds for Fabric 26.2 need a newer Minecraft than Cubepals offers.",
  ],
  [
    { kind: 'needs_newer_release', mod: 'Iris', projectId: 'iris', from: '26.3' },
    "Iris's builds for Fabric 26.2 need Minecraft 26.3 or newer.",
  ],
  [
    { kind: 'needs_newer', mod: 'Iris', projectId: 'iris', with: 'Foundation', atLeast: '2.0' },
    "Iris needs Foundation 2.0 or newer, which doesn't run on Fabric 26.2.",
  ],
  [
    { kind: 'client_only', mod: 'Iris', projectId: 'iris' },
    "Iris only runs in players' games, not on a server.",
  ],
  [
    { kind: 'missing_dependency', mod: 'Iris', projectId: 'iris', dependency: 'Foundation' },
    'Iris needs Foundation, which has no version for Fabric 26.2.',
  ],
  [
    { kind: 'incompatible', mod: 'Iris', projectId: 'iris', with: 'Sodium' },
    "Iris can't run alongside Sodium.",
  ],
  [
    { kind: 'upload_does_not_fit', mod: 'Terrain', madeFor: null },
    'Terrain, your datapack, was made for a newer Minecraft than Cubepals knows.',
  ],
  [
    { kind: 'upload_does_not_fit', mod: 'Terrain', madeFor: '1.21' },
    'Terrain, your datapack, was made for Minecraft 1.21, not 26.2.',
  ],
  [
    { kind: 'upload_does_not_fit', mod: 'Terrain' },
    'Terrain, your upload, was made for another Minecraft version or server type.',
  ],
]
for (const [conflict, words] of conflicts)
  test(`mod conflict ${conflict.kind}: ${words}`, () => {
    expect(presentConflict(conflict, target)).toBe(words)
  })

const mod = (name: string, patch: Partial<ModView> = {}): ModView => ({
  id: name,
  name,
  versionLabel: '1.0',
  origin: 'user',
  requiredBy: [],
  environment: 'server',
  source: 'catalog',
  url: null,
  revoked: false,
  malware: false,
  datapack: false,
  ...patch,
})
test('a mod plan distinguishes additions, updates, removals and the dependency that asked for an addition', () => {
  const plan: Extract<ModPlanView, { kind: 'ok' }> = {
    kind: 'ok',
    loader: 'fabric',
    expected: [],
    revoked: [],
    added: [
      mod('Iris'),
      mod('Foundation', { origin: 'dependency', requiredBy: ['Iris', 'Terrain'] }),
      mod('Orphan', { origin: 'dependency' }),
    ],
    updated: [{ from: mod('Sodium'), to: mod('Sodium', { versionLabel: '2.0' }) }],
    removed: [mod('Old Mod')],
  }
  expect(presentPlan(plan)).toEqual([
    '+ Iris 1.0',
    '+ Foundation 1.0 (needed by Iris, Terrain)',
    '+ Orphan 1.0',
    'Sodium 1.0 → 2.0',
    '− Old Mod',
  ])
  expect(presentPlan({ ...plan, added: [], updated: [], removed: [] })).toEqual([])
  expect(datapacksSaid([])).toBe('')
  expect(datapacksSaid([mod('Iris')])).toBe('')
  expect(datapacksSaid([mod('Terrain', { datapack: true })])).toBe(
    'Datapacks go into the world that’s playing, and into any world you switch to. ',
  )
})

for (const [size, words] of [
  [null, null],
  [0, null],
  [1, '1 KB'],
  [1024, '1 KB'],
  [1536, '2 KB'],
  [1024 ** 2, '1 MB'],
  [1024 ** 3, '1.0 GB'],
  [1536 * 1024 ** 2, '1.5 GB'],
] as const)
  test(`stored bytes ${size} have a readable size`, () => {
    expect(bytes(size)).toBe(words)
  })
for (const [type, words] of Object.entries({
  'minecraft:normal': 'Normal',
  'minecraft:flat': 'Superflat',
  'minecraft:large_biomes': 'Large biomes',
  'minecraft:amplified': 'Amplified',
  'blockly:void': 'Void',
  'blockly:arcade': 'Arcade',
}))
  test(`world type ${type} retains its familiar name`, () => {
    expect(levelTypeLabel(type as WorldView['levelType'])).toBe(words)
  })

const untrusted = {
  upload: 'Iris is your own upload; servers with uploads don’t list.',
  not_allowlisted: 'Iris isn’t on Cubepals’ list of mods it vouches for.',
  project_revoked: 'Iris was taken down where it was published.',
  version_revoked: 'This version of Iris was taken down where it was published.',
  unknown: 'Cubepals hasn’t checked Iris with Modrinth yet.',
  modpack: 'The directory shows mods Cubepals vouches for, and Iris brings its own.',
  future: 'Iris isn’t on Cubepals’ list of mods it vouches for.',
}
for (const [why, words] of Object.entries(untrusted))
  test(`listing exclusion explains ${why}`, () => {
    expect(presentIneligible({ code: 'untrusted_mods', detail: `Iris: ${why}` })).toBe(words)
  })
test('listing exclusions preserve their reason without exposing implementation codes', () => {
  expect(presentIneligible({ code: 'untrusted_mods', detail: 'Iris' })).toBe(untrusted.not_allowlisted)
  expect(presentIneligible({ code: 'untrusted_mods' })).toBe(
    ' isn’t on Cubepals’ list of mods it vouches for.',
  )
  for (const [code, words] of Object.entries({
    not_running_yet: 'It lists once the server has started.',
    account_not_active: 'Your account is suspended.',
    restricted: 'Public listing is turned off for your account.',
    not_entitled: 'Your plan doesn’t include public listing.',
    server_deleted: 'The server is deleted.',
    offensive_name: PICK_ANOTHER_NAME,
    future: 'It can’t be shown right now.',
  }))
    expect(presentIneligible({ code })).toBe(words)
})

const differences: Array<[RevisionChangeView, string]> = [
  [{ field: 'loader', from: 'custom', to: 'fabric' }, 'Server type custom → Fabric'],
  [{ field: 'futureSetting', from: 'old', to: 'new' }, 'futureSetting old → new'],
  [{ field: 'defaultGameMode', from: 'survival', to: 'creative' }, 'Game mode Survival → Creative'],
  [{ field: 'difficulty', from: 'easy', to: 'hard' }, 'Difficulty Easy → Hard'],
  [{ field: 'keepInventory', from: false, to: true }, 'Keep items when you die off → on'],
  [{ field: 'viewDistance', from: 8, to: 10 }, 'View distance 8 → 10 chunks'],
  [{ field: 'modpack', from: null, to: 'Sky' }, 'Now playing Sky'],
  [{ field: 'modpack', from: 'Sky', to: null }, 'Stopped playing Sky'],
  [{ field: 'modpack', from: 'Sky', to: 'Valley' }, 'Modpack: Sky → Valley'],
  [
    { field: 'mods', added: ['Iris'], removed: ['Old'], changed: ['Foundation'] },
    'Mods: added Iris; removed Old; updated Foundation',
  ],
  [{ field: 'files', added: [], removed: ['old.toml'], changed: [] }, 'Set by Cubepals: removed old.toml'],
]
for (const [change, words] of differences)
  test(`revision difference: ${words}`, () => {
    expect(presentChange(change)).toBe(words)
  })
