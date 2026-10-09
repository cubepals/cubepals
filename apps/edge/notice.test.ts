import { expect, test } from 'bun:test'
import { Notice, packet, statusRequest } from './notice.ts'

const TEXT = { status: 'Restarting · back in a moment', join: 'Restarting · join again in a moment' }

const string = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  return [bytes.length, ...bytes]
}
/** A handshake from a 1.21 client (protocol 767, two bytes as a varint) for a status or a join. */
const handshake = (intent: number) =>
  packet(0, [0xff, 0x05, ...string('lobby.play.test'), 0x63, 0xdd, intent])

/** A packet's id and first string field, as a client reads them. */
function readString(bytes: Uint8Array): { id: number; text: string } {
  let offset = 0
  const varInt = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[offset++] ?? 0
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
    }
  }
  const length = varInt()
  const id = varInt()
  const size = varInt()
  expect(offset + size).toBe(length + 1 + (length > 127 ? 1 : 0))
  return { id, text: new TextDecoder().decode(bytes.slice(offset, offset + size)) }
}

test('the server list is told the server is restarting, and its ping comes back', () => {
  const notice = new Notice(TEXT)
  expect(notice.receive(handshake(1))).toEqual({ reply: [], close: false })

  const status = notice.receive(packet(0, []))
  expect(status.close).toBe(false)
  const answer = readString(status.reply[0] ?? new Uint8Array())
  expect(answer.id).toBe(0)
  expect(JSON.parse(answer.text)).toEqual({
    version: { name: TEXT.status, protocol: 767 },
    players: { max: 0, online: 0 },
    description: { text: TEXT.status },
  })

  const ping = packet(1, [1, 2, 3, 4, 5, 6, 7, 8])
  expect(notice.receive(ping)).toEqual({ reply: [ping], close: true })
})

test('a join is turned away with the message, and nothing else', () => {
  const notice = new Notice(TEXT)
  // The handshake and the login arrive together, as they do from a real client.
  const login = packet(0, string('Steve'))
  const { reply, close } = notice.receive(Uint8Array.from([...handshake(2), ...login]))
  expect(close).toBe(true)
  expect(reply).toHaveLength(1)
  expect(readString(reply[0] ?? new Uint8Array())).toEqual({
    id: 0,
    text: JSON.stringify({ text: TEXT.join }),
  })
})

test('a sleeping server’s notice tells the server list so, and hands a join back whole', () => {
  const asleep = { status: 'Sleeping · join to wake it up', join: null }
  const ping = new Notice(asleep)
  ping.receive(handshake(1))
  const status = ping.receive(packet(0, [])).reply[0] ?? new Uint8Array()
  expect(JSON.parse(readString(status).text).description.text).toBe(asleep.status)

  const bytes = Uint8Array.from([...handshake(2), ...packet(0, string('Steve'))])
  expect(new Notice(asleep).receive(bytes)).toEqual({
    reply: [],
    close: false,
    join: { address: 'lobby.play.test', protocol: 767, bytes },
  })
})

test('bytes that arrive a few at a time are answered once they make a packet', () => {
  const notice = new Notice(TEXT)
  const bytes = Uint8Array.from([...handshake(1), ...packet(0, [])])
  const replies = [...bytes].flatMap((byte) => notice.receive(Uint8Array.of(byte)).reply)
  expect(replies).toHaveLength(1)
  expect(JSON.parse(readString(replies[0] ?? new Uint8Array()).text).description.text).toBe(TEXT.status)
})

test('an old client’s ping, and anything that never makes a handshake, are closed unanswered', () => {
  expect(new Notice(TEXT).receive(Uint8Array.of(0xfe, 0x01))).toEqual({ reply: [], close: true })
  expect(new Notice(TEXT).receive(new Uint8Array(5_000).fill(0xff))).toEqual({ reply: [], close: true })
})

test('the status request the agent asks servers with is one a server answers', () => {
  const { reply, close } = new Notice(TEXT).receive(statusRequest('bly-x.flycast', 25565))
  expect(close).toBe(false)
  expect(JSON.parse(readString(reply[0] ?? new Uint8Array()).text).description.text).toBe(TEXT.status)
})
