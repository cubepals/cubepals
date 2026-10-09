import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { ndjsonLines } from './node-client.ts'

/** A body that arrives in these chunks of bytes, as reads from a socket hand it over. */
const body = (...chunks: Buffer[]) => Readable.from(chunks, { objectMode: false })

const read = async (lines: AsyncIterable<string>) => {
  const out: string[] = []
  for await (const line of lines) out.push(line)
  return out
}

const going = () => new AbortController().signal

describe('ndjsonLines', () => {
  test('a character whose bytes two chunks split arrives whole', async () => {
    for (const char of ['§', 'ë', '🙂']) {
      const line = JSON.stringify({ stream: 'stdout', line: `${char}aAlex joined` })
      const bytes = Buffer.from(`${line}\n`)
      const at = bytes.indexOf(Buffer.from(char)) + 1
      const split = body(bytes.subarray(0, at), bytes.subarray(at))
      expect(await read(ndjsonLines(split, going()))).toEqual([line])
    }
  })

  test('blank lines are skipped, and the last line needs no newline', async () => {
    const chunks = ['{"a":1}\n\n  \n{"b":', '2}\n{"c":3}'].map((text) => Buffer.from(text))
    expect(await read(ndjsonLines(body(...chunks), going()))).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test('a body that fails ends with its error, unless the request was called off', async () => {
    const failing = () => {
      const stream = new Readable({ read() {} })
      stream.push(Buffer.from('{"a":1}\n'))
      setTimeout(() => stream.destroy(new Error('connection reset')), 10)
      return stream
    }
    await expect(read(ndjsonLines(failing(), going()))).rejects.toThrow('connection reset')
    const off = new AbortController()
    off.abort()
    expect(await read(ndjsonLines(failing(), off.signal))).toEqual(['{"a":1}'])
  })
})
