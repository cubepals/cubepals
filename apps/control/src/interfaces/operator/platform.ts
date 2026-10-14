// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The switches admins set on `/admin/platform`, as operators read and set them under
 * `/ops/v1/platform`: what may happen on the platform and its caps, whether servers put to sleep on
 * Fly are suspended, and the mod catalog refreshed now. A change names only what it changes; the
 * rest stays as it is. Each route calls the service the admin page calls, as the operator, so the
 * audit log says `operator:<name>`.
 */
import { FlySuspendInput, PlatformControlsInput } from '@blockly/contracts'
import type { Hono } from 'hono'
import type { PlatformControlsService } from '../../app/platform/controls.ts'
import type { SuspendSwitch } from '../../app/platform/suspend-switch.ts'
import { bodyOf, OPS_BASE, operatorOf } from './gate.ts'

export interface PlatformOptions {
  platform: Pick<PlatformControlsService, 'view' | 'set' | 'refreshCatalog'>
  flySuspend: Pick<SuspendSwitch, 'view' | 'set'>
}

const ControlsPatch = PlatformControlsInput.partial()

export function platformRoutes(app: Hono, { platform, flySuspend }: PlatformOptions): void {
  app.get(`${OPS_BASE}/platform`, async (c) => c.json(await platform.view(operatorOf(c))))
  app.patch(`${OPS_BASE}/platform`, async (c) => {
    const operator = operatorOf(c)
    const patch = ControlsPatch.parse(await bodyOf(c))
    await platform.set(
      operator,
      PlatformControlsInput.parse({ ...(await platform.view(operator)), ...patch }),
    )
    return c.json(await platform.view(operator))
  })
  app.get(`${OPS_BASE}/platform/fly-suspend`, async (c) =>
    c.json({ flySuspend: await flySuspend.view(operatorOf(c)) }),
  )
  app.put(`${OPS_BASE}/platform/fly-suspend`, async (c) => {
    const operator = operatorOf(c)
    await flySuspend.set(operator, FlySuspendInput.parse(await bodyOf(c)).on)
    return c.json({ flySuspend: await flySuspend.view(operator) })
  })
  app.post(`${OPS_BASE}/platform/catalog-refresh`, async (c) =>
    c.json(await platform.refreshCatalog(operatorOf(c))),
  )
}
