/**
 * Reads SNBT, the text Minecraft prints NBT as: what `data get` answers over the console. The
 * values come out as prismarine-nbt's `simplify` leaves a file's, so one reader serves a live
 * player and a saved one: numbers lose their type suffix, typed arrays (`[I; 1, 2]`) are plain
 * lists, and compounds are objects. Longs come out as numbers, which no field Blockly reads holds.
 *
 * Not for writing SNBT, and not a validator: a value it can't read is an SnbtUnreadable.
 */

class SnbtUnreadable extends Error {
  constructor(detail: string) {
    super(`Not SNBT: ${detail}`)
    this.name = 'SnbtUnreadable'
  }
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?[bslfd]?$/i
const BARE = /[A-Za-z0-9_.+-]/

export function parseSnbt(text: string): unknown {
  const reader = { text, at: 0 }
  const value = readValue(reader)
  skipSpace(reader)
  if (reader.at !== text.length)
    throw new SnbtUnreadable(`unexpected ${text.slice(reader.at, reader.at + 12)}`)
  return value
}

type Reader = { text: string; at: number }

function skipSpace(r: Reader): void {
  while (r.at < r.text.length && /\s/.test(r.text[r.at] ?? '')) r.at++
}

function expect(r: Reader, char: string): void {
  skipSpace(r)
  if (r.text[r.at] !== char) throw new SnbtUnreadable(`expected ${char} at ${r.at}`)
  r.at++
}

function readValue(r: Reader): unknown {
  skipSpace(r)
  const char = r.text[r.at]
  if (char === '{') return readCompound(r)
  if (char === '[') return readList(r)
  if (char === '"' || char === "'") return readQuoted(r)
  const word = readBare(r)
  if (NUMBER.test(word)) return Number(/[bslfd]$/i.test(word) ? word.slice(0, -1) : word)
  if (word === 'true' || word === 'false') return word === 'true' ? 1 : 0
  return word
}

function readCompound(r: Reader): Record<string, unknown> {
  expect(r, '{')
  const compound: Record<string, unknown> = {}
  skipSpace(r)
  if (r.text[r.at] === '}') {
    r.at++
    return compound
  }
  for (;;) {
    skipSpace(r)
    const quote = r.text[r.at]
    const key = quote === '"' || quote === "'" ? readQuoted(r) : readBare(r)
    expect(r, ':')
    compound[key] = readValue(r)
    skipSpace(r)
    const next = r.text[r.at++]
    if (next === '}') return compound
    if (next !== ',') throw new SnbtUnreadable(`expected , or } at ${r.at - 1}`)
  }
}

function readList(r: Reader): unknown[] {
  expect(r, '[')
  // A typed array: `[I; 1, 2]`, `[B; 1b]`, `[L; 1L]`.
  if (/^[BIL];/.test(r.text.slice(r.at, r.at + 2))) r.at += 2
  const list: unknown[] = []
  skipSpace(r)
  if (r.text[r.at] === ']') {
    r.at++
    return list
  }
  for (;;) {
    list.push(readValue(r))
    skipSpace(r)
    const next = r.text[r.at++]
    if (next === ']') return list
    if (next !== ',') throw new SnbtUnreadable(`expected , or ] at ${r.at - 1}`)
  }
}

function readQuoted(r: Reader): string {
  const quote = r.text[r.at++]
  let out = ''
  while (r.at < r.text.length) {
    const char = r.text[r.at++]
    if (char === quote) return out
    if (char === '\\') {
      const escaped = r.text[r.at++]
      out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : (escaped ?? '')
    } else out += char
  }
  throw new SnbtUnreadable('a string never ends')
}

function readBare(r: Reader): string {
  const start = r.at
  while (r.at < r.text.length && BARE.test(r.text[r.at] ?? '')) r.at++
  if (r.at === start) throw new SnbtUnreadable(`unexpected ${r.text.slice(r.at, r.at + 12) || 'end'}`)
  return r.text.slice(start, r.at)
}
