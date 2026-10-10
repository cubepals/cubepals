// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { BLOCKLY_ICON } from '@blockly/contracts'
import { create as contentDisposition } from 'content-disposition'
import { Hono } from 'hono'
import {
  ArtifactForbidden,
  ArtifactNotFound,
  type ArtifactService,
  ArtifactUnavailable,
} from '../../app/artifacts/service.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA512 = /^[0-9a-f]{128}$/

/**
 * The only inbound path from game runtimes (§15.2): the image asks for each jar its `MODS` or
 * `PLUGINS` lists. It sends a HEAD on every boot and stops the boot on anything but 200, and a
 * GET only for a file that is missing or older than the Last-Modified it was told; the GET
 * follows a redirect (mc-image-helper 1.68.0, docs/dependency-audit.md).
 */
/** Blockly's own icons, as 64x64 PNGs: what a server shows in Minecraft's multiplayer list. */
const ICONS = fileURLToPath(new URL('../../../assets/server-icons/', import.meta.url))
const ICON_KEY = /^[a-z]{3,16}$/

export function createRuntimeApp(deps: { artifacts: ArtifactService }): Hono {
  // The image stops a server's start when its icon can't be downloaded, so a build without them
  // fails here, once, rather than every server failing to boot (seen on the first staging run).
  if (!existsSync(`${ICONS}${BLOCKLY_ICON}.png`))
    throw new Error(`Blockly's server icons are missing from this build (${ICONS})`)
  const app = new Hono()

  /**
   * The picture the owner picked, which the image downloads once per boot and writes as the
   * server's icon. It is Blockly's own art, the same for every server that picks it, so it needs
   * no token and is worth caching hard.
   */
  app.get('/runtime/v1/icons/:file', async (c) => {
    const key = (c.req.param('file') ?? '').replace(/\.png$/, '')
    if (!ICON_KEY.test(key)) return c.body(null, 404)
    try {
      const png = await readFile(`${ICONS}${key}.png`)
      return c.body(new Uint8Array(png), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      })
    } catch {
      return c.body(null, 404)
    }
  })

  // Hono routes a HEAD to the GET handler and drops the body.
  app.get('/runtime/v1/artifacts/:serverId/:sha512/:name', async (c) => {
    const { serverId, sha512, name } = c.req.param()
    c.header('Cache-Control', 'no-store')
    if (!UUID.test(serverId) || !SHA512.test(sha512)) return c.body(null, 404)
    try {
      const located = await deps.artifacts.locate(serverId, sha512, c.req.query('t') ?? '')
      // The name is part of what the link promises: the image saves the file under it.
      if (name !== located.name) return c.body(null, 404)
      if (c.req.method === 'HEAD')
        return c.body(null, 200, {
          'Last-Modified': located.lastModified.toUTCString(),
          'Content-Length': String(located.artifact.sizeBytes),
          'Content-Type': 'application/java-archive',
          'Content-Disposition': contentDisposition(located.name),
        })
      return c.redirect(await deps.artifacts.source(located), 302)
    } catch (error) {
      if (error instanceof ArtifactForbidden) return c.body(null, 403)
      if (error instanceof ArtifactNotFound) return c.body(null, 404)
      if (error instanceof ArtifactUnavailable) return c.body(null, 503)
      throw error
    }
  })

  return app
}
