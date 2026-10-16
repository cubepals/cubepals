// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The datapack format of each Minecraft release, as Mojang's own server jars declare it in their
 * `version.json` (`pack_version`). The control plane reads a copy
 * (apps/control/src/minecraft/datapack-formats.json) to tell whether an uploaded datapack was made
 * for a server's release, and to say which releases it was made for when it wasn't. Only the
 * jars' central directories and that one entry are read, by byte ranges.
 *
 *   bun scripts/datapack-formats.ts write   read every release since 1.14 again and write the copy
 *   bun scripts/datapack-formats.ts check   the copy is still what the jars declare
 *
 * A new Minecraft release is a write, once Mojang publishes it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const COPY = 'apps/control/src/minecraft/datapack-formats.json'
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** The first release whose jar says its formats; datapacks came one release before. */
const OLDEST = '1.14'
/** A release's own number, as `1.21.11` or `26.2`: no snapshot, pre-release or candidate. */
const RELEASE = /^\d+\.\d+(\.\d+)?$/

interface Manifest {
  versions: Array<{ id: string; type: string; url: string }>
}

/**
 * `pack_version` as each era writes it: one number before 1.18, `{ resource, data }` until
 * 1.21.9, then `{ data_major, data_minor, … }`.
 */
type PackVersion = number | { data: number } | { data_major: number; data_minor: number }

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/** A release's datapack format, as `major` or `major.minor`. */
async function formatOf(versionUrl: string): Promise<string> {
  const { downloads } = await json<{ downloads: { server?: { url: string } } }>(versionUrl)
  if (downloads.server === undefined) throw new Error(`${versionUrl} has no server jar`)
  const file = await entry(downloads.server.url, 'version.json')
  return formatIn(JSON.parse(new TextDecoder().decode(file)) as { pack_version: PackVersion })
}

async function bytesOf(url: string, range: string): Promise<DataView> {
  const response = await fetch(url, { headers: { range: `bytes=${range}` } })
  if (response.status !== 206) throw new Error(`${url} answered ${response.status} to a range`)
  return new DataView(await response.arrayBuffer())
}

/**
 * One file of a zip at a URL, read by ranges: the end of central directory record, the directory,
 * then the entry's local header and data (APPNOTE.TXT 4.3). A server jar is far below the sizes
 * that need ZIP64.
 */
async function entry(url: string, name: string): Promise<Uint8Array> {
  const tail = await bytesOf(url, '-65557')
  let end = tail.byteLength - 22
  while (end >= 0 && tail.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error(`${url} has no zip directory`)
  const size = tail.getUint32(end + 12, true)
  const offset = tail.getUint32(end + 16, true)
  const directory = await bytesOf(url, `${offset}-${offset + size - 1}`)
  for (let at = 0; at < directory.byteLength; ) {
    const nameLength = directory.getUint16(at + 28, true)
    const skipped = directory.getUint16(at + 30, true) + directory.getUint16(at + 32, true)
    const found = new TextDecoder().decode(new Uint8Array(directory.buffer, at + 46, nameLength))
    if (found === name) {
      const method = directory.getUint16(at + 10, true)
      const compressed = directory.getUint32(at + 20, true)
      const local = directory.getUint32(at + 42, true)
      const header = await bytesOf(url, `${local}-${local + 29}`)
      const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true)
      const data = new Uint8Array((await bytesOf(url, `${start}-${start + compressed - 1}`)).buffer)
      return method === 8 ? new Uint8Array(inflateRawSync(data)) : data
    }
    at += 46 + nameLength + skipped
  }
  throw new Error(`${url} has no ${name}`)
}

/** `pack_version`'s data format, in each era's shape. */
function formatIn({ pack_version: pack }: { pack_version: PackVersion }): string {
  if (typeof pack === 'number') return String(pack)
  if ('data' in pack) return String(pack.data)
  return pack.data_minor === 0 ? String(pack.data_major) : `${pack.data_major}.${pack.data_minor}`
}

/** Every release since `OLDEST`, newest first, with its format, as the copy holds them. */
async function releases(): Promise<string> {
  const { versions } = await json<Manifest>(MANIFEST)
  const listed = versions.filter((v) => v.type === 'release' && RELEASE.test(v.id))
  const oldest = listed.findIndex((v) => v.id === OLDEST)
  if (oldest === -1) throw new Error(`${MANIFEST} doesn’t list ${OLDEST}`)
  const read = await Promise.all(
    listed.slice(0, oldest + 1).map(async (v) => ({ name: v.id, format: await formatOf(v.url) })),
  )
  return `${JSON.stringify({ source: 'Mojang’s server jars, version.json', releases: read }, null, 2)}\n`
}

const [command] = process.argv.slice(2)
if (command === 'write') {
  writeFileSync(COPY, await releases())
  process.stdout.write(`${COPY}: written\n`)
} else if (command === 'check') {
  if ((await releases()) !== readFileSync(COPY, 'utf8')) {
    console.error(`${COPY} isn’t what the server jars declare: run write`)
    process.exit(1)
  }
  process.stdout.write(`${COPY} is what the server jars declare\n`)
} else {
  console.error('usage: bun scripts/datapack-formats.ts write | check')
  process.exit(2)
}
