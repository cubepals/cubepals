// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The waiting room's hold on a join, byte for byte, without a server or a client. */
import { expect, test } from 'bun:test'
import { Held, turnAway } from './hold.ts'
import { packet } from './notice.ts'

const string = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  return [bytes.length, ...bytes]
}
const handshake = packet(0, [0xff, 0x05, ...string('lobby.play.test'), 0x63, 0xdd, 2])
const login = packet(0, [...string('Steve'), ...new Array(16).fill(7)])
const join = () => ({
  address: 'lobby.play.test',
  protocol: 767,
  bytes: Uint8Array.from([...handshake, ...login]),
})
/** A client's answer to the query with `id`: not understood, no data. */
const answer = (id: number) => packet(0x02, [id, 0])

test('a held join goes on to the server as the client sent it', () => {
  const held = new Held(join())
  expect(held.settled).toBe(true)
  expect(held.replay()).toEqual(join().bytes)
})

test('the hold’s queries are login queries, each with its own id', () => {
  const held = new Held(join())
  expect(held.ask()).toEqual(packet(0x04, [1, ...string('blockly:wake')]))
  expect(held.ask()).toEqual(packet(0x04, [2, ...string('blockly:wake')]))
})

test('answers to the hold’s queries never reach the server, and it waits for every one', () => {
  const held = new Held(join())
  held.ask()
  held.ask()
  expect(held.settled).toBe(false)
  held.receive(answer(1))
  expect(held.settled).toBe(false)
  // The second answer arrives a byte at a time, as TCP may deliver it.
  for (const byte of answer(2)) held.receive(Uint8Array.of(byte))
  expect(held.settled).toBe(true)
  expect(held.replay()).toEqual(join().bytes)
})

test('a join that arrives in pieces keeps every byte, the unfinished packet included', () => {
  const bytes = join().bytes
  const held = new Held({ ...join(), bytes: bytes.slice(0, handshake.length + 3) })
  held.receive(bytes.slice(handshake.length + 3))
  expect(held.replay()).toEqual(bytes)
})

test('a client that sends far more than a login is let go', () => {
  const held = new Held(join())
  // A length that promises a packet bigger than anything a login sends.
  expect(held.receive(Uint8Array.from([0xff, 0xff, 0x7f, ...new Array(70_000).fill(0)]))).toBe(false)
})

test('a join turned away is told why, as login’s disconnect', () => {
  expect(turnAway('Still starting · join again in a moment')).toEqual(
    packet(0, string(JSON.stringify({ text: 'Still starting · join again in a moment' }))),
  )
})
