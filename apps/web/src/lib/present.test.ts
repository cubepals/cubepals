// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ChangeKind, type OperationView, PLAY_ICONS, type ServerView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import {
  downloadOf,
  etaLine,
  joinLine,
  loaderWithBuild,
  packToInstall,
  playIconSrc,
  presentChange,
  presentProgress,
  presentStatus,
  quietLine,
} from './present.ts'

const stopped = (stopReason: ServerView['stopReason']) =>
  ({ status: 'stopped', stopReason, crash: null, failure: null }) as unknown as ServerView

const betterMc: NonNullable<ServerView['modpack']> = {
  name: 'Better MC',
  version: 'v48',
  page: 'https://modrinth.com/project/shFhR8Vx/version/x9FkQ2Lm',
  file: 'https://cdn.modrinth.com/data/shFhR8Vx/versions/x9FkQ2Lm/Better%20MC.mrpack',
  app: 'modrinth://version/x9FkQ2Lm',
  icon: null,
  environment: 'both',
}

describe('presentStatus', () => {
  test('a server up without all it was told to load is never shown as plainly online', () => {
    const running = (notLoaded: string[]) =>
      ({
        status: 'running',
        loader: 'paper',
        maxPlayers: 5,
        players: { online: 1 },
        notLoaded,
      }) as unknown as ServerView
    expect(presentStatus(running([]))).toEqual({ pill: 'online', detail: '1 / 5 players' })
    expect(presentStatus(running(['BentoBox']))).toEqual({
      pill: 'info',
      label: 'Plugins missing',
      detail: '1 / 5 players · BentoBox didn’t load',
    })
    expect(presentStatus(running(['BentoBox', 'Level'])).detail).toBe(
      '1 / 5 players · BentoBox and Level didn’t load',
    )
  })

  test('an empty server says when it sleeps if nobody joins, and a server in use doesn’t', () => {
    const at = new Date(2026, 9, 11, 14, 32).getTime()
    const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const running = (online: number, sleepsAt: string | null) =>
      ({
        status: 'running',
        maxPlayers: 5,
        players: { online },
        notLoaded: [],
        sleepsAt,
      }) as unknown as ServerView
    const sleeps = new Date(at).toISOString()
    expect(presentStatus(running(0, sleeps), at - MINUTE_MS)).toEqual({
      pill: 'online',
      detail: `0 / 5 players · Sleeps at ${clock} if nobody joins`,
    })
    // The idle check looks once a minute: a time just gone is soon, not a clock that reads late.
    expect(presentStatus(running(0, sleeps), at + 30_000).detail).toBe(
      '0 / 5 players · Sleeps soon if nobody joins',
    )
    expect(presentStatus(running(2, null), at).detail).toBe('2 / 5 players')
    // A plan that never sleeps an idle server says nothing about it.
    expect(presentStatus(running(0, null), at).detail).toBe('0 / 5 players')
  })

  // A stop a join can undo is sleep, whatever made it; a crash and a paused account are not,
  // since joining cannot help them.
  test('a stop that a join can undo is sleep, and says what made it', () => {
    expect(presentStatus(stopped('maintenance'))).toEqual({
      pill: 'sleeping',
      detail: 'Asleep after maintenance by Cubepals. Joining wakes it',
    })
    expect(presentStatus(stopped('user'))).toEqual({
      pill: 'sleeping',
      detail: 'Asleep until someone joins, or you wake it here',
    })
    expect(presentStatus(stopped('idle')).pill).toBe('sleeping')
    expect(presentStatus(stopped('session_cap')).detail).toContain('time limit')
    // A plan that no longer runs it pauses it, and says the world is safe rather than blaming anyone.
    expect(presentStatus(stopped('entitlement')).detail).toBe(
      'Paused when your plan changed. Its world is safe',
    )

    // Hours used up is sleep, not a pause, and it never says joining wakes it, which it can't.
    expect(presentStatus(stopped('hours'))).toEqual({
      pill: 'sleeping',
      detail: 'This month’s hours are used up. It sleeps until the 1st',
    })
    expect(presentStatus(stopped('unpaid'))).toEqual({
      pill: 'suspended',
      detail: 'Paused until a payment is made. Its world is safe; see your account',
    })

    expect(presentStatus(stopped('policy')).pill).toBe('suspended')

    // Out of the owner's play, whatever put it to sleep, nothing says a join or the button wakes it.
    const out = (stopReason: ServerView['stopReason'], status: ServerView['status'] = 'stopped') =>
      ({
        ...stopped(stopReason),
        status,
        playToday: { hours: 2, hoursLeft: 0, backAt: '2026-10-18T00:00:00Z' },
        playTotal: { hours: 20, hoursLeft: 4 },
      }) as ServerView
    for (const server of [out('daily'), out('idle'), out('user'), out(null, 'stored')])
      expect(presentStatus(server)).toEqual({
        pill: 'sleeping',
        label: 'Resting',
        detail: 'Resting until midnight. Nobody can wake it before then',
      })
    expect(presentStatus({ ...out('idle'), playTotal: { hours: 20, hoursLeft: 0 } })).toEqual({
      pill: 'stopped',
      detail: 'The free trial is over. Its world is kept, and Plus starts it again',
    })
    // A crash keeps its own words, and a running server is never resting.
    expect(presentStatus(out('crash')).pill).toBe('crashed')
    expect(presentStatus({ ...out(null, 'running'), players: null, notLoaded: [] }).label).not.toBe('Resting')
    // With today's play left, a day's stop is asleep like any.
    expect(presentStatus({ ...out('daily'), playToday: { hours: 2, hoursLeft: 1, backAt: '' } }).detail).toBe(
      'Asleep until someone joins, or you wake it here',
    )
    expect(presentStatus(stopped('entitlement')).pill).toBe('suspended')
    expect(presentStatus(stopped('crash')).pill).toBe('crashed')
  })

  test('a world resting while nobody plays is asleep like any other, and says waking takes longer', () => {
    const as = (status: string, kind?: string) =>
      ({ status, activeOperation: kind ? { kind } : null }) as unknown as ServerView
    expect(presentStatus(as('stored'))).toEqual({
      pill: 'sleeping',
      detail: 'Resting while nobody plays. Joining wakes it, in a couple of minutes',
    })
    expect(presentStatus(as('storing')).pill).toBe('sleeping')
    expect(presentStatus(as('restoring', 'unstore'))).toMatchObject({
      pill: 'starting',
      detail: 'Restoring your world · a couple of minutes',
    })
    for (const status of ['stored', 'storing'])
      expect(presentStatus(as(status)).detail).not.toMatch(/inactive|expired|limit|upgrade|free plan/i)
  })
})

describe('presentStatus while a server wakes', () => {
  test('a wake says the step it is on, counting down from how long its last wake took', () => {
    const startedAt = '2026-10-11T03:00:33.000Z'
    const waking = (step: string, lastWakeSeconds: number | null) =>
      ({
        status: 'starting',
        lastWakeSeconds,
        activeOperation: { kind: 'start', step, status: 'running', createdAt: startedAt, startedAt },
      }) as unknown as ServerView
    const after = (seconds: number) => Date.parse(startedAt) + seconds * 1000
    expect(presentStatus(waking('booting', 68), after(10)).detail).toBe(
      'Waking the server · About a minute left',
    )
    expect(presentStatus(waking('loading_world', 68), after(50)).detail).toBe(
      'Loading the world · About 20 seconds left',
    )
    expect(presentStatus(waking('access', 68), after(66)).detail).toBe('Letting players in · Almost there')
    // One that never woke yet counts down from the measured median.
    expect(presentStatus(waking('booting', null), after(10)).detail).toBe(
      'Waking the server · About 35 seconds left',
    )
    expect(presentStatus(waking('booting', 68), after(120)).detail).toBe(
      'Waking the server · Taking a little longer than usual',
    )
  })

  test('a resume that turns into a boot counts down from a boot, not from its last resume', () => {
    const startedAt = '2026-10-11T03:00:33.000Z'
    const waking = (step: string) =>
      ({
        status: 'starting',
        lastWakeSeconds: 2,
        activeOperation: { kind: 'start', step, status: 'running', createdAt: startedAt, startedAt },
      }) as unknown as ServerView
    const after = (seconds: number) => Date.parse(startedAt) + seconds * 1000
    expect(presentStatus(waking('resuming'), after(1)).detail).toBe('Waking the server · Almost there')
    expect(presentStatus(waking('starting'), after(12)).detail).toBe(
      'Waking the server · About 35 seconds left',
    )
  })

  test('a failure says "Try again" only where trying again might do it', () => {
    const failed = (remedy: string | null) =>
      ({
        status: 'failed',
        stopReason: null,
        crash: null,
        failure: { during: 'provisioning', message: '', remedy },
      }) as unknown as ServerView
    expect(presentStatus(failed(null)).detail).toBe('We could not build your world. Try again')
    expect(presentStatus(failed('retry')).detail).toBe('We could not build your world. Try again')
    // Recognised, and not something a retry passes: the fix beside it is the way on.
    expect(presentStatus(failed('modpack')).detail).toBe('We could not build your world')
  })
})

describe('what a server runs', () => {
  test('a server type is shown with the build its configuration pins', () => {
    expect(loaderWithBuild('fabric', '0.19.5')).toBe('Fabric 0.19.5')
    expect(loaderWithBuild('paper', '125')).toBe('Paper build 125')
    expect(loaderWithBuild('neoforge', '26.2.0.88')).toBe('NeoForge 26.2.0.88')
    expect(loaderWithBuild('vanilla', null)).toBe('Vanilla')
    expect(loaderWithBuild('vanilla', '132')).toBe('Vanilla on Paper')
    expect(presentChange({ field: 'onPaper', from: true, to: false })).toBe('Runs on Paper on → off')
    // Where words can't take colour, the server message reads without its codes.
    expect(presentChange({ field: 'motd', from: 'Hello', to: '&d&lcubepals &8· &71.8 PvP' })).toBe(
      'Server message “Hello” → “cubepals · 1.8 PvP”',
    )
    expect(loaderWithBuild('fabric', null)).toBe('Fabric')
    expect(presentChange({ field: 'loaderVersion', from: '0.19.5', to: '0.19.6' })).toBe(
      'Build 0.19.5 → 0.19.6',
    )
  })

  test('files Cubepals wrote are listed like mods, by what they set up, and download nothing', () => {
    const files = {
      field: 'files' as const,
      added: ['OldCombatMechanics settings'],
      removed: [],
      changed: ['LifeStealZ settings'],
    }
    expect(presentChange(files)).toBe(
      'Set by Cubepals: added OldCombatMechanics settings; updated LifeStealZ settings',
    )
    expect(downloadOf([files])).toBeNull()
  })
})

describe('building a world', () => {
  const vanilla: Pick<ServerView, 'gameVersion' | 'modCount' | 'modpack'> = {
    gameVersion: '26.3',
    modCount: 0,
    modpack: null,
  }
  const at = (step: OperationView['step'], server = vanilla) =>
    presentProgress(
      {
        id: 'op',
        kind: 'provision',
        change: null,
        status: 'running',
        step,
        error: null,
        createdAt: '',
        startedAt: null,
      },
      server,
    )

  // Measured on a real provision: the download took most of the wait with nothing moving, and
  // "Generating the world" stood over all of it though the world itself took under two seconds.
  test('each step is what the server has actually reached', () => {
    expect(at('booting')?.steps.map((step) => [step.label, step.state])).toEqual([
      ['Picking a place', 'done'],
      ['Getting Minecraft 26.3', 'active'],
      ['Starting it up', 'todo'],
      ['Creating your world', 'todo'],
    ])
    expect(at('starting')?.index).toBe(2)
    expect(at('loading_world')?.index).toBe(3)
    expect(at('access')?.index).toBe(3)
    expect(at('booting', { gameVersion: '1.21.1', modCount: 12, modpack: null })?.steps[1]?.label).toBe(
      'Getting Minecraft 1.21.1 and its mods',
    )
    // A pack's mods are most of its wait: the step is the pack, by name.
    const pack = { gameVersion: '1.20.1', modCount: 0, modpack: betterMc }
    expect(at('booting', pack)?.steps[1]?.label).toBe('Downloading Better MC')
    // What the wait is said to be comes from how long it took, not a guess.
    expect(at('booting')?.expectedSeconds).toBe(100)
    expect(at('booting', pack)?.expectedSeconds).toBe(180)
  })

  test('while the server says nothing, the line says what it is doing', () => {
    expect(quietLine('booting', vanilla)).toBe('Setting up Minecraft 26.3')
    expect(quietLine('starting', vanilla)).toBe('Starting Minecraft 26.3')
    expect(quietLine(null, vanilla)).toBe('Getting started')
  })
})

describe('a change that downloads says what', () => {
  const mods = (added: string[], changed: string[] = []) => ({
    field: 'mods' as const,
    added,
    removed: [],
    changed,
  })
  test('its step names the mods, the Minecraft, the server type or the pack it brings', () => {
    expect(downloadOf([mods(['Lithium'])])).toBe('Downloading Lithium')
    expect(downloadOf([mods(['Lithium', 'FerriteCore'], ['Sodium'])])).toBe('Downloading 3 mods')
    expect(downloadOf([{ field: 'gameVersion', from: '26.3', to: '26.4' }])).toBe('Getting Minecraft 26.4')
    // A vanilla world's first mod moves it to Fabric: the loader and the mod come together.
    expect(downloadOf([{ field: 'loader', from: 'vanilla', to: 'fabric' }, mods(['Lithium'])])).toBe(
      'Getting Fabric and its mods',
    )
    expect(downloadOf([{ field: 'modpack', from: 'Better MC', to: 'Cobblemon Official' }])).toBe(
      'Downloading Cobblemon Official',
    )
  })

  test('a change to settings alone downloads nothing, and its step says what it does', () => {
    expect(downloadOf([{ field: 'motd', from: 'a', to: 'b' }])).toBeNull()
    const apply = presentProgress(
      {
        id: 'op',
        kind: 'apply',
        change: 'settings',
        status: 'running',
        step: 'booting',
        error: null,
        createdAt: '',
        startedAt: null,
      },
      { gameVersion: '26.3', modCount: 0, modpack: null },
      [{ field: 'motd', from: 'a', to: 'b' }],
    )
    expect(apply?.steps.map((step) => step.label)).toEqual([
      'Saving the world',
      'Setting up your changes',
      'Starting it up',
      'Loading the world',
      'Letting players in',
    ])
    expect(apply?.index).toBe(1)
  })
})

describe('a change says how long it takes', () => {
  const vanilla = { gameVersion: '26.3', modCount: 0, modpack: null }
  const applying = (change: ChangeKind | null) =>
    presentProgress(
      {
        id: 'op',
        kind: 'apply',
        change,
        status: 'running',
        step: 'queued',
        error: null,
        createdAt: '',
        startedAt: null,
      },
      vanilla,
    )?.expectedSeconds

  // Measured on staging: a pack update took nearly four minutes and settings under one, and a flat
  // 40 s counted down "35 seconds left" through most of the pack's.
  test('each kind of change has its own measured wait', () => {
    expect(applying('settings')).toBe(55)
    expect(applying('world')).toBe(140)
    expect(applying('mods')).toBe(160)
    expect(applying('version')).toBe(135)
    expect(applying('pack')).toBe(220)
    // One that doesn't say what it is waits as settings do.
    expect(applying(null)).toBe(55)
  })

  test('a pack update counts down in minutes, not seconds', () => {
    const at = Date.parse('2026-10-11T10:00:00Z')
    const wait = applying('pack') ?? 0
    expect(etaLine('2026-10-11T10:00:00Z', wait, at + MINUTE_MS)).toBe('A few minutes left')
    expect(etaLine('2026-10-11T10:00:00Z', wait, at + (wait - 30) * 1000)).toBe('About 30 seconds left')
  })
})

describe('joining a server that plays a pack', () => {
  test('a pack everyone installs is part of the game the line says to join with', () => {
    expect(joinLine('1.20.1', packToInstall({ modpack: betterMc }))).toBe(
      'In Minecraft: Java Edition 1.20.1 with Better MC installed, open Multiplayer → Add Server and paste it. Consoles and phones can’t join.',
    )
  })

  test('a pack the server runs alone asks nothing of players, and neither does plain Minecraft', () => {
    const alone = { modpack: { ...betterMc, environment: 'server' as const } }
    expect(packToInstall(alone)).toBeNull()
    expect(joinLine('1.20.1', packToInstall(alone))).toBe(joinLine('1.20.1'))
    expect(packToInstall({ modpack: null })).toBeNull()
  })
})

describe('joining an older server from newer Minecraft', () => {
  test('a server that carries ViaVersion says newer Minecraft joins, so nobody goes back a version', () => {
    expect(joinLine('1.21.11', null, { oldest: '1.21.11', newer: true })).toBe(
      'In Minecraft: Java Edition 1.21.11 or newer, open Multiplayer → Add Server and paste it. Consoles and phones can’t join.',
    )
  })
})

describe('the ways to play', () => {
  test('every picture a way to play names is drawn', () => {
    // A missing one is a broken image on the create page; scripts/play-icons.py draws them all.
    const publicDir = join(import.meta.dir, '../../public')
    for (const icon of PLAY_ICONS) expect(existsSync(join(publicDir, playIconSrc(icon)))).toBe(true)
  })
})
