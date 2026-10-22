// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { bedrockPing } from './bedrock-client.ts'

const MAGIC = '00ffff00fefefefefdfdfdfd12345678'

test('a Bedrock ping reads the MOTD out of the pong', async () => {
  const motd = 'MCPE;A Cubepals server;944;1.26;1;20;1;Cubepals;Survival;1;19132;19133;'
  const text = Buffer.from(motd)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(text.length)
  const server = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data(socket, ping, port, address) {
        expect(ping[0]).toBe(0x01)
        expect(ping.subarray(9, 25).toString('hex')).toBe(MAGIC)
        const pong = Buffer.concat([
          Buffer.from([0x1c]),
          Buffer.alloc(16),
          Buffer.from(MAGIC, 'hex'),
          length,
          text,
        ])
        socket.send(pong, port, address)
      },
    },
  })
  try {
    expect(await bedrockPing('127.0.0.1', server.port)).toBe(motd)
  } finally {
    server.close()
  }
})

test('a ping nobody answers fails with where it went', async () => {
  const silent = await Bun.udpSocket({ hostname: '127.0.0.1', socket: { data() {} } })
  try {
    await expect(bedrockPing('127.0.0.1', silent.port, 200)).rejects.toThrow(`127.0.0.1:${silent.port}`)
  } finally {
    silent.close()
  }
})
