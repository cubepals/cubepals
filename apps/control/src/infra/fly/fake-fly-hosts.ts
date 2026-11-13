// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hosts under a fake Fly: each new volume lands on one, which Fly names as the volume's
 * `zone`, and a machine on the volume reads that host's CPU from `/proc/cpuinfo`, as a machine on
 * Fly does. `FakeFly` answers Fly's API and knows no hosts; this stands in front of its `fetch`,
 * puts each new volume on the next host, and answers that one read. Everything else is
 * `FakeFly`'s, the refusal of a command in a machine that isn't running included. It holds no tests.
 */

import type { FakeFly, Json } from './fake-fly.ts'
import { CPUINFO } from './fly-runtime/host-cpu.ts'

/** The lines of `/proc/cpuinfo` a host's clock is read from, for one processor, as Linux writes them. */
const cpuinfo = (mhz: number) =>
  `processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC\ncpu MHz\t\t: ${mhz.toFixed(3)}\n`

/** A host as a test places one: Fly's name for it, and its clock in MHz where its machines read one. */
export interface FakeHost {
  zone: string
  mhz?: number
}

/** Hosts named `z1`, `z2`… with these clocks, for a test that needs no names of its own. */
export const hostsOf = (...mhz: number[]): FakeHost[] =>
  mhz.map((clock, i) => ({ zone: `z${i + 1}`, mhz: clock }))

/** The machine a call asks for its host's CPU, where it is such a call. */
async function askedCpu(request: Request): Promise<string | null> {
  const machineId = /\/machines\/([^/]+)\/exec$/.exec(new URL(request.url).pathname)?.[1]
  if (request.method !== 'POST' || machineId === undefined) return null
  const { command } = (await request.clone().json()) as { command?: string[] }
  return command?.includes(CPUINFO) ? machineId : null
}

/** The clock of the host a machine of `fake`'s runs on: its volume's. */
function clockOf(fake: FakeFly, hosts: readonly FakeHost[], machineId: string): number | undefined {
  const machine = [...fake.machines.values()].flat().find((m) => m.id === machineId)
  const mounted = (machine?.config.mounts as Json[] | undefined)?.[0]?.volume
  const volume = [...fake.volumes.values()].flat().find((v) => v.id === mounted)
  return hosts.find((host) => host.zone === volume?.zone)?.mhz
}

/**
 * `fake`'s `fetch`, on these hosts: the first volume made lands on the first, and so on, and one
 * past the list's end on a host Fly names nothing for. A machine reads nothing of its CPU on a host
 * with no clock.
 */
export function onHosts(fake: FakeFly, hosts: readonly FakeHost[]): (request: Request) => Promise<Response> {
  let volumes = 0
  return async (request) => {
    const reader = await askedCpu(request)
    const response = await fake.fetch(request)
    if (!response.ok) return response
    if (reader !== null) {
      const clock = clockOf(fake, hosts, reader)
      return Response.json({ exit_code: 0, stdout: clock === undefined ? '' : cpuinfo(clock), stderr: '' })
    }
    const zone = hosts[volumes]?.zone
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/volumes')) return response
    volumes++
    // Onto the fake's own volume, so every later read of it says where it is, as this answer does.
    const made = (await response.json()) as { id: string }
    const volume = [...fake.volumes.values()].flat().find((v) => v.id === made.id)
    if (volume !== undefined && zone !== undefined) volume.zone = zone
    return Response.json(volume ?? made)
  }
}
