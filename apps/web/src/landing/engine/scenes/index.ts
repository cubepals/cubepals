// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** Which scene plays in each room under the grass, and what makes it. */
import type { RoomKey } from '../chunk'
import type { RoomScene } from '../rooms'
import { BackupsScene } from './backups'
import { EdgeScene } from './edge'
import { FleetScene } from './fleet'
import { MachineScene } from './machine'
import { PacksScene } from './packs'
import { RuntimesScene } from './runtimes'
import { SleepScene } from './sleep'

export const SCENES: Record<RoomKey, () => RoomScene> = {
  edge: () => new EdgeScene(),
  sleep: () => new SleepScene(),
  machine: () => new MachineScene(),
  packs: () => new PacksScene(),
  backups: () => new BackupsScene(),
  runtimes: () => new RuntimesScene(),
  fleet: () => new FleetScene(),
}
