// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an uploaded datapack means to Minecraft: which of its files a datapack holds, what its
 * `pack.mcmeta` says, and which releases the formats it declares cover. Opening the zip safely is
 * a port's job (`PackArchives`), and keeping the upload the app's (`app/mods/datapack-uploads.ts`);
 * this reads names and plain data.
 *
 * Not for: datapacks from a catalog, which say what they run on themselves, or putting a datapack
 * into a world (`datapacks.ts`).
 */

import formats from './datapack-formats.json' with { type: 'json' }
import { list, record, text } from './plain-data.ts'

/** A datapack format: its major number and, from 1.21.9, its minor one. */
type Format = readonly [major: number, minor: number]

/** The formats a datapack declares it runs on, inclusive. A null minor at the top is any minor. */
export interface FormatSpan {
  from: Format
  to: readonly [major: number, minor: number | null]
}

/** What an uploaded datapack says about itself, as its upload keeps it. */
export interface DatapackMetadata {
  format: 'pack.mcmeta'
  name: string
  formats: FormatSpan
  /** It held resource-pack files (`assets/`), which a server has no use for and were left out. */
  leftOut: boolean
}

/** The file that makes a folder a datapack, at its top. */
export const PACK_META = 'pack.mcmeta'

/**
 * An uploaded datapack's name as it may sit on disk and in a link, as `jarFileName` makes a jar's.
 * Null when it isn't a zip's name.
 */
export function datapackFileName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? '').trim()
  const safe = base.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^[-.]+/, '')
  if (!/\.zip$/i.test(safe) || safe.length < 5 || safe.length > 120) return null
  return safe
}

/** Code a server would run, or an archive that could hide some: never part of a datapack. */
const CODE = /\.(jar|class|so|dll|dylib|jnilib|exe|zip|mrpack|war|ear|rar|7z|tar|gz|tgz|bz2|xz|zst)$/i
/** What an operating system leaves in a zip it makes: nobody put it there, so it is left out. */
const LITTER = /(^|\/)(__MACOSX\/.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/i
/** Minecraft's own rule for an overlay's folder name. */
const OVERLAY = /^[a-z0-9_.-]+$/

/** How a zip's files make a datapack, or the one sentence that says why they don't. */
export type Layout =
  | {
      kind: 'datapack'
      /** The folder it all sits in, with its slash, or `''` when `pack.mcmeta` is at the top. */
      root: string
      /** The files a server keeps, as the zip names them. */
      kept: string[]
      /**
       * The zip is made again from `kept` alone, at its top: it was wrapped in a folder, or held
       * files a server leaves out (resource-pack files, or an operating system's).
       */
      repack: boolean
      /** Resource-pack files were among them, which the owner is told. */
      leftOut: boolean
    }
  | { kind: 'refused'; message: string }

/** Where `pack.mcmeta` is: at the top, or in the one folder everything else is in too. */
export function packRoot(names: readonly string[]): string | null {
  const files = names.filter((name) => !LITTER.test(name))
  if (files.includes(PACK_META)) return ''
  const [first] = files
  const folder = first?.includes('/') ? `${first.slice(0, first.indexOf('/'))}/` : null
  if (folder === null || !files.every((name) => name.startsWith(folder))) return null
  return files.includes(`${folder}${PACK_META}`) ? folder : null
}

/**
 * The zip's files judged as a datapack's. Its top holds `pack.mcmeta`, `pack.png`, `data/` and the
 * overlay folders `pack.mcmeta` declares, each with its own `data/`. Resource-pack files are left
 * out; code, archives and anything else refuse it, naming the file.
 */
export function datapackLayout(names: readonly string[], root: string, overlays: readonly string[]): Layout {
  const kept: string[] = []
  let leftOut = false
  let repack = root !== ''
  for (const name of names) {
    if (LITTER.test(name)) {
      repack = true
      continue
    }
    const path = name.slice(root.length)
    const shown = path.split('/').pop() ?? path
    if (CODE.test(path))
      return {
        kind: 'refused',
        message: `It holds ${shown}, which is code or another archive. A datapack holds neither.`,
      }
    const [top = '', next] = path.split('/')
    const folder = next !== undefined && overlays.includes(top) ? path.slice(top.length + 1) : path
    if (folder.startsWith('assets/')) {
      leftOut = true
      repack = true
    } else if (path === PACK_META || path === 'pack.png' || folder.startsWith('data/')) kept.push(name)
    else
      return {
        kind: 'refused',
        message: `It holds ${path}, which isn’t part of a datapack. A datapack holds pack.mcmeta, pack.png and a data folder.`,
      }
  }
  return { kind: 'datapack', root, kept, repack, leftOut }
}

/** What `pack.mcmeta` says: its description and the formats it runs on, or why it isn't one. */
export function packMeta(
  data: unknown,
):
  | { kind: 'pack'; description: string; formats: FormatSpan; overlays: string[] }
  | { kind: 'refused'; message: string } {
  const pack = record(record(data).pack)
  const formats = formatSpan(pack)
  if (formats === null)
    return {
      kind: 'refused',
      message: 'Its pack.mcmeta doesn’t say which Minecraft it was made for (pack_format).',
    }
  const overlays = list(record(record(data).overlays).entries)
    .map((entry) => text(record(entry).directory) ?? '')
    .filter((dir) => OVERLAY.test(dir))
  return { kind: 'pack', description: plain(pack.description, 0), formats, overlays }
}

/**
 * The formats a pack declares, as the release reading it does: `min_format` and `max_format` from
 * 1.21.9, else `supported_formats`, else `pack_format` alone.
 */
function formatSpan(pack: Record<string, unknown>): FormatSpan | null {
  const min = formatOf(pack.min_format)
  const max = formatOf(pack.max_format)
  if (min !== null && max !== null) return { from: [min[0], min[1] ?? 0], to: max }
  const supported = pack.supported_formats
  const declared = formatOf(pack.pack_format)
  if (Array.isArray(supported) && Number.isInteger(supported[0]) && Number.isInteger(supported[1]))
    return { from: [supported[0], 0], to: [supported[1], null] }
  const inclusive = record(supported)
  if (Number.isInteger(inclusive.min_inclusive) && Number.isInteger(inclusive.max_inclusive))
    return { from: [inclusive.min_inclusive as number, 0], to: [inclusive.max_inclusive as number, null] }
  if (Number.isInteger(supported)) return { from: [supported as number, 0], to: [supported as number, null] }
  if (declared === null) return null
  return { from: [declared[0], 0], to: [declared[0], null] }
}

/** A format as a pack writes it: `48`, `[94]` or `[94, 1]`. A minor left out is null. */
function formatOf(value: unknown): readonly [number, number | null] | null {
  if (Number.isInteger(value)) return [value as number, null]
  if (!Array.isArray(value) || !Number.isInteger(value[0])) return null
  return [value[0], Number.isInteger(value[1]) ? (value[1] as number) : null]
}

/**
 * A text component as plain text: a string, `{ text, extra }` or a list of them, with Minecraft's
 * `§` colour codes taken out. Nested no deeper than any description is.
 */
function plain(value: unknown, depth: number): string {
  if (depth > 8) return ''
  if (typeof value === 'string') return value.replace(/§./g, '')
  if (Array.isArray(value)) return value.map((part) => plain(part, depth + 1)).join('')
  const component = record(value)
  return plain(text(component.text) ?? '', depth + 1) + plain(list(component.extra), depth + 1)
}

/** What a datapack is called: its description's first line, else its file's name. */
export function datapackTitle(description: string, fileName: string): string {
  const line = (description.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim()
  if (line !== '') return line.length > 60 ? `${line.slice(0, 59)}…` : line
  return fileName.replace(/\.zip$/i, '')
}

/** Each release since 1.14, newest first, with the format its server reads. */
const RELEASES: ReadonlyArray<{ name: string; format: Format }> = formats.releases.map((release) => {
  const [major = 0, minor = 0] = release.format.split('.').map(Number)
  return { name: release.name, format: [major, minor] }
})

function covers(span: FormatSpan, [major, minor]: Format): boolean {
  const atLeast = major > span.from[0] || (major === span.from[0] && minor >= span.from[1])
  const atMost = major < span.to[0] || (major === span.to[0] && (span.to[1] === null || minor <= span.to[1]))
  return atLeast && atMost
}

/** The releases a datapack's formats cover, newest first: those whose server reads it. */
export const releasesFor = (span: FormatSpan): string[] =>
  RELEASES.filter((release) => covers(span, release.format)).map((release) => release.name)

/** Whether a release's server reads a datapack of these formats. A release not listed reads none. */
export function datapackFits(span: FormatSpan, gameVersion: string): boolean {
  const release = RELEASES.find((r) => r.name === gameVersion)
  return release !== undefined && covers(span, release.format)
}

/**
 * The releases a datapack was made for, as players say them: `1.21.1`, or `1.21–1.21.1`. Null
 * when it names formats no release Cubepals knows of reads.
 */
export function madeFor(releases: readonly string[]): string | null {
  const newest = releases[0]
  const oldest = releases.at(-1)
  if (newest === undefined || oldest === undefined) return null
  return newest === oldest ? newest : `${oldest}–${newest}`
}
