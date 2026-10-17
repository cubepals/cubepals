// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a start step reads a list it may be given compressed: Linux takes no single variable over
 * 131,072 bytes (`MAX_ARG_STRLEN`), so a list that would pass that goes as its lines, gzipped and in
 * base64, in a variable of its own (`app/servers/carried-files.ts` makes it). The step reads that
 * one first, and the plain one otherwise. Not which lists there are, or what a step does with one.
 */

/** A list's plain variable, and the one holding it compressed. */
export interface ListVariables {
  readonly plain: string
  readonly compressed: string
}

/**
 * Shell that sets `into` to the list's lines, from its compressed variable, or as the plain one
 * holds it; a compressed one that doesn't decode stops the start.
 */
export const readList = (into: string, list: ListVariables): string =>
  `if [ -n "$${list.compressed}" ]; then ${into}=$(printf %s "$${list.compressed}" | base64 -d | gzip -dc) || exit 1; else ${into}="$${list.plain}"; fi;`
