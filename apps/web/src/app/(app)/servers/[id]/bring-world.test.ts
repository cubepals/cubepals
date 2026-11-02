// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Upload, worker progress and Play through the real React hooks, browser events and tRPC router. */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ServerView, WorldImportView } from '@blockly/contracts'
import { answered } from '@blockly/control/testing/answered'
import { refusing } from '@blockly/control/testing/refusing'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { ApiProvider } from '../../../../lib/api'
import { type Brought, broughtFrom } from '../../../../lib/brought-files'
import { BringWorld } from './bring-world'

const id = crypto.randomUUID()
const importId = crypto.randomUUID()
const view = {
  id,
  gameVersion: '26.3',
  status: 'stopped',
  modCount: 0,
  modpack: null,
  activeOperation: null,
} as ServerView
const world = { name: 'Life', levelName: 'world-4', icon: null, gameVersion: '26.3', newer: null }
const ready = (): Extract<WorldImportView, { status: 'ready' }> => ({
  status: 'ready',
  fileName: 'Life.tar',
  importId,
  backupId: crypto.randomUUID(),
  world,
  notes: [],
  playedWith: null,
  people: null,
})
let state: WorldImportView = ready()
let chosen: Brought = { kind: 'file', file: new File(['a world'], 'Life.tar') }
let failure: string | null = null
let root: Root | undefined
let queries: QueryClient
let host: HTMLElement
const quality = createRequire(new URL('../../../../../../../tools/quality/package.json', import.meta.url))
let window: ReturnType<typeof quality>
let original: Map<string, unknown>
let calls: Array<{ service: string; method: string; args: unknown[] }> = []
let closed = 0
const realFetch = globalThis.fetch
let endpoint: ReturnType<typeof Bun.serve>

beforeAll(() => {
  window = new (quality('happy-dom').Window)({ url: 'http://localhost:3000' })
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'HTMLDialogElement',
    'MutationObserver',
    'XMLHttpRequest',
  ]
  original = new Map(keys.map((key) => [key, Reflect.get(globalThis, key)]))
  for (const key of keys) Reflect.set(globalThis, key, key === 'window' ? window : Reflect.get(window, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  window.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  window.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
  endpoint = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS' },
      }),
  })
  const answer = answered((service, method, args) => {
    calls.push({ service, method, args })
    if (method === 'beginWorldUpload')
      return { ticket: crypto.randomUUID(), url: `http://127.0.0.1:${endpoint.port}/upload`, headers: {} }
    if (method === 'finishWorldUpload') return { importId }
    if (method === 'imports.answer') {
      state = ready()
      return state
    }
    if (method === 'imports.view') return state
    if (method === 'get') return view
    return state
  })
  const refusal = refusing('invalid_choice', 'The check could not finish. Try again.')
  globalThis.fetch = ((input, init) => {
    const url = new URL(String(input), 'http://localhost:3000')
    if (!url.pathname.includes('/api/trpc')) return realFetch(input, init)
    return failure !== null && url.pathname.includes(failure) ? refusal(url, init) : answer(url, init)
  }) as typeof fetch

  window.fetch = globalThis.fetch as unknown as typeof window.fetch
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  calls = []
  closed = 0
  failure = null
  chosen = { kind: 'file', file: new File(['a world'], 'Life.tar') }
  view.modCount = 0
  view.gameVersion = '26.3'
  view.status = 'stopped'
})
afterAll(async () => {
  endpoint.stop(true)
  globalThis.fetch = realFetch
  for (const [key, value] of original) Reflect.set(globalThis, key, value)
  await window.happyDOM.close()
})

function Scene() {
  queries = useQueryClient()
  return createElement(BringWorld, {
    view,
    brought: chosen,
    onClose: () => {
      closed++
    },
  })
}
async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host)
  await act(async () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement with a required children property.
    root?.render(createElement(ApiProvider, { children: createElement(Scene) }))
  })
}
const text = () => document.body.textContent ?? ''
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label))
  if (!found) throw new Error(`Missing ${label}: ${text()}`)
  return found
}
async function click(label: string) {
  await act(async () => {
    button(label).click()
  })
}
async function until(test: () => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    if (test()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  throw new Error(`Screen did not settle (${calls.map((call) => call.method).join(',')}): ${text()}`)
}

test('an uploaded world shows its real stage and bytes, then plays the kept backup', async () => {
  state = {
    status: 'reading',
    fileName: 'Life.tar',
    importId,
    progress: {
      step: 'fetching',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bytes: 5 * 1024 ** 2,
      totalBytes: 10 * 1024 ** 2,
      steps: [],
    },
  }
  await mount()
  await click('Upload')
  await until(() => text().includes('Fetching your uploaded world'))
  expect(text()).toContain('5 MB of 10 MB')
  expect(text()).toContain('Fetching your uploaded world: your world.')
  expect(text()).toMatch(/\d+s elapsed/)
  expect(text()).not.toContain('NaN')
  state = ready()
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => text().includes('Life is ready'))
  await click('Play Life')
  await until(() => closed === 1)
  const restoration = calls.find((call) => call.method === 'restoreBackup')
  expect(restoration?.args[2]).toBe(state.backupId)
  expect(restoration?.args[4]).toMatchObject({ withConfiguration: false })
})

test('a refusal stays visible and Cancel closes an unsent world', async () => {
  state = { status: 'refused', fileName: 'Life.tar', importId, message: 'The world cannot be read.' }
  await mount()
  await click('Cancel')
  expect(closed).toBe(1)
})

async function show(next: WorldImportView) {
  state = next
  await mount()
  await click('Upload')
  await until(() => calls.some((call) => call.method === 'imports.view'))
}

test('questions are answered before Play, and a server’s old players are let in only by choice', async () => {
  await show({
    status: 'asking',
    fileName: 'Life.tar',
    importId,
    worlds: [{ folder: 'Life/', name: 'Life', gameVersion: '26.3' }],
    player: false,
    problem: null,
  })
  await until(() => text().includes('Which one do you want?'))
  await click('Bring this one')
  await until(() => text().includes('Life is ready'))
  expect(calls.find((call) => call.method === 'imports.answer')?.args[3]).toEqual({ folder: 'Life/' })
  state = {
    ...ready(),
    people: {
      whitelistOn: true,
      whitelist: [{ name: 'Alex', uuid: crypto.randomUUID() }],
      operators: [],
      bans: [],
      unknown: [],
    },
  }
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => text().includes('Who can join'))
  expect(button('Let them in').disabled).toBe(true)
  await click('Let everyone in')
  await click('Let them in')
  await until(() => text().includes('Done. They’re on this server’s players page.'))
})

test('reading cannot be dismissed, and a removed backup cannot be played', async () => {
  await show({ status: 'reading', importId, fileName: 'Life.tar', progress: null })
  await until(() => text().includes('Waiting to prepare your world'))
  await act(async () => {
    document.querySelector('dialog')?.click()
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
  expect(closed).toBe(0)
  state = { ...ready(), world: null }
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => text().includes('no longer in Backups'))
  expect(document.body.textContent).not.toContain('Play Life')
})

test('a newer modded world explains its move and a refused Play retains the world', async () => {
  view.gameVersion = '26.2'
  view.modCount = 1
  await show({
    ...ready(),
    notes: ['Its folder is world-4.'],
    world: { ...world, newer: { gameVersion: '26.3', movesServer: false } },
  })
  await until(() => text().includes('Settings'))
  expect(button('Play Life').disabled).toBe(true)
  view.modCount = 0
  state = { ...ready(), world: { ...world, newer: { gameVersion: '26.3', movesServer: true } } }
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => !button('Play Life').disabled)
  failure = 'backups.restore'
  await click('Play Life')
  await until(() => text().includes('The check could not finish.'))
  expect(closed).toBe(0)
})

const saved = (path: string) =>
  new File(
    [readFileSync(new URL(`../../../../../../control/src/minecraft/${path}`, import.meta.url))],
    'level.dat',
  )
const held = (path: string, file: File) => ({ path, file })

test('choosing another world of a launcher instance updates what will be sent', async () => {
  const level = saved('player-fixtures/26.3/level.dat')
  chosen = broughtFrom([
    held('Prism/.minecraft/saves/Life/level.dat', level),
    held('Prism/.minecraft/saves/Second/level.dat', level),
    held('Prism/.minecraft/mods/zoomify.jar', new File(['jar'], 'zoomify.jar')),
  ])
  await mount()
  await until(() => document.querySelector('select') !== null)
  const select = document.querySelector('select')
  if (!select) throw new Error('An instance with two worlds must ask which one')
  await act(async () => {
    select.value = 'Prism/.minecraft/saves/Second/'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  expect(text()).toContain('Second')
  await click('Upload')
  await until(() => calls.some((call) => call.method === 'finishWorldUpload'))
  await until(() => text().includes('Life is ready'))
})

async function pickMods(files: Array<{ path: string; file: File }>) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error(`Missing mod folder picker: ${text()}`)
  const picked = files.map(({ path, file }) => {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
    return file
  })
  Object.defineProperty(input, 'files', { value: picked, configurable: true })
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

test('a modded world asks for its companions, accepts their folder and can leave them out again', async () => {
  chosen = broughtFrom([held('Life/level.dat', saved('player-fixtures/26.3/level.dat'))])
  await mount()
  await until(() => text().includes('Add the instance'))
  await pickMods([held('empty/readme.txt', new File(['empty'], 'readme.txt'))])
  expect(text()).toContain('mods')
  await pickMods([held('mods/lithium.jar', new File(['jar'], 'lithium.jar'))])
  await until(() => text().includes('Leave them out'))
  await click('Leave them out')
  expect(text()).toContain('Add the instance')
  const name = document.querySelector<HTMLInputElement>('input[maxlength="40"]')
  if (!name) throw new Error('The world must offer an optional name')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(name, 'Our Life')
    name.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  state = { status: 'refused', fileName: 'Life.tar', importId, message: 'The world cannot be read.' }
  await click('Upload without its mods')
  await until(() => text().includes('The world cannot be read.'))
  await click('Close')
  expect(closed).toBe(1)
})

test('a ready world can be sent again from its instance when its mods were missing', async () => {
  view.loader = 'vanilla'
  await show({ ...ready(), playedWith: { moddedWith: ['fabric'], mods: null } })
  await until(() => document.querySelector('select') !== null)
  const launcher = document.querySelector('select')
  if (!launcher) throw new Error('The launcher must be selectable')
  await act(async () => {
    launcher.value = 'prism'
    launcher.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await until(() => document.querySelector('input[type="file"]') !== null)
  await pickMods([held('empty/readme.txt', new File(['empty'], 'readme.txt'))])
  await pickMods([
    held('Prism/.minecraft/saves/Life/level.dat', saved('player-fixtures/26.3/level.dat')),
    held('Prism/.minecraft/mods/lithium.jar', new File(['jar'], 'lithium.jar')),
  ])
  await until(() => calls.filter((call) => call.method === 'beginWorldUpload').length === 2)
  await until(() => calls.filter((call) => call.method === 'finishWorldUpload').length === 2)
  await until(() => text().includes('Life is ready'))
})

test('an imported world waits for real mod proof and temporary failures remain visible until verified', async () => {
  const check = { key: 'check', state: 'checking' as const, message: null, checkedAt: null }
  await show({ ...ready(), compatibility: check })
  await until(() => text().includes('Life is imported'))
  expect(button('Play Life').disabled).toBe(true)
  expect(text()).toContain('testing the server’s mods together')
  state = {
    ...ready(),
    compatibility: { ...check, state: 'unavailable', message: 'The check will be retried.' },
  }
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => text().includes('The check will be retried.'))
  expect(button('Play Life').disabled).toBe(true)
  state = { ...ready(), compatibility: { ...check, state: 'verified', checkedAt: new Date().toISOString() } }
  await act(async () => {
    await queries.invalidateQueries()
  })
  await until(() => text().includes('Life is ready'))
  expect(button('Play Life').disabled).toBe(false)
})

test('a loader conflict keeps the imported world and explains why Play is unavailable', async () => {
  await show({
    ...ready(),
    compatibility: {
      key: 'check',
      state: 'blocked',
      message: 'A required server library is missing.',
      checkedAt: new Date().toISOString(),
    },
  })
  await until(() => text().includes('A required server library is missing.'))
  expect(text()).toContain('Life is imported')
  expect(button('Play Life').disabled).toBe(true)
  await click('Not now')
  expect(closed).toBe(1)
})
