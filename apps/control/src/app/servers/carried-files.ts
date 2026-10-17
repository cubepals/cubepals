// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lists a start is given compressed: the lines gzipped and in base64, in a variable of their
 * own, which the step reading them takes before the plain one (`minecraft/step-lists.ts`). The
 * files a start places always go so; the image's list of mods or plugins, the jars Cubepals places
 * and the datapacks only when one variable would hold more than a start may be given. Linux takes no
 * single variable over 131,072 bytes, and the Arcade's files, plain, are more. A start still past it
 * is refused (`tooLongForAStart`). Not what the steps do with the lists.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { FILES_VARIABLES, JARS_VARIABLES } from '../../minecraft/carried.ts'
import { DATAPACKS_VARIABLES } from '../../minecraft/datapacks.ts'
import { JAR_LISTS } from '../../minecraft/jars.ts'
import type { ListVariables } from '../../minecraft/step-lists.ts'
import type { RuntimeSpec } from '../ports/runtime.ts'

/**
 * The most bytes one variable or argument a start is given may hold: well under Linux's 131,072 for
 * one, so that a template's files growing fails a test long before a machine refuses them.
 */
export const VARIABLE_BYTES_LIMIT = 64 * 1024

/**
 * Linux's limit on one argument or variable a program is started with, `MAX_ARG_STRLEN`: 32 pages
 * of 4 KiB (include/uapi/linux/binfmts.h). A machine given more fails before anything runs.
 */
const LINUX_VARIABLE_BYTES = 131_072

/** The lists compressed only when long, and what separates their entries when plain. */
const LONG_LISTS: readonly (ListVariables & { separator: string })[] = [
  { ...JAR_LISTS.MODS, separator: ',' },
  { ...JAR_LISTS.PLUGINS, separator: ',' },
  { ...JARS_VARIABLES, separator: '\n' },
  { ...DATAPACKS_VARIABLES, separator: '\n' },
]

const bytesOf = (name: string, value: string) => Buffer.byteLength(`${name}=${value}`)
const compress = (lines: string) => gzipSync(lines).toString('base64')

/**
 * A spec with its carried files compressed and the plain variable gone, and each list longer than
 * `VARIABLE_BYTES_LIMIT` the same way; one with neither as it was.
 */
export function withCompressedFiles(spec: RuntimeSpec): RuntimeSpec {
  const { [FILES_VARIABLES.plain]: plain, ...rest } = spec.env
  const env: Record<string, string> = { ...rest }
  const long = LONG_LISTS.filter(({ plain }) => {
    const value = env[plain]
    return value !== undefined && bytesOf(plain, value) > VARIABLE_BYTES_LIMIT
  })
  if (plain === undefined && long.length === 0) return spec
  if (plain !== undefined) env[FILES_VARIABLES.compressed] = compress(plain)
  for (const list of long) {
    const lines = (env[list.plain] ?? '').split(list.separator).join('\n')
    delete env[list.plain]
    env[list.compressed] = compress(lines)
  }
  return { ...spec, env }
}

/**
 * Why a start can't be given this spec, in a sentence for its owner: a variable or argument, even
 * compressed, is past what Linux takes. Null when it can be.
 */
export function tooLongForAStart(spec: RuntimeSpec): string | null {
  const sizes = [
    ...Object.entries(spec.env).map(([name, value]) => bytesOf(name, value)),
    ...(spec.entrypoint ?? []).map((part) => Buffer.byteLength(part)),
  ]
  return sizes.some((bytes) => bytes > LINUX_VARIABLE_BYTES)
    ? 'This server has too many mods, plugins and files to start. Removing some lets it start.'
    : null
}

/** The lines of a list a start's variables hold, compressed or plain: what its step reads. */
export function listLines(env: Readonly<Record<string, string | undefined>>, list: ListVariables): string {
  const compressed = env[list.compressed]
  if (compressed !== undefined && compressed !== '')
    return gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')
  return env[list.plain] ?? ''
}

/** The carried files' lines a start's variables hold, compressed or plain: what its step reads. */
export const carriedFileLines = (env: Readonly<Record<string, string | undefined>>): string =>
  listLines(env, FILES_VARIABLES)
