// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PerformanceModsView } from '@blockly/contracts'

/**
 * What the Performance section says of the mods Cubepals adds to a Fabric server, by name: the
 * ones its next start places, or, turned off, the ones turning them on would bring.
 */
export function performanceLine({ on, mods }: Pick<PerformanceModsView, 'on' | 'mods'>): string {
  if (mods.length === 0)
    return 'Nothing to add: this server already runs them, or none is out for its Minecraft version yet.'
  const one = mods.length === 1
  const names = one ? mods[0] : `${mods.slice(0, -1).join(', ')} and ${mods.at(-1)}`
  const does = one
    ? 'It makes the server run smoother and asks nothing of your players.'
    : 'They make it run smoother and ask nothing of your players.'
  return `Cubepals ${on ? 'adds' : 'can add'} ${names} to this server. ${does}`
}
