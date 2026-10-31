// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Where to find a world to drop (`world-drop.tsx`): the folder the player's launcher keeps it in,
 * on the system their browser runs on, to copy. The Minecraft Launcher is taken until they pick
 * another, and the pick is remembered on this browser (`useLauncher`, by which the mods a world
 * was played with are asked for too). The folders are `lib/saves-folders.ts`'s.
 */
import { useEffect, useState } from 'react'
import {
  DEFAULT_LAUNCHER,
  inInstanceOn,
  LAUNCHERS,
  type Launcher,
  type System,
  systemOf,
} from '../../lib/saves-folders'
import { CopyField, Select } from '../../ui'

/** The pick another launcher stands for: one whose folders aren't listed. */
const ANOTHER = 'another'
/** Where the pick is remembered on this browser. */
const REMEMBERED = 'blockly.launcher'

const remembered = (): string | null => {
  try {
    return localStorage.getItem(REMEMBERED)
  } catch {
    return null
  }
}

const remember = (launcher: string) => {
  try {
    localStorage.setItem(REMEMBERED, launcher)
  } catch {
    // Storage can be off, as in a private window: the pick then lasts the page.
  }
}

/** The launcher the player picked, remembered on this browser, and the system it runs on: null until mounted. */
export function useLauncher(): {
  system: System | null
  picked: string
  /** The launcher picked; undefined for another launcher, whose folders aren't listed. */
  launcher: Launcher | undefined
  pick: (launcher: string) => void
} {
  // Read once mounted: the server knows neither the system nor what this browser remembers.
  const [system, setSystem] = useState<System | null>(null)
  const [picked, setPicked] = useState(DEFAULT_LAUNCHER)
  useEffect(() => {
    setSystem(systemOf(navigator.userAgent))
    const kept = remembered()
    if (kept !== null && (kept === ANOTHER || LAUNCHERS.some((l) => l.id === kept))) setPicked(kept)
  }, [])
  const pick = (launcher: string) => {
    setPicked(launcher)
    remember(launcher)
  }
  return { system, picked, launcher: LAUNCHERS.find((l) => l.id === picked), pick }
}

/** Which launcher the player plays on: one of those whose folders are known, or another. */
export function LauncherSelect({ picked, onPick }: { picked: string; onPick: (launcher: string) => void }) {
  return (
    <div style={{ maxWidth: 280 }}>
      <Select
        label="Your launcher"
        value={picked}
        onChange={(event) => onPick(event.target.value)}
        options={[
          ...LAUNCHERS.map((l) => ({ value: l.id, label: l.name })),
          { value: ANOTHER, label: 'Another launcher' },
        ]}
      />
    </div>
  )
}

export function SavesFolder() {
  const { system, picked, launcher, pick } = useLauncher()
  if (system === null) return null

  const inInstance = launcher ? inInstanceOn(launcher, system) : null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <LauncherSelect picked={picked} onPick={pick} />
      {launcher === undefined ? (
        <span className="type-body-sm">
          Open the instance you played from your launcher, usually with Open folder. Its worlds are in its
          saves folder, sometimes inside a minecraft or .minecraft folder.
        </span>
      ) : (
        <>
          <span className="type-body-sm">
            On {system}, {launcher.said} keeps{' '}
            {inInstance === null ? 'single-player worlds' : 'each instance in its own folder'} in
          </span>
          <CopyField value={launcher.folders[system]} label="Copy" />
          {inInstance !== null && (
            <span className="type-body-sm">
              Open the instance you played, then <code>{inInstance}</code>. If you moved the launcher’s
              folder, open the instance from the launcher instead, with Open folder.
            </span>
          )}
        </>
      )}
    </div>
  )
}
