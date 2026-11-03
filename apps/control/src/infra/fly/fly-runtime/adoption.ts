// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A released world's identity before it has a volume or machine in this runtime. */
import type { RuntimeHandle, RuntimeKey } from '../../../app/ports/runtime.ts'
import { encodeHandle, type FlyRef } from '../handle.ts'
import { appName } from './apps.ts'

export function adoptedHandle(
  deployment: string,
  key: RuntimeKey,
  region: string,
  ports: FlyRef['ports'],
): RuntimeHandle {
  return encodeHandle({
    deployment,
    serverId: key,
    app: appName(deployment, key),
    region,
    volumeId: null,
    machineId: null,
    ports,
  })
}
