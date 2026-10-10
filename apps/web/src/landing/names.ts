// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import type { RoomKey } from './engine/chunk'

/**
 * What each room is about, as someone looking for it would name it. The gauge and the overview's
 * labels say the same names.
 */
export const ROOM_NAMES: Record<RoomKey, string> = {
  edge: 'The address',
  sleep: 'Sleep',
  machine: 'The machine',
  packs: 'Modpacks',
  backups: 'Backups',
  runtimes: 'Where it runs',
  fleet: 'Cubepals’ own machines',
}
