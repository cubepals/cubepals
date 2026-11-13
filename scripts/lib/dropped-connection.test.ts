// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Work made once more after a dropped connection (`dropped-connection.ts`), against a server of the
 * test's own that closes a connection without answering, as staging's did to one sign-up.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { droppedConnection, onceMoreIfDropped } from './dropped-connection.ts'

/** Closes its first `drops` connections with no answer, then answers `ok`. */
let server: Server
let drops = 0
let asked = 0
beforeAll(async () => {
  server = createServer((socket) => {
    asked += 1
    if (drops > 0) {
      drops -= 1
      return void socket.destroy()
    }
    socket.once('data', () =>
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})
afterAll(() => server.close())

const ask = async () => {
  const { port } = server.address() as { port: number }
  return (await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } })).text()
}

test('what a real connection closed with no answer throws is a dropped connection', async () => {
  drops = 1
  const thrown = await ask().then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown).not.toBeNull()
  expect(droppedConnection(thrown)).toBe(true)
  expect(droppedConnection(new Error('email already taken'))).toBe(false)
})

test('work whose connection was dropped is made once more and answers', async () => {
  drops = 1
  asked = 0
  expect(await onceMoreIfDropped(ask)).toBe('ok')
  expect(asked).toBe(2)
})

test('a second drop is the failure it is, and any other failure is not made again', async () => {
  const thrownBy = (work: () => Promise<unknown>) =>
    onceMoreIfDropped(work).then(
      () => null,
      (error: unknown) => error,
    )
  drops = 2
  asked = 0
  expect(droppedConnection(await thrownBy(ask))).toBe(true)
  expect(asked).toBe(2)
  let made = 0
  const refused = await thrownBy(() => {
    made += 1
    return Promise.reject(new Error('email already taken'))
  })
  expect(refused).toEqual(new Error('email already taken'))
  expect(made).toBe(1)
})
