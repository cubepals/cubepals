// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two test-only jobs on a sizing edge (size.ts), run beside the agent:
 *
 * - A UDP relay from the private network to the edge's Bedrock socket on `fly-global-services`.
 *   A Fly machine gets no UDP reply from a Fly app's public IPv4, so the test clients, which run on
 *   Fly, join through here; everything after the relay is the path a player's datagrams take.
 * - A sampler: every few seconds, each process's resident memory and CPU time, the machine's CPU
 *   split (steal included, where a shared CPU is held back) and free memory, served on /stats.
 *
 * The relay's own process is sampled too, so its share can be taken off the machine's.
 */

import { lookup } from 'node:dns/promises'
import { readdirSync, readFileSync } from 'node:fs'

const RELAY_PORT = 19140
const STATS_PORT = 8099
const EVERY_MS = 5000
const IDLE_MS = 60_000

const { address: bedrock } = await lookup('fly-global-services', { family: 4 })
type Udp = Bun.udp.Socket<'buffer'>
let next = 0
const peers = new Map<string, { socket: Udp; at: number }>()

const front: Udp = await Bun.udpSocket({
  hostname: '::',
  port: RELAY_PORT,
  socket: {
    error() {},
    async data(_socket, packet, port, address) {
      const key = `[${address}]:${port}`
      let peer = peers.get(key)
      if (peer === undefined) {
        // Geyser limits connection attempts by address, and every test player would otherwise
        // arrive from this machine's one. Each gets a loopback address of its own, as a real
        // player has an address of their own.
        const mine = next++
        const socket = await Bun.udpSocket({
          hostname: `127.0.${1 + (Math.floor(mine / 254) % 254)}.${1 + (mine % 254)}`,
          socket: {
            error() {},
            data(_back, reply) {
              front.send(reply, port, address)
            },
          },
        })
        peer = { socket, at: Date.now() }
        peers.set(key, peer)
      }
      peer.at = Date.now()
      peer.socket.send(packet, 19132, bedrock)
    },
  },
})
setInterval(() => {
  for (const [key, peer] of peers)
    if (Date.now() - peer.at > IDLE_MS) {
      peer.socket.close()
      peers.delete(key)
    }
}, EVERY_MS)

const NAMES: [string, string][] = [
  ['agent', 'apps/edge/agent.ts'],
  ['mc-router', 'mc-router'],
  ['geyser', 'geyser.jar'],
  ['relay', 'probe.ts'],
]

interface Sample {
  at: number
  processes: Record<string, { rssKb: number; cpuTicks: number }>
  machine: {
    user: number
    system: number
    idle: number
    steal: number
    memAvailableKb: number
    memTotalKb: number
  }
}

function sample(): Sample {
  const processes: Sample['processes'] = {}
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const named = NAMES.find(([, match]) => cmdline.includes(match))
      if (named === undefined) continue
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      const into = processes[named[0]] ?? { rssKb: 0, cpuTicks: 0 }
      into.rssKb += Number(rss?.[1] ?? 0)
      into.cpuTicks += Number(fields[11]) + Number(fields[12])
      processes[named[0]] = into
    } catch {
      // The process ended between listing and reading.
    }
  }
  const cpu = (readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '').split(/\s+/).slice(1).map(Number)
  const memory = readFileSync('/proc/meminfo', 'utf8')
  const kb = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(memory)?.[1] ?? 0)
  return {
    at: Date.now(),
    processes,
    machine: {
      user: (cpu[0] ?? 0) + (cpu[1] ?? 0),
      system: (cpu[2] ?? 0) + (cpu[5] ?? 0) + (cpu[6] ?? 0),
      idle: (cpu[3] ?? 0) + (cpu[4] ?? 0),
      steal: cpu[7] ?? 0,
      memAvailableKb: kb('MemAvailable'),
      memTotalKb: kb('MemTotal'),
    },
  }
}

const samples: Sample[] = []
setInterval(() => {
  samples.push(sample())
  if (samples.length > 2000) samples.shift()
}, EVERY_MS)

Bun.serve({
  hostname: '::',
  port: STATS_PORT,
  fetch: (request) => {
    const since = Number(new URL(request.url).searchParams.get('since') ?? 0)
    return Response.json(samples.filter((s) => s.at >= since))
  },
})
process.stderr.write(`[probe] relay [::]:${RELAY_PORT} -> ${bedrock}:19132, stats on ${STATS_PORT}\n`)
