// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** chosen-files.ts against lists that empty as a browser's do. */
import { describe, expect, test } from 'bun:test'
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
