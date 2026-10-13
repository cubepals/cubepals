// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker `blockly-web-previews` (preview-router.jsonc), which puts each pull request's preview
 * of staging's website at pr-<n>.preview.cubepals.com, and each previewed commit at
 * <sha7>.preview.cubepals.com. A preview is a version of blockly-web-staging that isn't live, and
 * Cloudflare serves such a version at its workers.dev addresses alone, so this sends each request
 * on to one and its answer back: a pull request's alias, `pr-<n>` before PREVIEW_SUFFIX, which
 * always names its newest upload; or a commit's own version, its prefix before the suffix, which
 * COMMITS, the KV namespace each upload is recorded in (scripts/lib/preview-commits.ts), names. The
 * deploy (scripts/staging-website.ts) gives it PREVIEW_DOMAIN, the suffix and the namespace.
 *
 * The preview is told the address the browser used (x-forwarded-host), which it believes for its
 * own branded address alone (before-next.ts), so sign-in, its cookies and its redirects stay on
 * that address. A redirect that names the alias names the branded address instead. Every answer
 * keeps search engines out. Not for staging.cubepals.com or production, which reach their Workers
 * by their own routes.
 */

interface Env {
  /** Where the previews are: `pr-<n>.` before it for each pull request. */
  PREVIEW_DOMAIN: string
  /** What follows `pr-<n>`, or a version's prefix, in a preview's workers.dev address. */
  PREVIEW_SUFFIX: string
  /** Each commit's version prefix, by the commit's first seven characters. */
  COMMITS?: { get(key: string): Promise<string | null> }
}

/** The workers.dev alias a pull request's branded host stands for, or null for any other host. */
export function aliasOf(host: string, env: Env): string | null {
  const [, pull, domain] = /^pr-([1-9]\d*)\.(.+)$/.exec(host) ?? []
  return pull === undefined || domain !== env.PREVIEW_DOMAIN
    ? null
    : `https://pr-${pull}${env.PREVIEW_SUFFIX}`
}

/** The commit a branded host names, its first seven characters, or null for any other host. */
export function commitOf(host: string, env: Env): string | null {
  const [, commit, domain] = /^([0-9a-f]{7})\.(.+)$/.exec(host) ?? []
  return commit === undefined || domain !== env.PREVIEW_DOMAIN ? null : commit
}

/** The workers.dev address a branded host stands for: its pull request's, or its commit's version's. */
export async function upstreamOf(host: string, env: Env): Promise<string | null> {
  const commit = commitOf(host, env)
  if (commit === null) return aliasOf(host, env)
  const prefix = await env.COMMITS?.get(commit)
  return prefix && /^[0-9a-f]{8}$/.test(prefix) ? `https://${prefix}${env.PREVIEW_SUFFIX}` : null
}

/** The request the alias gets: the browser's, saying which address it was sent to. */
export function toAlias(request: Request, alias: string): Request {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', 'https')
  const bodyless = request.method === 'GET' || request.method === 'HEAD'
  return new Request(`${alias}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: bodyless ? null : request.body,
    redirect: 'manual',
    ...(bodyless ? {} : { duplex: 'half' }),
  } as RequestInit)
}

/** The alias's answer as the browser gets it: on the branded address, and kept out of search. */
export function fromAlias(response: Response, alias: string, branded: string): Response {
  const answer = new Response(response.body, response)
  const location = answer.headers.get('location')
  if (location?.startsWith(`${alias}/`) || location === alias)
    answer.headers.set('location', `${branded}${location.slice(alias.length)}`)
  answer.headers.set('x-robots-tag', 'noindex')
  return answer
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const branded = new URL(request.url).origin
    const alias = await upstreamOf(new URL(request.url).hostname, env)
    if (alias === null)
      return new Response('No preview here.', { status: 404, headers: { 'x-robots-tag': 'noindex' } })
    return fromAlias(await fetch(toAlias(request, alias)), alias, branded)
  },
}
