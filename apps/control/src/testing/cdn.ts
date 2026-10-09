import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PinnedMod } from '../domain/mods/artifact.ts'
import type { CatalogFile } from '../domain/mods/catalog.ts'

/** The smallest jar a loader reads: a zip's first signature, some bytes, and its end record. */
export const jar = (label: string) =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`${label} `.repeat(200)),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18),
  ])
export const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')

/**
 * Stands in for Modrinth's CDN: serves what was published at a path, and counts downloads. It
 * answers byte ranges as Modrinth's does (206, checked 2026-09-24), which is how a pack is read
 * without downloading it; a range read isn't counted as a download.
 */
export class Cdn {
  readonly files = new Map<string, Buffer>()
  downloads = 0
  url = ''
  #server: Server | null = null

  async start() {
    this.#server = createServer((request, response) => {
      const bytes = this.files.get(request.url ?? '')
      if (bytes === undefined) {
        response.statusCode = 404
        return response.end()
      }
      response.setHeader('Accept-Ranges', 'bytes')
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
      if (range !== null) {
        const [, from, to] = range
        const start = from === '' ? Math.max(0, bytes.length - Number(to)) : Number(from)
        const end = from === '' || to === '' ? bytes.length - 1 : Math.min(Number(to), bytes.length - 1)
        response.statusCode = 206
        response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
        response.setHeader('Content-Length', end - start + 1)
        return response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
      }
      if (request.method === 'GET') this.downloads++
      response.setHeader('Content-Length', bytes.length)
      response.end(request.method === 'HEAD' ? undefined : bytes)
    })
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }

  close() {
    this.#server?.close()
  }

  /** A mod version as a catalog pins it: its bytes published at a permanent URL. */
  publish(name: string, bytes = jar(name)): PinnedMod {
    const fileName = `${name}-1.0.jar`
    this.files.set(`/data/${name}/${fileName}`, bytes)
    return {
      source: { catalog: 'modrinth', projectId: `${name}-project`, versionId: `${name}-v1` },
      name,
      versionLabel: '1.0',
      artifact: {
        ref: { kind: 'remote', url: `${this.url}/data/${name}/${fileName}` },
        sha512: sha512(bytes),
        sizeBytes: bytes.length,
        fileName,
      },
      environment: 'server',
      loaders: ['fabric'],
      gameVersions: ['26.3'],
      origin: 'user',
      requiredBy: [],
    }
  }

  /** A file as a catalog version lists it, served here. */
  file(name: string, content: Uint8Array = jar(name)): CatalogFile {
    const fileName = `${name}.jar`
    const bytes = Buffer.from(content)
    this.files.set(`/files/${fileName}`, bytes)
    return { url: `${this.url}/files/${fileName}`, sha512: sha512(bytes), sizeBytes: bytes.length, fileName }
  }

  /** The published file changes under the same URL, as an upstream substitution would. */
  replace(mod: PinnedMod, bytes: Buffer) {
    if (mod.artifact.ref.kind !== 'remote') throw new Error('Only published files can be replaced')
    this.files.set(new URL(mod.artifact.ref.url).pathname, bytes)
  }
}
