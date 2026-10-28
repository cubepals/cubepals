// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Where a player hands over a world they have (docs/world-import.md): its folder dropped or
 * picked, or its zip, with where the game keeps its saves on their computer. A folder is looked at
 * and laid out as one file here (`lib/world-folder.ts`), and the wrong thing is said before
 * anything is sent. What becomes of the file is the page's: the world page sends it to a server,
 * the create page to the server it makes.
 */
import { FolderOpen, Upload } from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { droppedFrom, lookAt, lookInZip, type PickedFile, pickedFrom, tarOf } from '../../lib/world-folder'
import { Button, CopyField, FileButton, ICON, Note } from '../../ui'

/** What a world upload takes: a zip of its folder, or a tarball as a server download comes. */
export const WORLD_FILES = '.zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-tar'

/** The most a world upload can be, as the control plane takes one. */
const MOST_BYTES = 4 * 1024 ** 3

const SAID = {
  nothing:
    'There’s no world in this folder. Choose the world’s own folder, the one with level.dat in it, inside the saves folder.',
  bedrock:
    'This is a Bedrock world. A Cubepals server plays Java worlds, which Bedrock players join too, and can’t open a Bedrock save.',
  empty: 'This folder is empty.',
  tooLarge: 'This world is larger than 4 GB, more than an upload takes.',
}

/** Where Minecraft keeps single-player worlds on the system this browser runs on, if it says. */
function savesHere(): { system: string; path: string } | null {
  if (typeof navigator === 'undefined') return null
  const agent = navigator.userAgent
  if (/Windows/.test(agent)) return { system: 'Windows', path: '%APPDATA%\\.minecraft\\saves' }
  if (/Mac OS X/.test(agent) && !/iPhone|iPad/.test(agent))
    return { system: 'macOS', path: '~/Library/Application Support/minecraft/saves' }
  if (/Linux/.test(agent) && !/Android/.test(agent)) return { system: 'Linux', path: '~/.minecraft/saves' }
  return null
}

export function WorldDrop({
  disabled,
  onFile,
}: {
  disabled?: boolean
  /** The world as one file, looked at as far as the browser can: its zip, or its folder laid out. */
  onFile: (file: File) => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const folderInput = useRef<HTMLInputElement>(null)
  const saves = savesHere()

  const takeFolder = (files: PickedFile[]) => {
    const look = lookAt(files)
    if (look.kind !== 'world') return setProblem(SAID[look.kind])
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
    const items = event.dataTransfer.items
    const only = event.dataTransfer.files[0]
    const isFolder = [...items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)
    if (!isFolder && only !== undefined) return void take(only)
    takeFolder(await droppedFrom(items))
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
              const picked = event.target.files
              event.target.value = ''
              setProblem(null)
              // An empty folder comes as no files at all, which is said as such.
              if (picked) takeFolder(pickedFrom(picked))
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
      {saves && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <span className="type-body-sm">On {saves.system}, Minecraft keeps single-player worlds in</span>
          <CopyField value={saves.path} label="Copy" />
        </div>
      )}
      {problem && <Note tone="danger">{problem}</Note>}
    </div>
  )
}
