// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The mods a world brought to a server was played with, in "Bring a world" (docs/world-import.md
 * § Mods): asked for before it is sent, where its `level.dat` says mods opened it and none are with
 * it, as the instance it was played in, where the player's launcher keeps one (`useLauncher`); an
 * instance picked whole, and which of its worlds; and once it is read, what comes with it and what
 * was left out, or, where they didn't come, the same ask again. What is sent is
 * `lib/brought-files.ts`'s, the words `bring-world-lines.ts`'s, and the rest of the dialog
 * `bring-world.tsx`'s.
 */
import type { PlayedWith, ServerView } from '@blockly/contracts'
import { FolderOpen } from 'lucide-react'
import { useRef, useState } from 'react'
import { type AddedMods, folderName, type NotAdded } from '../../../../lib/brought-files'
import { chosenFiles } from '../../../../lib/chosen-files'
import { instancePickOn, modsFolderOn, type PickedInstance } from '../../../../lib/instance-folders'
import { type PickedFile, pickedFrom } from '../../../../lib/world-folder'
import { Button, CopyField, ICON, Note, Select } from '../../../../ui'
import { LauncherSelect, useLauncher } from '../../saves-folder'
import { BroughtNotes } from '../../world-questions'
import {
  ADD_INSTANCE_LINE,
  addedLine,
  againLine,
  instanceLine,
  leftOutLines,
  modsLine,
  noModsLine,
  notAddedLine,
  playedWithLine,
  WHICH_WORLD_LINE,
  ZIP_WITHOUT_INSTANCE_LINE,
} from './bring-world-lines'

/** A folder picked for the world's mods, taken by the dialog, or why it can't give them. */
type OnPicked = (files: PickedFile[]) => NotAdded | null

/**
 * Where the player's launcher keeps the folder to pick for a world's mods, and the press that picks
 * it: an instance, its mods folder, or the game's own mods folder. A world that came as a zip is
 * taken from its instance (`withPicked`), so only an instance is asked for; with a launcher without
 * instances, its folder is, in place of the zip.
 */
function WhereMods({ zip, disabled, onPicked }: { zip: boolean; disabled?: boolean; onPicked: OnPicked }) {
  const { system, picked, launcher, pick } = useLauncher()
  if (system === null) return null
  const instance = launcher === undefined ? null : instancePickOn(launcher, system)
  const mods = launcher === undefined ? null : modsFolderOn(launcher, system)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <LauncherSelect picked={picked} onPick={pick} />
      {launcher === undefined && (
        <span className="type-body-sm">
          Open the instance you played from your launcher, usually with Open folder, and choose that folder.
        </span>
      )}
      {launcher !== undefined && instance !== null && (
        <>
          <span className="type-body-sm">
            On {system}, {launcher.said} keeps each instance in its own folder in
          </span>
          <CopyField value={instance.instances} label="Copy" />
          <span className="type-body-sm">
            {zip ? (
              'Choose the instance you played.'
            ) : (
              <>
                Choose the instance you played, or its <code>{instance.mods}</code> folder.
              </>
            )}
          </span>
        </>
      )}
      {launcher !== undefined && mods !== null && (
        <>
          <span className="type-body-sm">
            On {system}, {launcher.said} keeps the mods a loader runs in
          </span>
          <CopyField value={mods} label="Copy" />
          {zip && <span className="type-body-sm">{ZIP_WITHOUT_INSTANCE_LINE}</span>}
        </>
      )}
      {!(zip && mods !== null) && <PickMods disabled={disabled} onPicked={onPicked} />}
    </div>
  )
}

/** The one press that picks the folder a world's mods are in, and why one picked can't give them. */
function PickMods({ disabled, onPicked }: { disabled?: boolean; onPicked: OnPicked }) {
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<NotAdded | null>(null)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <input
        ref={input}
        type="file"
        className="bk-visually-hidden"
        tabIndex={-1}
        aria-hidden
        multiple
        {...{ webkitdirectory: '' }}
        onChange={(event) => setProblem(onPicked(pickedFrom(chosenFiles(event))))}
      />
      <div>
        <Button
          variant="secondary"
          icon={<FolderOpen {...ICON} aria-hidden />}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          Add the instance
        </Button>
      </div>
      {problem && <Note tone="danger">{notAddedLine(problem)}</Note>}
    </div>
  )
}

/**
 * Before it is sent, a world played with mods that aren't with it: what it was played with, and
 * the instance to add so they come. Once added, how many come, and a way to leave them out again.
 */
export function ModsOffer({
  moddedWith,
  added,
  zip,
  onPicked,
  onLeaveOut,
}: {
  moddedWith: readonly string[]
  added: AddedMods | null
  /** The world came as a file: its instance is asked for, not a mods folder (`withPicked`). */
  zip: boolean
  onPicked: OnPicked
  onLeaveOut: () => void
}) {
  if (added !== null)
    return (
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', alignItems: 'center' }}>
        <Note tone="success">{addedLine(added)}</Note>
        <Button variant="ghost" size="sm" onClick={onLeaveOut}>
          Leave them out
        </Button>
      </div>
    )
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <Note tone="info">
        {playedWithLine(moddedWith)} {ADD_INSTANCE_LINE}
      </Note>
      <WhereMods zip={zip} onPicked={onPicked} />
    </div>
  )
}

/** A launcher's instance picked whole: what of it is sent, and which world, where it holds more than one. */
export function InstancePicked({
  instance,
  mods,
  world,
  onWorld,
}: {
  instance: PickedInstance
  /** The jars in its mods folder. */
  mods: number
  world: string | null
  onWorld: (world: string) => void
}) {
  return (
    <>
      <p>{instanceLine(folderName(instance.root || instance.game), mods)}</p>
      {instance.worlds.length > 1 && (
        <Select
          label={WHICH_WORLD_LINE}
          value={world ?? ''}
          onChange={(event) => onWorld(event.target.value)}
          options={[
            { value: '', label: 'Choose a world', disabled: true },
            ...instance.worlds.map((each) => ({ value: each, label: folderName(each) })),
          ]}
        />
      )}
    </>
  )
}

/**
 * Once it is read, what it was played with: the mods that come and what playing it does to the
 * server, then those left out and why. Where they didn't come, the instance is asked for again, and
 * the world goes up again with them (`onPicked`).
 */
export function PlayedWithMods({
  playedWith,
  view,
  name,
  zip,
  busy,
  onPicked,
}: {
  playedWith: PlayedWith
  view: ServerView
  name: string
  /** The world came as a file: its instance is asked for, not a mods folder (`withPicked`). */
  zip: boolean
  /** It is being played: nothing is sent again. */
  busy: boolean
  onPicked: OnPicked
}) {
  const coming = modsLine(playedWith, view.loader)
  if (coming !== null)
    return (
      <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
        <Note tone="info">{coming}</Note>
        <BroughtNotes notes={leftOutLines(playedWith)} />
      </div>
    )
  const missing = noModsLine(playedWith, name)
  if (missing === null) return null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <Note tone="info">
        {missing} {againLine(name)}
      </Note>
      <WhereMods zip={zip} disabled={busy} onPicked={onPicked} />
    </div>
  )
}
