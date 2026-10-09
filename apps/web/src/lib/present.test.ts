import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type OperationView, PLAY_ICONS, type ServerView } from '@blockly/contracts'
import {
  downloadOf,
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

    expect(presentStatus(stopped('policy')).pill).toBe('suspended')
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

  test('a server type is shown with the build its configuration pins', () => {
    expect(loaderWithBuild('fabric', '0.19.5')).toBe('Fabric 0.19.5')
    expect(loaderWithBuild('paper', '125')).toBe('Paper build 125')
    expect(loaderWithBuild('neoforge', '26.2.0.88')).toBe('NeoForge 26.2.0.88')
    expect(loaderWithBuild('vanilla', null)).toBe('Vanilla')
    expect(loaderWithBuild('vanilla', '132')).toBe('Vanilla on Paper')
    expect(presentChange({ field: 'onPaper', from: true, to: false })).toBe('Runs on Paper on → off')
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
      { id: 'op', kind: 'provision', status: 'running', step, error: null, createdAt: '', startedAt: null },
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

describe('the ways to play', () => {
  test('every picture a way to play names is drawn', () => {
    // A missing one is a broken image on the create page; scripts/play-icons.py draws them all.
    const publicDir = join(import.meta.dir, '../../public')
    for (const icon of PLAY_ICONS) expect(existsSync(join(publicDir, playIconSrc(icon)))).toBe(true)
  })
})
