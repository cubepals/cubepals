/**
 * Prepares a fake server's volume the way the itzg image does before the game starts, as
 * mc-image-helper 1.68.0 does it: the jars its environment lists, then the Modrinth pack it names;
 * and, before either, what Blockly's own start step places (`placeCarried`).
 * It does not load the jars or write the server's properties: the game's loader and the server do
 * (`fake-minecraft.ts`, `properties.ts`).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strFromU8, strToU8, unzipSync } from 'fflate'

type Env = Readonly<Record<string, string>>

/**
 * The image's jar handling, as mc-image-helper 1.68.0 does it (docs/dependency-audit.md): a
 * HEAD for every listed link, and anything but 200 stops the boot; a GET, following redirects,
 * only when the file is missing or older than the Last-Modified, and never a check of what was
 * already there; each file named after its link's last path segment, decoded; jars it
 * installed before and no longer lists removed. An unset list skips all of it.
 */
export async function installJars(volume: string, env: Env, say: (text: string) => void): Promise<void> {
  const listed = env.MODS ?? env.PLUGINS
  if (listed === undefined) return
  const dir = join(volume, jarDir(env))
  await mkdir(dir, { recursive: true })
  const manifest = join(dir, '.installed.json')
  const before = JSON.parse(await readFile(manifest, 'utf8').catch(() => '[]')) as string[]
  const now: string[] = []
  for (const url of listed.split(',').filter(Boolean)) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? 'mod.jar')
    const file = join(dir, name)
    now.push(name)
    const head = await fetch(url, { method: 'HEAD' })
    if (!head.ok) {
      say(`[mc-image-helper] ERROR : Failed to process source: ${url} failed with ${head.status}`)
      throw new Error(`Downloading ${name} answered ${head.status}`)
    }
    const local = await stat(file).catch(() => null)
    const published = Date.parse(head.headers.get('last-modified') ?? '')
    if (local !== null && !(published > local.mtimeMs)) {
      say(`[mc-image-helper] INFO : The file ${file} is already up to date`)
      continue
    }
    const response = await fetch(url)
    if (!response.ok) {
      say(`[mc-image-helper] ERROR : Failed to process source: ${url} failed with ${response.status}`)
      throw new Error(`Downloading ${name} answered ${response.status}`)
    }
    await writeFile(file, Buffer.from(await response.arrayBuffer()))
    say(`[mc-image-helper] INFO : Downloaded ${file} from ${url}`)
  }
  for (const gone of before.filter((name) => !now.includes(name))) await rm(join(dir, gone), { force: true })
  await writeFile(manifest, JSON.stringify(now))
}

/**
 * The image's pack install, as mc-image-helper 1.68.0 does it for a pack at a plain link: the
 * index's files that the server's side doesn't refuse and no exclusion names, each downloaded
 * only when missing and never checked against its hashes; then `overrides/` and
 * `server-overrides/` over it, less what the overrides exclusions name; files the last install
 * put there and this one doesn't, removed; and its record of what it installed written.
 */
export async function installPack(volume: string, env: Env, say: (text: string) => void): Promise<void> {
  const url = env.MODRINTH_MODPACK
  if (url === undefined) return
  const response = await fetch(url)
  if (!response.ok) {
    say(
      `[mc-image-helper] ERROR : 'install-modrinth-modpack' command failed: ${url} answered ${response.status}`,
    )
    throw new Error(`Downloading the pack answered ${response.status}`)
  }
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const index = JSON.parse(strFromU8(entries['modrinth.index.json'] ?? strToU8('{}'))) as {
    name?: string
    versionId?: string
    files?: Array<{ path: string; downloads: string[]; env?: { server?: string } }>
  }
  say(`[mc-image-helper] INFO : Processing modpack files for ${index.name} ${index.versionId}`)
  const excluded = (env.MODRINTH_EXCLUDE_FILES ?? '')
    .split('\n')
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern.slice(1, -1)))
  const forced = (env.MODRINTH_FORCE_INCLUDE_FILES ?? '')
    .split('\n')
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern.slice(1, -1)))
  const overridesOut = new Set((env.MODRINTH_OVERRIDES_EXCLUSIONS ?? '').split('\n').filter(Boolean))
  const installed: string[] = []
  for (const file of index.files ?? []) {
    const forcedIn = forced.some((pattern) => pattern.test(file.path.toLowerCase()))
    if (file.env?.server === 'unsupported' && !forcedIn) continue
    if (excluded.some((pattern) => pattern.test(file.path.toLowerCase()))) continue
    const target = join(volume, file.path)
    installed.push(file.path)
    if ((await stat(target).catch(() => null)) !== null) continue
    const download = await fetch(file.downloads[0] ?? '')
    if (!download.ok) {
      say(
        `[mc-image-helper] ERROR : 'install-modrinth-modpack' command failed: ${file.path} answered ${download.status}`,
      )
      throw new Error(`Downloading ${file.path} answered ${download.status}`)
    }
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, Buffer.from(await download.arrayBuffer()))
  }
  for (const layer of ['overrides/', 'server-overrides/'])
    for (const [name, bytes] of Object.entries(entries)) {
      const path = name.slice(layer.length)
      if (!name.startsWith(layer) || path === '' || name.endsWith('/') || overridesOut.has(path)) continue
      await mkdir(join(volume, path, '..'), { recursive: true })
      await writeFile(join(volume, path), bytes)
      installed.push(path)
    }
  const manifest = join(volume, '.modrinth-modpack-manifest.json')
  const before = (
    JSON.parse(await readFile(manifest, 'utf8').catch(() => '{"files":[]}')) as { files: string[] }
  ).files
  for (const gone of before.filter((path) => !installed.includes(path)))
    await rm(join(volume, gone), { force: true })
  await writeFile(manifest, JSON.stringify({ files: installed }))
}

/**
 * Blockly's start step for what a revision places itself (`minecraft/carried.ts`), as its
 * variables say it: what the last start placed and this one doesn't is removed, each placed jar is
 * fetched unless it holds its bytes and refused when it arrives with others, and each carried file
 * is written over what is there. The step itself runs in a real shell in `carried.test.ts`.
 */
export async function placeCarried(volume: string, env: Env, say: (text: string) => void): Promise<void> {
  if (env.BLOCKLY_JARS === undefined && env.BLOCKLY_FILES === undefined) return
  const lines = (text: string | undefined) =>
    (text ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
  const jars = lines(env.BLOCKLY_JARS)
  const files = lines(env.BLOCKLY_FILES)
  const placed = [...jars, ...files].map(([path]) => path ?? '')
  const mark = join(volume, '.blockly-files')
  const before = (await readFile(mark, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  for (const gone of before.filter((path) => !placed.includes(path)))
    await rm(join(volume, gone), { force: true })
  const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')
  for (const [path = '', hash = '', url = ''] of jars) {
    const target = join(volume, path)
    const there = await readFile(target).catch(() => null)
    if (there !== null && sha512(there) === hash) continue
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    if (sha512(bytes) !== hash) {
      say(`Cubepals could not fetch ${path}`)
      throw new Error(`${path} arrived with other bytes`)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  for (const [path = '', data = ''] of files) {
    await mkdir(dirname(join(volume, path)), { recursive: true })
    await writeFile(join(volume, path), Buffer.from(data, 'base64'))
  }
  await writeFile(mark, `${placed.join('\n')}\n`)
}

/** Where the image puts jars: plugins for plugin servers, mods for the rest. */
export const jarDir = (env: Env) =>
  ['PAPER', 'BUKKIT', 'SPIGOT', 'PURPUR'].includes(env.TYPE ?? '') ? 'plugins' : 'mods'
