// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where to go next, as a path on this site: after signing in, after paying, after choosing a plan.
 * The address bar reads a path the way the URL standard does, which drops tabs and line breaks
 * and reads `\` as `/`, so the path is read the same way here before anyone is sent to it. One
 * check, for the web app and the control plane alike. It is not for full URLs: a place on another
 * site is never a place to go next.
 */

/**
 * The URL standard's own parser, which every place this runs has: browsers, Bun and Workers. The
 * package's types name no runtime, so this names only the parts read here.
 */
declare const URL: new (input: string, base?: string) => Parsed

interface Parsed {
  origin: string
  pathname: string
  search: string
  hash: string
}

/** A base no site can have: `.invalid` is reserved for exactly that (RFC 2606). */
const BASE = 'https://next.invalid'

/** Control characters, which the URL standard drops or refuses, and `\`, which it reads as `/`. */
const UNREAD = /[\p{Cc}\\]/u

/**
 * The path as the browser would go to it, its query and fragment kept, or null when it would
 * leave this site, isn't a path, or could be read two ways.
 */
export function sameSitePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || UNREAD.test(value)) return null
  let url: Parsed
  try {
    url = new URL(value, BASE)
  } catch {
    return null
  }
  if (url.origin !== BASE) return null
  const path = `${url.pathname}${url.search}${url.hash}`
  // `/..//host` resolves to the path `//host`, which a browser reads as another site.
  return path.startsWith('//') ? null : path
}
