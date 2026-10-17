// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files a start places, given to it compressed: the lines `minecraft/carried.ts` writes,
 * gzipped and in base64, in a variable of their own, which its step reads before the plain one.
 * Linux takes no single variable over 131,072 bytes, and the Arcade's files, plain, are more. Not
 * what the step does with them.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { FILES_VARIABLES } from '../../minecraft/carried.ts'
import type { RuntimeSpec } from '../ports/runtime.ts'

/**
 * The most bytes one variable or argument a start is given may hold: well under Linux's 131,072 for
 * one, so that a template's files growing fails a test long before a machine refuses them.
 */
export const VARIABLE_BYTES_LIMIT = 64 * 1024

/** A spec with its carried files compressed, the plain variable gone; one with none as it was. */
export function withCompressedFiles(spec: RuntimeSpec): RuntimeSpec {
  const { [FILES_VARIABLES.plain]: plain, ...env } = spec.env
  if (plain === undefined) return spec
  return { ...spec, env: { ...env, [FILES_VARIABLES.compressed]: gzipSync(plain).toString('base64') } }
}

/** The carried files' lines a start's variables hold, compressed or plain: what its step reads. */
export function carriedFileLines(env: Readonly<Record<string, string | undefined>>): string {
  const compressed = env[FILES_VARIABLES.compressed]
  if (compressed !== undefined && compressed !== '')
    return gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')
  return env[FILES_VARIABLES.plain] ?? ''
}
