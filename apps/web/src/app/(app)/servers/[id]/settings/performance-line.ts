// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PerformanceModsView } from '@blockly/contracts'

/** What the line reads of the view: a control plane from before `runs` sends only `mods`. */
type Shown = Pick<PerformanceModsView, 'on' | 'mods'> & Partial<Pick<PerformanceModsView, 'runs'>>

/**
 * What the Performance section says of a Fabric server's performance mods, by name: the ones it
 * runs with them on, or, turned off, the ones turning them on would have it run. It reads the same
 * whether a copy is Cubepals' or the owner's own, since the server runs it either way. Where it
 * runs none, none is out for its Minecraft version.
 */
export function performanceLine({ on, mods, runs = mods }: Shown): string {
  if (runs.length === 0) return 'Cubepals has no performance mods for this server’s Minecraft version yet.'
  const one = runs.length === 1
  const names = one ? runs[0] : `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}`
  const does = one
    ? 'It makes the server run smoother and asks nothing of your players.'
    : 'They make it run smoother and ask nothing of your players.'
  return `Cubepals ${on ? 'adds' : 'can add'} ${names} to this server. ${does}`
}
