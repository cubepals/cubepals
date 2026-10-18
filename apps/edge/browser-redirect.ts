// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A play address opened in a browser: `<slug>.<play domain>` pasted into one, or clicked where a
 * site turned it into a link. The edge answers it at once with a redirect to that server's page.
 * The slug comes from the Host header alone. Nothing here asks the control plane, mc-router or a
 * server anything, so a browser can never wake or start a server; the page itself says what it
 * may about a private, missing or deleted server. Not for Minecraft: its front door is front.ts,
 * on its own port and its own Fly service, with its own limits.
 */

/** One DNS label, which is all a slug can be in a play address. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Where a browser asking for `host` goes: `<web>/server/<slug>` for `<slug>.<play domain>`, and
 * `web`'s home page for a bare play domain, a host under none of them or no host at all.
 */
export function pageFor(host: string | null, domains: readonly string[], web: string): string {
  const home = `${web}/`
  if (host === null) return home
  // The port and a fully qualified name's final dot say nothing about the server.
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  for (const domain of domains) {
    if (!name.endsWith(`.${domain}`)) continue
    const slug = name.slice(0, -domain.length - 1)
    return LABEL.test(slug) ? `${web}/server/${slug}` : home
  }
  return home
}

/**
 * Listens on `port` for browsers, and sends each to its server's page with a temporary redirect,
 * so where it goes can change later. Every method and path is answered the same way.
 */
export function browserRedirect(options: {
  port: number
  hostname?: string
  /** PLAY_DOMAIN and each alias: `<slug>.<domain>` is a server's play address. */
  domains: readonly string[]
  /** The web app's origin, with no trailing slash. */
  web: string
}): ReturnType<typeof Bun.serve> {
  const domains = options.domains.map((domain) => domain.toLowerCase())
  return Bun.serve({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    fetch: (request) =>
      new Response(null, {
        status: 302,
        headers: {
          location: pageFor(request.headers.get('host'), domains, options.web),
          'cache-control': 'no-store',
        },
      }),
  })
}
