// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether staging's control plane answers its public address while staging is stopped. `stop`
 * leaves its api machine asleep: Fly's proxy starts it for the next request to
 * bly-staging-control.fly.dev, which is what a pull request's preview asks, and stops it again once
 * it is idle. `start` puts it back as control.toml has it, always running, because the edge and the
 * game servers reach it over the private network, which Fly's proxy never sees and so never wakes.
 *
 * Only the machine's services change, in place (`fly machine update --skip-start`), and the machine
 * is left stopped: `stop` has stopped it already, and `start` starts it next. The next deploy writes
 * control.toml's settings over them anyway. Not for
 * production, whose control plane never sleeps, nor for anything else in staging, which the API's
 * answers don't need.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A machine service's settings for Fly's proxy, as the Machines API names them. */
export interface Service {
  autostart?: boolean
  /** `false` is how Fly reads back control.toml's "off". */
  autostop?: boolean | 'off' | 'stop' | 'suspend'
  min_machines_running?: number
  [setting: string]: unknown
}

const CONTROL_TOML = join(import.meta.dir, '../../infra/fly/control.toml')

/** The services as control.toml's http_service sets them: every environment's control plane awake. */
export function awake(services: Service[], toml = readFileSync(CONTROL_TOML, 'utf8')): Service[] {
  const { http_service: http } = Bun.TOML.parse(toml) as {
    http_service: {
      auto_start_machines: boolean
      auto_stop_machines: Service['autostop']
      min_machines_running: number
    }
  }
  return services.map((service) => ({
    ...service,
    autostart: http.auto_start_machines,
    autostop: http.auto_stop_machines,
    min_machines_running: http.min_machines_running,
  }))
}

/** The services started by a request and stopped when idle, with nothing kept running. */
export const asleep = (services: Service[]): Service[] =>
  services.map((service) => ({ ...service, autostart: true, autostop: 'stop', min_machines_running: 0 }))

const stops = (autostop: Service['autostop']) =>
  autostop === true ? 'stop' : autostop === false || autostop === undefined ? 'off' : autostop

/** Whether two sets of services differ in what Fly's proxy does with them. */
export const differ = (have: Service[], want: Service[]): boolean =>
  have.length !== want.length ||
  have.some(
    (service, index) =>
      service.autostart !== want[index]?.autostart ||
      stops(service.autostop) !== stops(want[index]?.autostop) ||
      service.min_machines_running !== want[index]?.min_machines_running,
  )

/** A machine as `fly machine list --json` gives it. */
export interface Machine {
  id: string
  state: string
  config?: { services?: Service[] }
}

/**
 * The org's running machines after `stop`, as `${app} ${id}`. `woken` holds the API's machines
 * left asleep that a request has started since, which Fly stops again once idle; `running` holds
 * every other, which `stop` failed to stop.
 */
export function afterStop(
  control: string,
  machines: { app: string; machine: Machine }[],
): { woken: string[]; running: string[] } {
  const woken: string[] = []
  const running: string[] = []
  for (const { app, machine } of machines) {
    if (machine.state !== 'started' && machine.state !== 'starting') continue
    const services = machine.config?.services ?? []
    const sleeps = app === control && services.length > 0 && !differ(services, asleep(services))
    if (sleeps) woken.push(`${app} ${machine.id}`)
    else running.push(`${app} ${machine.id}`)
  }
  return { woken, running }
}

function fly(args: string[]): string {
  const result = Bun.spawnSync(['fly', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(
      `fly ${args.slice(0, 3).join(' ')}: ${result.stderr.toString().trim().split('\n').at(-1)}`,
    )
  return result.stdout.toString()
}

/**
 * Each of the app's machines that serves requests given the services `change` makes of its own. One
 * that changes is left stopped, even if it was running. The ids of those it changed.
 */
export function serve(app: string, change: (services: Service[]) => Service[]): string[] {
  const machines = JSON.parse(fly(['machine', 'list', '-a', app, '--json']) || '[]') as {
    id: string
    config: { services?: Service[] }
  }[]
  const changed: string[] = []
  for (const machine of machines) {
    const services = machine.config.services ?? []
    const want = change(services)
    if (services.length === 0 || !differ(services, want)) continue
    fly([
      'machine',
      'update',
      machine.id,
      '-a',
      app,
      '--machine-config',
      JSON.stringify({ services: want }),
      '--skip-start',
      '--yes',
    ])
    changed.push(machine.id)
  }
  return changed
}
