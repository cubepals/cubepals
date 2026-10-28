// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the edge's front door counts, as Prometheus scrapes it: a join let through and answered, a
 * game the server can't take, bytes that aren't Minecraft, and a connection that said nothing.
 * The exporter registers as metrics.ts loads, so the door runs in a process of its own with
 * METRICS_LISTEN set, and no label names a player, a server or an address.
 */
import { expect, test } from 'bun:test'

const PORT = 19465
const HERE = import.meta.dir

/** Runs in the child: a door before a stand-in mc-router that answers at once, dialled four ways. */
const SCRIPT = `
import { connect, createServer } from 'node:net'
import { front } from '${HERE}/front.ts'
import { Gate } from '${HERE}/limits.ts'
import { packet, string, varInt } from '${HERE}/notice.ts'

const router = createServer((socket) => {
  socket.on('error', () => {})
  socket.on('data', () => {})
  socket.write('hello')
}).listen(0, '127.0.0.1')
await new Promise((resolve) => router.once('listening', resolve))
const roomy = { connections: { perSecond: 100, burst: 100 } }
const door = front({
  port: 0,
  router: router.address().port,
  proxied: false,
  gate: new Gate({ address: { ...roomy, greeting: 100, open: 100 }, server: { ...roomy, open: 100 } }),
  known: () => true,
  plain: () => true,
  busy: 'Busy',
  refuse: (hostname) => (hostname === 'arcade.play.test' ? 'Wrong game' : null),
  timeouts: { connectMs: 1000, idleMs: 60000 },
})
await new Promise((resolve) => door.once('listening', resolve))
const join = (address) =>
  Uint8Array.from([...packet(0, [...varInt(767), ...string(address), 0x63, 0xdd, 2]), ...packet(0, string('Notch'))])
const dial = (bytes) =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: door.address().port }, () => bytes && socket.write(bytes))
    socket.on('error', () => {})
    socket.on('data', () => {})
    socket.on('close', resolve)
    setTimeout(() => socket.end(), 150)
  })
await dial(join('sunset-valley.play.test'))
await dial(join('arcade.play.test'))
await dial(new TextEncoder().encode('GET / HTTP/1.1\\r\\n'))
await dial(null)
// Long enough for one sample of the event loop's lag.
await Bun.sleep(700)
console.log(await (await fetch('http://127.0.0.1:${PORT}/metrics')).text())
process.exit(0)
`

test('the front door counts each connection once, times the first byte back, and counts what passed', async () => {
  const child = Bun.spawn([process.execPath, '-e', SCRIPT], {
    env: { ...process.env, METRICS_LISTEN: `127.0.0.1:${PORT}`, FLY_REGION: 'fra' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const scrape = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const counted = (outcome: string, reason: string) =>
    `cubepals_edge_connections_total{edition="java",outcome="${outcome}",reason="${reason}",edge_region="fra"} 1`
  expect(scrape).toContain(counted('accepted', 'none'))
  expect(scrape).toContain(counted('refused', 'wrong_game'))
  expect(scrape).toContain(counted('failed', 'bad_greeting'))
  expect(scrape).toContain(counted('failed', 'silent'))
  expect(scrape).toContain(
    'cubepals_edge_first_byte_seconds_count{edition="java",intent="join",edge_region="fra"} 1',
  )
  expect(scrape).toContain(
    'cubepals_edge_proxied_bytes_total{edition="java",direction="down",edge_region="fra"} 5',
  )
  expect(scrape).toMatch(
    /cubepals_edge_proxied_bytes_total\{edition="java",direction="up",edge_region="fra"\} [1-9]/,
  )
  expect(scrape).toMatch(/cubepals_event_loop_lag_seconds_count\{role="edge"\} \d/)
  expect(scrape).toMatch(/cubepals_heap_used_bytes\{role="edge"\} [1-9]/)
  for (const [, value] of scrape.matchAll(/\w+="([^"]*)"/g))
    expect(value).not.toMatch(/sunset|arcade|Notch|127\.0\.0\.1/)
}, 20_000)
