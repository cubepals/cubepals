// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Where a player hands over a world they have (docs/world-import.md): its folder dropped or
 * picked, or its zip, with where their launcher keeps its saves on their computer (`saves-folder.tsx`). A folder is looked at
 * and laid out as one file here (`lib/world-folder.ts`), and the wrong thing is said before
 * anything is sent. What becomes of the file is the page's: the world page sends it to a server,
 * taking a folder as its files to send the part of an instance that is the world and its mods,
 * and the create page sends it to the server it makes.
 */
import { FolderOpen, Upload } from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { chosenFiles, droppedEntries, droppedFiles } from '../../lib/chosen-files'
import { droppedFrom, lookAt, lookInZip, type PickedFile, pickedFrom, tarOf } from '../../lib/world-folder'
import { Button, FileButton, ICON, Note } from '../../ui'
import { SavesFolder } from './saves-folder'

/** What a world upload takes: a zip of its folder, or a tarball as a server download comes. */
export const WORLD_FILES = '.zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-tar'

/** The most a world upload can be, as the control plane takes one. */
export const MOST_BYTES = 4 * 1024 ** 3

const SAID = {
  nothing:
    'There’s no world in this folder. Choose the world’s own folder, the one with level.dat in it, inside the saves folder.',
  bedrock:
    'This is a Bedrock world. A Cubepals server plays Java worlds, which Bedrock players join too, and can’t open a Bedrock save.',
  empty: 'This folder is empty.',
  tooLarge: 'This world is larger than 4 GB, more than an upload takes.',
}

/** What is said of a world larger than an upload takes. */
export const TOO_LARGE = SAID.tooLarge

export function WorldDrop({
  disabled,
  onFile,
  onFolder,
}: {
  disabled?: boolean
  /** The world as one file, looked at as far as the browser can: its zip, or its folder laid out. */
  onFile: (file: File) => void
  /**
   * Where given, a folder holding a world is handed over as its files instead, for a page that
   * sends only part of it, as a launcher's instance's world and its mods (`lib/brought-files.ts`):
   * what it sends is the page's to lay out, and to size.
   */
  onFolder?: (files: PickedFile[]) => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const folderInput = useRef<HTMLInputElement>(null)

  const takeFolder = (files: PickedFile[]) => {
    const look = lookAt(files)
    if (look.kind !== 'world') return setProblem(SAID[look.kind])
    if (onFolder) return onFolder(files)
    // What is sent is the tarball, its headers and padding included, known before anything is read.
    const tarball = tarOf(files)
    if (tarball.size > MOST_BYTES) return setProblem(SAID.tooLarge)
    const name = files[0]?.path.split('/')[0] || 'world'
    onFile(new File([tarball], `${name}.tar`, { type: 'application/x-tar' }))
  }
  const take = async (picked: File) => {
    setProblem(null)
    // A zip is looked into first: the wrong one is said at once, not after it is sent.
    const look = /\.zip$/i.test(picked.name) ? await lookInZip(picked) : null
    if (look !== null && look.kind !== 'world') return setProblem(SAID[look.kind])
    if (picked.size > MOST_BYTES) return setProblem(SAID.tooLarge)
    onFile(picked)
  }
  const drop = async (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    setProblem(null)
    if (disabled) return
    // Taken before the walk awaits anything: a drop's lists are empty once its event is over.
    const [only] = droppedFiles(event)
    const entries = droppedEntries(event)
    const isFolder = entries.some((entry) => entry.isDirectory)
    if (!isFolder && only !== undefined) return void take(only)
    takeFolder(await droppedFrom(entries))
  }

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the buttons inside are how a keyboard picks one */}
      <div
        className="bk-drop"
        data-over={over || undefined}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => void drop(event)}
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Drop the world’s folder here, or its zip. Close it in Minecraft first.
        </p>
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          <input
            ref={folderInput}
            type="file"
            className="bk-visually-hidden"
            tabIndex={-1}
            aria-hidden
            multiple
            {...{ webkitdirectory: '' }}
            onChange={(event) => {
              const picked = chosenFiles(event)
              setProblem(null)
              // An empty folder comes as no files at all, which is said as such.
              takeFolder(pickedFrom(picked))
            }}
          />
          <Button
            variant="outline"
            icon={<FolderOpen {...ICON} aria-hidden />}
            disabled={disabled}
            onClick={() => folderInput.current?.click()}
          >
            Choose a folder
          </Button>
          <FileButton
            accept={WORLD_FILES}
            icon={<Upload {...ICON} aria-hidden />}
            disabled={disabled}
            onFile={(picked) => void take(picked)}
          >
            Choose a zip
          </FileButton>
        </div>
      </div>
      <SavesFolder />
      {problem && <Note tone="danger">{problem}</Note>}
    </div>
  )
}
