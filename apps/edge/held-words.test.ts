// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What a held client hears while it waits, over a real connection, on a shortened clock. */
import { afterEach, expect, test } from 'bun:test'
import { connect, createServer, type Server, type Socket } from 'node:net'
import nbt from 'prismarine-nbt'
import { HOLD_TIMES, speakWhile } from './held-words.ts'
import { Held } from './hold.ts'
import { packetsFor } from './hold-packet-ids.ts'
import { type Join, packet, readVarInt, string, varInt } from './notice.ts'

const TIMES = { queryEveryMs: 30, dialogAfterMs: 80, lookEveryMs: 10, keepAliveEveryMs: 60 }
const UUID = Uint8Array.from({ length: 16 }, (_, i) => i)
const joinOf = (protocol: number, address = 'maple.play.test', withStart = true): Join => ({
  address,
  protocol,
  bytes: Uint8Array.from([
    ...packet(0, [...varInt(protocol), ...string(address), 0x63, 0xdd, 2]),
    ...(withStart ? packet(0, [...string('Alex'), ...UUID]) : []),
  ]),
})

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** The edge's side of a connection, and what its client has been sent, packet by packet. */
async function connection(): Promise<{
  edge: Socket
  client: Socket
  heard: () => { id: number; body: Uint8Array }[]
}> {
  let received = new Uint8Array(0)
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer(resolve).listen(0, '127.0.0.1')
    servers.push(server)
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const client = connect(address.port, '127.0.0.1')
      client.on('data', (chunk) => {
        received = Uint8Array.from([...received, ...chunk])
      })
      clients.push(client)
    })
  })
  const clients: Socket[] = []
  const edge = await accepted
  const heard = () => {
    const packets: { id: number; body: Uint8Array }[] = []
    let offset = 0
    for (;;) {
      const length = readVarInt(received, offset)
      if (length === null || length.next + length.value > received.length) return packets
      const id = readVarInt(received, length.next)
      if (id === null) return packets
      packets.push({ id: id.value, body: received.subarray(id.next, length.next + length.value) })
      offset = length.next + length.value
    }
  }
  await Bun.sleep(5)
  const client = clients[0]
  if (client === undefined) throw new Error('no client')
  return { edge, client, heard }
}

const after = (ms: number) => Bun.sleep(ms)
const ids = (protocol: number) => {
  const found = packetsFor(protocol)
  if (found === null) throw new Error('no ids')
  return found
}
const dialogLine = (body: Uint8Array) =>
  (
    nbt.simplify(nbt.protos.big.parsePacketBuffer('anonymousNbt', Buffer.from(body)).data) as {
      body: { contents: string }[]
    }
  ).body[0]?.contents

test('a wait over before the dialog is due hears only login queries, and has no dialog', async () => {
  const { edge, heard } = await connection()
  const join = joinOf(774)
  const { result, dialog } = await speakWhile({
    client: edge,
    join,
    held: new Held(join),
    wait: after(70).then(() => 'ready'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => edge.destroy(),
    times: TIMES,
  })
  await after(40)
  expect(result).toBe('ready')
  expect(dialog).toBeNull()
  expect(heard().map((p) => p.id)).toEqual([0x04, 0x04])
})

test('a longer wait finishes the login, shows the line once configuring, follows it down, and keeps alive', async () => {
  const { edge, client, heard } = await connection()
  const join = joinOf(777)
  const held = new Held(join)
  // The waiting room's own listener, which the dialog takes over from.
  let toLoginHold = 0
  edge.on('data', (chunk: Buffer) => {
    toLoginHold += chunk.length
    held.receive(chunk)
  })
  let line = 'Waking your world · about 35 seconds'
  let misbehaved = 0
  const spoken = speakWhile({
    client: edge,
    join,
    held,
    wait: after(400).then(() => 'ready'),
    title: 'Maple',
    line: () => line,
    misbehaved: () => misbehaved++,
    times: TIMES,
  })
  await after(120)
  const login = heard().filter((p) => p.id !== 0x04)
  expect(login.map((p) => p.id)).toEqual([ids(777).login.finished])
  expect(Array.from(login[0]?.body ?? [])).toEqual([...UUID, ...string('Alex'), 0])
  // Nothing more until the client acknowledges, then its settings, as a client sends them.
  await after(30)
  expect(heard().length).toBe(heard().filter((p) => p.id === 0x04).length + 1)
  const beforeDialog = toLoginHold
  client.write(Uint8Array.from([...packet(ids(777).login.acknowledged, []), ...packet(0, string('en_us'))]))
  await after(30)
  const shown = heard().filter((p) => p.id === ids(777).configuration.showDialog)
  expect(shown.map((p) => dialogLine(p.body))).toEqual(['Waking your world · about 35 seconds'])
  line = 'Waking your world · about 30 seconds'
  await after(30)
  // No login query once the dialog has the client: it would be another packet in this state.
  const queriesAfter = heard().length
  await after(TIMES.keepAliveEveryMs + 30)
  const later = heard().slice(queriesAfter)
  expect(later.every((p) => p.id === ids(777).configuration.keepAlive)).toBe(true)
  // One keep-alive in a keep-alive's time, give or take the clock: not one at every look.
  expect(later.length).toBeGreaterThan(0)
  expect(later.length).toBeLessThanOrEqual(2)
  const { result, dialog } = await spoken
  expect(result).toBe('ready')
  expect(dialog?.configuring).toBe(true)
  expect(
    heard()
      .filter((p) => p.id === ids(777).configuration.showDialog)
      .map((p) => dialogLine(p.body)),
  ).toEqual(['Waking your world · about 35 seconds', 'Waking your world · about 30 seconds'])
  const count = heard().length
  await after(80)
  expect(heard().length).toBe(count)
  expect(misbehaved).toBe(0)
  client.write(new Uint8Array(300 * 1024))
  await after(40)
  expect(misbehaved).toBeGreaterThan(0)
  // Nothing the client sent once the dialog had it went to the login hold.
  expect(toLoginHold).toBe(beforeDialog)
})

test('the hold’s own clock: a query every 10 s, a dialog after 4 s, a look every second', async () => {
  expect(HOLD_TIMES).toEqual({
    queryEveryMs: 10_000,
    dialogAfterMs: 4_000,
    lookEveryMs: 1_000,
    keepAliveEveryMs: 10_000,
  })
  const { edge, heard } = await connection()
  const join = joinOf(774)
  const { dialog } = await speakWhile({
    client: edge,
    join,
    held: new Held(join),
    wait: after(100).then(() => 'ready'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
  })
  await after(20)
  expect(dialog).toBeNull()
  expect(heard()).toEqual([])
})

test('a client of 1.13 itself is spoken to with queries', async () => {
  const { edge, heard } = await connection()
  const join = joinOf(393)
  await speakWhile({
    client: edge,
    join,
    held: new Held(join),
    wait: after(50).then(() => 'over'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
    times: TIMES,
  })
  expect(heard().map((p) => p.id)).toEqual([0x04])
})

test('a client too old for a dialog, Forge’s, or one whose name hasn’t come, keeps the login hold', async () => {
  for (const join of [
    joinOf(770),
    joinOf(774, 'maple.play.test\0FML3\0'),
    joinOf(774, 'maple.play.test', false),
  ]) {
    const { edge, heard } = await connection()
    const { dialog } = await speakWhile({
      client: edge,
      join,
      held: new Held(join),
      wait: after(150).then(() => 'ready'),
      title: 'Maple',
      line: () => 'Waking your world',
      misbehaved: () => undefined,
      times: TIMES,
    })
    expect(dialog).toBeNull()
    expect(new Set(heard().map((p) => p.id))).toEqual(new Set([0x04]))
  }
})

test('a client from before 1.13 hears nothing, and a client gone before the dialog is due gets none', async () => {
  const old = await connection()
  const quiet = joinOf(340)
  await speakWhile({
    client: old.edge,
    join: quiet,
    held: new Held(quiet),
    wait: after(100).then(() => 'over'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
    times: TIMES,
  })
  expect(old.heard()).toEqual([])

  const gone = await connection()
  const join = joinOf(774)
  gone.edge.destroy()
  const { dialog } = await speakWhile({
    client: gone.edge,
    join,
    held: new Held(join),
    wait: after(120).then(() => 'gave up'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
    times: TIMES,
  })
  expect(dialog).toBeNull()
})

test('a join the login hold already refused gets no dialog', async () => {
  const { edge } = await connection()
  const join = joinOf(774)
  const held = new Held(join)
  held.receive(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x0f))
  expect(held.refused).toBe(true)
  const { dialog } = await speakWhile({
    client: edge,
    join,
    held,
    wait: after(120).then(() => 'refused'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
    times: TIMES,
  })
  expect(dialog).toBeNull()
})

test('the dialog stops speaking to a client that has gone', async () => {
  const { edge, client, heard } = await connection()
  const join = joinOf(774)
  const held = new Held(join)
  const spoken = speakWhile({
    client: edge,
    join,
    held,
    wait: after(300).then(() => 'gave up'),
    title: 'Maple',
    line: () => 'Waking your world',
    misbehaved: () => undefined,
    times: TIMES,
  })
  await after(100)
  client.write(packet(ids(774).login.acknowledged, []))
  await after(20)
  const seen = heard().length
  edge.destroy()
  const { dialog } = await spoken
  expect(dialog?.configuring).toBe(true)
  expect(heard().length).toBe(seen)
})
