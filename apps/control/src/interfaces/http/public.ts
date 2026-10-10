// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicServerView } from '@blockly/contracts'
import { type Context, Hono } from 'hono'
import { PNG } from 'pngjs'
import type { Face, PlayerFaces } from '../../app/access/faces.ts'
import { publicPlans, publicSizes } from '../../app/accounts/queries.ts'
import { AppError } from '../../app/errors.ts'
import type { ItemIcons } from '../../app/items/icons.ts'
import type { SharingQueries } from '../../app/sharing/queries.ts'
import { serverCard } from './card.ts'

/**
 * A public server's state, for anything outside Blockly (§15.6): a community page, a bot, a
 * README badge. It answers for public servers only, says nothing about machines, and is cheap
 * enough to poll: half a minute of caching, and any origin may read it.
 */
export function createPublicApp(deps: {
  sharing: SharingQueries
  faces: PlayerFaces
  items: ItemIcons
}): Hono {
  const app = new Hono()

  const cached = (c: Context) => {
    c.header('Cache-Control', 'public, max-age=30')
    c.header('Access-Control-Allow-Origin', '*')
  }

  /**
   * The reads themselves are counted, per server and per code, in `SharingQueries`: whoever is
   * asking can change their address, but not which server they are asking about. Here that
   * refusal becomes the status code a machine reading this endpoint understands.
   */
  const busy = (c: Context) => {
    c.header('Retry-After', '60')
    return c.json({ error: 'too_many_requests' }, 429)
  }
  const tooMany = (error: unknown) => error instanceof AppError && error.code === 'rate_limited'

  /** The plans, as the pricing page shows them: the same table everything else enforces. */
  app.get('/api/public/plans', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    c.header('Access-Control-Allow-Origin', '*')
    return c.json(publicPlans())
  })

  /** The size behind each answer to "Who is playing?", from the table servers are made with. */
  app.get('/api/public/sizes', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    c.header('Access-Control-Allow-Origin', '*')
    return c.json(publicSizes())
  })

  /** The status a page or a bot reads. */
  app.get('/api/public/servers/:slug', async (c) => {
    const slug = c.req.param('slug') ?? ''
    const view = await deps.sharing.page(slug, null).catch((error) => {
      if (tooMany(error)) return 'busy' as const
      throw error
    })
    if (view === 'busy') return busy(c)
    cached(c)
    if (view === null) return c.json({ error: 'not_public' }, 404)
    return c.json(status(view))
  })

  /** The same, behind an invite link, so a shared invitation can show what it points at. */
  app.get('/api/public/invites/:code', async (c) => {
    const code = c.req.param('code') ?? ''
    const view = await deps.sharing.invite(code).catch((error) => {
      if (tooMany(error)) return 'busy' as const
      throw error
    })
    if (view === 'busy') return busy(c)
    c.header('Cache-Control', 'no-store')
    if (view === null) return c.json({ error: 'not_found' }, 404)
    return c.json({ ...status(view), invited: true })
  })

  /**
   * The same thing as a picture, for places that take an image and nothing else. Plain SVG, no
   * fonts to load, and it reads correctly when a server is asleep rather than gone.
   */
  app.get('/api/public/servers/:slug/badge.svg', async (c) => {
    const slug = c.req.param('slug') ?? ''
    // A picture that can't be drawn right now is drawn as itself, not as an error page.
    const view = await deps.sharing.page(slug, null).catch((error) => {
      if (tooMany(error)) return null
      throw error
    })
    cached(c)
    c.header('Content-Type', 'image/svg+xml; charset=utf-8')
    if (view === null) return c.body(badge('Not found', '', '#9aa0a6'))
    const right = view.awake ? `${view.online}/${view.maxPlayers} playing` : 'asleep'
    return c.body(badge(view.name, right, view.awake ? '#6cc24a' : '#8f86d6'))
  })

  /**
   * The picture a link preview shows: this server, not Blockly's own cover. Drawn from the same
   * state the JSON says, cached like it, and a private server has none to show.
   */
  app.get('/api/public/servers/:slug/card.png', async (c) => {
    const view = await deps.sharing.page(c.req.param('slug') ?? '', null).catch((error) => {
      if (tooMany(error)) return null
      throw error
    })
    if (view === null) return c.json({ error: 'not_public' }, 404)
    return picture(c, view, false)
  })

  /** The same, for an invitation, which says who it is for. */
  app.get('/api/public/invites/:code/card.png', async (c) => {
    const view = await deps.sharing.invite(c.req.param('code') ?? '').catch((error) => {
      if (tooMany(error)) return null
      throw error
    })
    if (view === null) return c.json({ error: 'not_found' }, 404)
    return picture(c, view, true)
  })

  /**
   * A player's face, cut from their skin, for the pages that list players: 8×8, which a page draws
   * large and crisp. A player without a skin of their own has none here, and the page draws a face
   * of its own instead. Nothing in it says which server they play on.
   */
  app.get('/api/public/players/:uuid/face.png', async (c) =>
    faceResponse(c, await deps.faces.face(c.req.param('uuid') ?? '')),
  )

  /**
   * The same by name, for a server that doesn't verify accounts, where a player is known only by
   * the name they typed: the face of the account that has the name.
   */
  app.get('/api/public/names/:name/face.png', async (c) =>
    faceResponse(c, await deps.faces.named(c.req.param('name') ?? '')),
  )

  /**
   * A texture an item in someone's inventory is drawn with (`block/oak_log`), from the release's
   * own client jar: kept for a day, since a release's art never changes. Nothing in it says whose.
   */
  app.get('/api/public/items/:version/:folder/:name', async (c) => {
    const name = (c.req.param('name') ?? '').replace(/\.png$/, '')
    const png = await deps.items.texture(c.req.param('version') ?? '', `${c.req.param('folder')}/${name}`)
    if (png === null) return c.json({ error: 'not_found' }, 404)
    c.header('Cache-Control', 'public, max-age=86400')
    c.header('Content-Type', 'image/png')
    return c.body(new Uint8Array(png))
  })

  function faceResponse(c: Context, face: Face) {
    if (face === 'unavailable') {
      c.header('Cache-Control', 'no-store')
      c.header('Retry-After', '60')
      return c.json({ error: 'unavailable' }, 503)
    }
    // The same hour Blockly keeps a face for, so a new skin shows within it everywhere.
    c.header('Cache-Control', 'public, max-age=3600')
    if (face === null) return c.json({ error: 'no_face' }, 404)
    c.header('Content-Type', 'image/png')
    return c.body(new Uint8Array(facePng(face)))
  }

  function picture(c: Context, view: PublicServerView, invited: boolean) {
    cached(c)
    c.header('Content-Type', 'image/png')
    return c.body(
      new Uint8Array(
        serverCard({
          name: view.name,
          awake: view.awake,
          online: view.online,
          maxPlayers: view.maxPlayers,
          gameVersion: view.gameVersion,
          serverType: view.loader === 'vanilla' ? null : view.loader,
          invited,
        }),
      ),
    )
  }

  return app
}

function facePng(face: Uint8Array): Buffer {
  const png = new PNG({ width: 8, height: 8 })
  png.data.set(face)
  return PNG.sync.write(png)
}

function status(view: PublicServerView) {
  return {
    name: view.name,
    description: view.description,
    address: view.joinAddress,
    // A sleeping server is not down: joining wakes it, which is worth saying in one word.
    state: view.awake ? 'awake' : 'asleep',
    players: { online: view.online, max: view.maxPlayers },
    minecraft: { edition: 'java', version: view.gameVersion, serverType: view.loader },
    whitelistOnly: view.whitelistOnly,
    // The pack players install to join, where they install one: what a pasted invite says first.
    pack:
      view.needs.modpack === null
        ? null
        : { name: view.needs.modpack.name, version: view.needs.modpack.version },
  }
}

/** Characters are wider than they are tall by about this much in the font browsers pick here. */
const CHARACTER = 6.6
const forSvg = (text: string) => text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`).slice(0, 120)

function badge(name: string, right: string, colour: string): string {
  const left = ` ${name} `
  const leftWidth = Math.round(left.length * CHARACTER) + 16
  const rightWidth = right === '' ? 0 : Math.round(right.length * CHARACTER) + 24
  const width = leftWidth + rightWidth
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${forSvg(name)} ${forSvg(right)}">
<rect width="${width}" height="20" rx="4" fill="#1d2b22"/>
${rightWidth === 0 ? '' : `<rect x="${leftWidth}" width="${rightWidth}" height="20" rx="4" fill="${colour}"/><rect x="${leftWidth}" width="4" height="20" fill="${colour}"/>`}
<g fill="#f4f1ea" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="11">
<text x="8" y="14">${forSvg(name)}</text>
${rightWidth === 0 ? '' : `<text x="${leftWidth + 12}" y="14" fill="#10241a">${forSvg(right)}</text>`}
</g>
</svg>
`
}
