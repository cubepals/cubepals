// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { asleep, awake, differ, type Service } from './control-wake.ts'

/** The api machine's service as Fly reads back what control.toml deployed. */
const deployed: Service = {
  protocol: 'tcp',
  internal_port: 8080,
  autostop: false,
  autostart: false,
  min_machines_running: 1,
  ports: [{ port: 443, handlers: ['http', 'tls'] }],
}

describe("staging's API while staging is stopped", () => {
  test('wakes on a request and sleeps when idle, keeping the rest of the service', () => {
    const [service] = asleep([deployed])
    expect(service).toEqual({ ...deployed, autostart: true, autostop: 'stop', min_machines_running: 0 })
    expect(differ([deployed], [service as Service])).toBe(true)
  })

  test('is back as control.toml has it once staging starts', () => {
    const [service] = awake(asleep([deployed]))
    expect(service).toEqual({ ...deployed, autostop: 'off' })
    // Fly reads "off" back as false: nothing left to change.
    expect(differ([deployed], [service as Service])).toBe(false)
  })

  test('takes its settings from control.toml', () => {
    const toml =
      '[http_service]\nauto_stop_machines = "suspend"\nauto_start_machines = true\nmin_machines_running = 2\n'
    expect(awake([deployed], toml)).toEqual([
      { ...deployed, autostop: 'suspend', autostart: true, min_machines_running: 2 },
    ])
  })
})
