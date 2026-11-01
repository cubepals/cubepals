// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The dialog hold's packets, byte for byte, read back as a client reads them. */
import { expect, test } from 'bun:test'
import nbt from 'prismarine-nbt'
import { DialogHold, dialogFor, loginStartOf, portOf } from './dialog-hold.ts'
import { packetsFor } from './hold-packet-ids.ts'
import table from './hold-packets.json' with { type: 'json' }
import { type Join, packet, readVarInt, string, varInt } from './notice.ts'

const UUID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const hello = (address: string, protocol: number, port = [0x63, 0xdd]) =>
  packet(0, [...varInt(protocol), ...string(address), ...port, 2])
const start = (name: string, uuid = UUID) => packet(0, [...string(name), ...uuid])
const joinOf = (address: string, protocol: number, ...more: Uint8Array[]): Join => ({
  address,
  protocol,
  bytes: Uint8Array.from([...hello(address, protocol), ...more.flatMap((b) => [...b])]),
})

/** A packet's id and the rest of it, as a client reads it. */
function read(bytes: Uint8Array): { id: number; body: Uint8Array } {
  const length = readVarInt(bytes, 0)
  if (length === null) throw new Error('no length')
  expect(length.next + length.value).toBe(bytes.length)
  const id = readVarInt(bytes, length.next)
  if (id === null) throw new Error('no id')
  return { id: id.value, body: bytes.subarray(id.next) }
}

const ids = (protocol: number) => {
  const found = packetsFor(protocol)
  if (found === null) throw new Error(`no ids for ${protocol}`)
  return found
}

test('every protocol the report covers holds with a dialog, each with its own release’s ids', () => {
  expect(table.protocols.length).toBeGreaterThan(0)
  for (const entry of table.protocols) expect(dialogFor(joinOf('a.play.test', entry.protocol))).toEqual(entry)
  // 26.3 put a packet before Show Dialog and Transfer: its ids are its own.
  expect(ids(777).configuration.showDialog).toBe(ids(776).configuration.showDialog + 1)
})

test('an older client, an unreported one, Forge’s and Geyser’s keep the login hold', () => {
  expect(dialogFor(joinOf('a.play.test', 770))).toBeNull()
  expect(dialogFor(joinOf('a.play.test', 9999))).toBeNull()
  expect(dialogFor(joinOf('a.play.test\0FML3\0', 774))).toBeNull()
  expect(dialogFor(joinOf('a.play.test\0^Floodgate^x', 774))).toBeNull()
})

test('the Login Start after the handshake gives the name and uuid the client claims', () => {
  expect(loginStartOf(joinOf('a.play.test', 774, start('Alex')).bytes)).toEqual({ name: 'Alex', uuid: UUID })
  expect(loginStartOf(joinOf('a.play.test', 774).bytes)).toBeNull()
  const whole = joinOf('a.play.test', 774, start('Alex')).bytes
  expect(loginStartOf(whole.subarray(0, whole.length - 1))).toBeNull()
  expect(loginStartOf(joinOf('a.play.test', 774, packet(1, [...string('Alex'), ...UUID])).bytes)).toBeNull()
  expect(loginStartOf(joinOf('a.play.test', 774, packet(0, [...string('Alex')])).bytes)).toBeNull()
  expect(loginStartOf(joinOf('a.play.test', 774, packet(0, [0, ...UUID])).bytes)).toBeNull()
  expect(loginStartOf(joinOf('a.play.test', 774, start('x'.repeat(65))).bytes)).toBeNull()
  expect(loginStartOf(joinOf('a.play.test', 774, start('x'.repeat(64))).bytes)?.name).toBe('x'.repeat(64))
  expect(loginStartOf(joinOf('a.play.test', 774, packet(0, [0x80])).bytes)).toBeNull()
  expect(loginStartOf(Uint8Array.from([...hello('a.play.test', 774), 0]))).toBeNull()
  expect(loginStartOf(Uint8Array.from([...hello('a.play.test', 774), 1, 0x80]))).toBeNull()
})

test('the port comes from the handshake, as the client dialled it', () => {
  expect(portOf(joinOf('a.play.test', 774).bytes)).toBe(25565)
  expect(portOf(hello('a.play.test', 774, [0x01, 0xbb]))).toBe(443)
  expect(portOf(packet(1, [1]))).toBeNull()
  expect(portOf(packet(0, [0x80]))).toBeNull()
  expect(portOf(packet(0, [...varInt(774), ...string('a.play.test'), 0x63]))).toBeNull()
  expect(portOf(packet(0, [...varInt(774), ...string('a.play.test')]))).toBeNull()
  expect(portOf(new Uint8Array(0))).toBeNull()
})

test('the login ends as an offline server ends it: the claimed uuid and name, no properties', () => {
  const sent = read(new DialogHold(ids(774)).finishLogin({ name: 'Alex', uuid: UUID }))
  expect(sent.id).toBe(ids(774).login.finished)
  expect(Array.from(sent.body)).toEqual([...UUID, ...string('Alex'), 0])
})

test('the client configures once it acknowledges the login, whatever came before or after', () => {
  const hold = new DialogHold(ids(777))
  // An answer to one of the login hold's queries, still on its way.
  expect(hold.receive(packet(2, [...varInt(1), 0]))).toBe(true)
  expect(hold.configuring).toBe(false)
  const acknowledged = packet(ids(777).login.acknowledged, [])
  const settings = packet(0, [...string('en_us'), 12, 0, 1, 0x7f, 1, 0, 1, 0])
  const both = Uint8Array.from([...acknowledged, ...settings])
  // In pieces, as TCP may bring them.
  expect(hold.receive(both.subarray(0, 1))).toBe(true)
  expect(hold.configuring).toBe(false)
  expect(hold.receive(both.subarray(1))).toBe(true)
  expect(hold.configuring).toBe(true)
  expect(hold.receive(packet(ids(777).login.acknowledged, []))).toBe(true)
  expect(hold.configuring).toBe(true)
})

test('a configuration packet with the acknowledgement’s id after it doesn’t start configuring', () => {
  const hold = new DialogHold(ids(774))
  expect(hold.receive(packet(ids(774).login.acknowledged + 1, []))).toBe(true)
  expect(hold.configuring).toBe(false)
})

test('far more than a waiting client sends, or a packet of nothing, ends the hold', () => {
  const flood = new DialogHold(ids(774))
  expect(flood.receive(new Uint8Array(256 * 1024))).toBe(false)
  const exactly = new DialogHold(ids(774))
  expect(
    exactly.receive(
      packet(
        0x7f,
        Array.from({ length: 256 * 1024 - 4 }, () => 0),
      ),
    ),
  ).toBe(true)
  expect(exactly.receive(Uint8Array.of(1))).toBe(false)
  expect(new DialogHold(ids(774)).receive(Uint8Array.of(0))).toBe(false)
})

test('the dialog is a notice Escape closes, its words as text, read back as a client reads NBT', () => {
  const sent = read(new DialogHold(ids(777)).dialog('Maple Hollow', 'Waking your world · about 30 seconds'))
  expect(sent.id).toBe(ids(777).configuration.showDialog)
  const parsed = nbt.protos.big.parsePacketBuffer('anonymousNbt', Buffer.from(sent.body))
  expect(parsed.metadata.size).toBe(sent.body.length)
  expect(nbt.simplify(parsed.data)).toEqual({
    type: 'minecraft:notice',
    title: 'Maple Hollow',
    body: [{ type: 'minecraft:plain_message', contents: 'Waking your world · about 30 seconds' }],
    can_close_with_escape: 1,
  })
})

test('each keep-alive carries a new number, in eight bytes', () => {
  const hold = new DialogHold(ids(774))
  const first = read(hold.keepAlive())
  const second = read(hold.keepAlive())
  expect(first.id).toBe(ids(774).configuration.keepAlive)
  expect(Array.from(first.body)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  expect(Array.from(second.body)).toEqual([0, 0, 0, 0, 0, 0, 0, 2])
})

test('the transfer names the address and port; the turn-away its words, as a text component', () => {
  const hold = new DialogHold(ids(776))
  const transfer = read(hold.transfer('a.play.test', 25565))
  expect(transfer.id).toBe(ids(776).configuration.transfer)
  expect(Array.from(transfer.body)).toEqual([...string('a.play.test'), ...varInt(25565)])
  const away = read(hold.turnAway('Still starting · join again in a moment'))
  expect(away.id).toBe(ids(776).configuration.disconnect)
  const parsed = nbt.protos.big.parsePacketBuffer('anonymousNbt', Buffer.from(away.body))
  expect(nbt.simplify(parsed.data)).toBe('Still starting · join again in a moment')
})
