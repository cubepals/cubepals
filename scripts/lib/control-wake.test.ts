// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Staging's API while staging is stopped: asleep, awake again on `start`, and never counted as
 * still running when a request has woken it.
 */
import { describe, expect, test } from 'bun:test'
import { afterStop, asleep, awake, differ, type Service } from './control-wake.ts'

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

describe('what is still running after staging stops', () => {
  const control = 'bly-staging-control'
  const sleeping = { config: { services: asleep([deployed]) } }

  test("the API's machine a request has woken is awake, not a failure", () => {
    const machines = [
      { app: control, machine: { id: 'woken', state: 'started', ...sleeping } },
      { app: control, machine: { id: 'resting', state: 'stopped', ...sleeping } },
      { app: 'bly-staging-realtime', machine: { id: 'stopped', state: 'stopped' } },
    ]
    expect(afterStop(control, machines)).toEqual({ woken: [`${control} woken`], running: [] })
  })

  test('any other running machine is still running', () => {
    const machines = [
      { app: control, machine: { id: 'kept-up', state: 'started', config: { services: [deployed] } } },
      { app: control, machine: { id: 'no-services', state: 'starting' } },
      { app: 'bly-staging-edge', machine: { id: 'edge', state: 'started', ...sleeping } },
      { app: 'bly-staging-mail', machine: { id: 'mail', state: 'started' } },
    ]
    expect(afterStop(control, machines)).toEqual({
      woken: [],
      running: [
        `${control} kept-up`,
        `${control} no-services`,
        'bly-staging-edge edge',
        'bly-staging-mail mail',
      ],
    })
  })
})
