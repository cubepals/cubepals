// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * chosen-files.ts against lists that empty as a browser's do, and the lint rule that holds the
 * site to it (`apps/web/live-file-lists.grit`) against small trees: a live list read anywhere but
 * there fails, by file and line, the way the folder picker once read one; the copied way passes.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chosenFiles, droppedEntries, droppedFiles } from './chosen-files'

const file = (name: string) => new File(['x'], name)

/** An input as Chrome has one: its `files` the same list each time, emptied when it is cleared. */
function input(files: File[]) {
  const live = [...files]
  return {
    get files() {
      return live as unknown as FileList
    },
    get value() {
      return live.length === 0 ? '' : `C:\\fakepath\\${live[0]?.name}`
    },
    set value(to: string) {
      if (to === '') live.length = 0
    },
  } as HTMLInputElement
}

/** A drop's lists, emptied once its event is over, as every browser does. */
function transfer(files: File[], folders: string[]) {
  const live = { files: [...files], items: [...files.map(() => false), ...folders.map(() => true)] }
  const entry = (isDirectory: boolean, i: number) => ({ isDirectory, name: `entry ${i}` })
  const dataTransfer = {
    get files() {
      return live.files as unknown as FileList
    },
    get items() {
      return live.items.map((isDirectory, i) => ({
        webkitGetAsEntry: () => entry(isDirectory, i),
      })) as unknown as DataTransferItemList
    },
  } as DataTransfer
  return {
    dataTransfer,
    over: () => {
      live.files = []
      live.items = []
    },
  }
}

describe('the files a player chose', () => {
  test('are kept after the input is cleared, which empties its own list', () => {
    const picker = input([file('level.dat'), file('r.0.0.mca')])
    const chosen = chosenFiles({ currentTarget: picker })
    expect(chosen.map((f) => f.name)).toEqual(['level.dat', 'r.0.0.mca'])
    expect(picker.value).toBe('')
    expect(picker.files?.length).toBe(0)
  })

  test('are none when nothing was chosen', () => {
    expect(chosenFiles({ currentTarget: input([]) })).toEqual([])
  })
})

describe('what a drop held', () => {
  test('is kept after its event is over, folders as entries to walk', () => {
    const drop = transfer([file('world.zip')], ['My World'])
    const [files, entries] = [droppedFiles(drop), droppedEntries(drop)]
    drop.over()
    expect(files.map((f) => f.name)).toEqual(['world.zip'])
    expect(entries.map((entry) => entry.isDirectory)).toEqual([false, true])
  })

  test('is nothing when the drop carried no data', () => {
    expect(droppedFiles({ dataTransfer: null })).toEqual([])
    expect(droppedEntries({ dataTransfer: null })).toEqual([])
  })
})

const ROOT = resolve(import.meta.dir, '../../../..')
const RULE = 'apps/web/live-file-lists.grit'
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A git checkout holding `files`, with the repository's biome.json and its rule. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-files-'))
  made.push(dir)
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  for (const path of ['biome.json', RULE]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(ROOT, path), join(dir, path))
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

/** Each place the rule points at, as `file:line`, and the message it gives. */
function lint(dir: string) {
  const run = Bun.spawnSync(
    [join(ROOT, 'node_modules/.bin/biome'), 'lint', '--reporter=json', '--max-diagnostics=none', '.'],
    { cwd: dir, stderr: 'pipe' },
  )
  type Diagnostic = { category: string; message: string; location: { path: string; start: { line: number } } }
  const found = (JSON.parse(run.stdout.toString()).diagnostics as Diagnostic[]).filter(
    (d) => d.category === 'plugin',
  )
  return {
    at: found.map((d) => `${d.location.path}:${d.location.start.line}`),
    messages: [...new Set(found.map((d) => d.message))],
  }
}

/** The folder picker's change as it was when every folder picked in Chrome came back empty. */
const FOLDER_PICKER = `/** The folder picker, as it was. */
export const onChange = (event: { target: HTMLInputElement }, takeFolder: (files: File[]) => void) => {
  const picked = event.target.files
  event.target.value = ''
  if (picked) takeFolder([...picked])
}
`

describe('a live file list read outside chosen-files.ts', () => {
  test('fails at the line the folder picker read it, saying what to use', () => {
    const { at, messages } = lint(tree({ 'apps/web/src/app/world-drop.tsx': FOLDER_PICKER }))
    expect(at).toEqual(['apps/web/src/app/world-drop.tsx:3'])
    expect(messages).toEqual([
      'This reads a live file list, which is empty once its input is cleared or its drop is over. Take the files with chosenFiles, droppedFiles or droppedEntries from apps/web/src/lib/chosen-files.ts.',
    ])
  })

  test('fails however the list is reached: a ref, a drop, a cast, a destructuring', () => {
    const reads = `/** Reads. */
export function reads(ref: { current: HTMLInputElement }, event: DragEvent, target: EventTarget) {
  const one = ref.current?.files?.[0]
  const items = event.dataTransfer?.items
  const dropped = event.dataTransfer?.files
  const cast = (target as HTMLInputElement).files
  const { files } = ref.current
  const { files: renamed } = target as HTMLInputElement
  return [one, items, dropped, cast, files, renamed]
}
`
    const { at } = lint(tree({ 'apps/web/src/reads.ts': reads }))
    expect(at).toEqual([3, 4, 5, 6, 7, 8].map((line) => `apps/web/src/reads.ts:${line}`))
  })

  test('passes taken through chosen-files.ts, in a string or a comment, and outside the site', () => {
    const helper = `/** The one reader. */
export const chosen = (input: HTMLInputElement) => [...(input.files ?? [])]
`
    const copied = `/** The folder picker, as it is. */
import { chosenFiles } from '../lib/chosen-files'
// Not event.target.files: it empties.
export const onChange = (event: { currentTarget: HTMLInputElement }) => chosenFiles(event)
export const said = 'event.target.files'
`
    const elsewhere = `/** A pack's manifest. */
export const listed = (manifest: { files: string[] }) => manifest.files
`
    const ignored = `/** A pack's manifest, in the site. */
export const listed = (manifest: { files: string[] }) =>
  // biome-ignore lint/plugin: a pack manifest's list of paths, not a browser's
  manifest.files
`
    const { at } = lint(
      tree({
        'apps/web/src/lib/chosen-files.ts': helper,
        'apps/web/src/app/world-drop.tsx': copied,
        'apps/web/src/app/manifest.ts': ignored,
        'apps/control/src/manifest.ts': elsewhere,
      }),
    )
    expect(at).toEqual([])
  })
})
