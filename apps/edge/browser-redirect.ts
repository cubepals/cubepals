// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A play address opened in a browser: `<slug>.<play domain>` pasted into one, or clicked where a
 * site turned it into a link. The edge answers it at once with a redirect to that server's page.
 * The slug comes from the Host header, and whether a server has it from the routes the edge
 * already holds. Nothing here asks the control plane, mc-router or a server anything, so a browser
 * can never wake or start a server; the page itself says what it may about a private server. Not
 * for Minecraft: its front door is front.ts, on its own port and its own Fly service, with its own
 * limits.
 */

/** One DNS label, which is all a slug can be in a play address. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Where Fly's health check asks whether the edge is well, and where Bedrock's own status is. */
const HEALTH_PATH = '/_health'
const BEDROCK_PATH = '/_health/bedrock'

/** What the edge knows to answer a browser with. */
export interface Pages {
  /** PLAY_DOMAIN and each alias, lowercase: `<slug>.<domain>` is a server's play address. */
  domains: readonly string[]
  /** The web app's origin, with no trailing slash. */
  web: string
  /**
   * Whether a play address is a server's, by the routes the edge already holds: answered from
   * memory, so asking it never reaches the control plane or wakes anything.
   */
  known: (hostname: string) => boolean
  /**
   * The slug of the server a kept address points at (the route's `aliasOf`), whose page it opens;
   * undefined for a server's own address, whose page is its own slug's.
   */
  aliasOf: (hostname: string) => string | undefined
  /**
   * How Bedrock stands, null where the edge takes none: shown at `/_health/bedrock`, a status of its
   * own. It is never part of `/_health`, which Fly's check asks and which covers Java alone, since
   * a check that failed for Geyser's sake would take the Java players' edge down with it.
   */
  bedrock?: () => { state: string; bound: boolean; restarts: number } | null
}

/**
 * Where a browser asking for `host` goes: `<web>/server/<slug>` for a server's play address or
 * a kept address pointing at it, and
 * `web`'s home page for a bare play domain, an address no server has, a host under none of the
 * play domains or no host at all.
 */
export function pageFor(host: string | null, pages: Pages): string {
  const home = `${pages.web}/`
  if (host === null) return home
  // The port and a fully qualified name's final dot say nothing about the server.
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  for (const domain of pages.domains) {
    if (!name.endsWith(`.${domain}`)) continue
    const slug = name.slice(0, -domain.length - 1)
    return LABEL.test(slug) && pages.known(name) ? `${pages.web}/server/${pages.aliasOf(name) ?? slug}` : home
  }
  return home
}

/**
 * Listens on `port` for browsers, and sends each to its server's page with a temporary redirect,
 * so where it goes can change later. Every method and path is answered the same way, but Fly's health check (`/_health`).
 */
export function browserRedirect(
  options: Pages & { port: number; hostname?: string },
): ReturnType<typeof Bun.serve> {
  const pages = { ...options, domains: options.domains.map((domain) => domain.toLowerCase()) }
  return Bun.serve({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    fetch(request) {
      const path = new URL(request.url).pathname
      // Answering at all is the edge being well: if mc-router were gone, the agent would be too.
      if (path === HEALTH_PATH) return new Response(null, { status: 204 })
      if (path === BEDROCK_PATH) {
        const status = pages.bedrock?.() ?? null
        if (status === null) return new Response(null, { status: 404 })
        return Response.json(status, { status: status.state === 'up' ? 200 : 503 })
      }
      return new Response(null, {
        status: 302,
        headers: { location: pageFor(request.headers.get('host'), pages), 'cache-control': 'no-store' },
      })
    },
  })
}
