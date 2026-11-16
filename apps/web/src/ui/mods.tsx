// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The mods a server runs that go in a player's game, each at the exact version the server runs and
 * linked to that version, not the newest: a game with another version of one is cut off as it
 * joins, with only the game's own error to say why. Then what to do in each launcher to get those
 * versions. Not for a modpack, which is one thing to install (`pack.tsx`).
 */
import type { PlayersMod } from '@blockly/contracts'
import { ExternalLink } from 'lucide-react'
import { OutLink } from './out-link'

/**
 * `mods` are the ones a player needs; `others` the ones a game joins without but may carry anyway,
 * folded away from anyone playing plain Minecraft.
 */
export function GetMods({ mods, others }: { mods: readonly PlayersMod[]; others: readonly PlayersMod[] }) {
  return (
    <div className="bk-getmods">
      {mods.length > 0 && <Versions mods={mods} />}
      {others.length > 0 && (
        <details>
          <summary className="type-body-sm bk-disclosure">
            {mods.length > 0 ? 'Have its other mods in your game too?' : 'Have any of its mods in your game?'}
          </summary>
          <div className="bk-getmods__others">
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              Your game joins without these, but with one of them it joins only at the version this server
              runs:
            </p>
            <Versions mods={others} />
            {mods.length === 0 && <Steps />}
          </div>
        </details>
      )}
      {mods.length > 0 && <Steps />}
    </div>
  )
}

/** Each mod by its name and version, linked to that version where Cubepals can give one. */
function Versions({ mods }: { mods: readonly PlayersMod[] }) {
  return (
    <ul className="bk-getmods__list type-body">
      {mods.map((mod) => {
        const named = mod.version === undefined ? mod.name : `${mod.name} ${mod.version}`
        return (
          <li key={mod.name}>
            {mod.url ? (
              <OutLink href={mod.url}>
                {named} <ExternalLink size={12} aria-hidden />
              </OutLink>
            ) : (
              // A jar its owner uploaded: Cubepals never hands it out.
              <>{named} — ask the owner for it</>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** What a player does in each launcher to have every mod above at that version. */
function Steps() {
  return (
    <div className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
      Get each at that version, then join:
      <ul className="bk-getmods__steps">
        <li>
          <strong>Modrinth App or CurseForge:</strong> open the profile, then add or update each mod to that
          version.
        </li>
        <li>
          <strong>Prism Launcher:</strong> Edit, Mods, Download mods, and pick that version.
        </li>
        <li>
          <strong>Minecraft Launcher:</strong> put each at that version in your mods folder.
        </li>
      </ul>
    </div>
  )
}
