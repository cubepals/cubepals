// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own icon end to end: kept when its owner gives it, handed to the server at its next
 * start with the server's own token, drawn by pages, and never found under another server.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ownIconPath } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { PNG } from 'pngjs'
import { ServerIcons } from '../../app/server-icons/service.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ownIcon } from '../trpc/own-icon.ts'

/** A 64 square picture, one colour, as the page sends it. */
const picture = (red: number) => {
  const png = new PNG({ width: 64, height: 64 })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([red, 120, 40, 255], i)
  return ownIcon(PNG.sync.write(png))
}

describe.skipIf(!hasDatabase)('a server’s own icon', () => {
  let h: Harness
  let icons: ServerIcons

  beforeAll(async () => {
    h = await startHarness()
    icons = new ServerIcons({ db: h.db })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const iconLink = async (id: string) =>
    (await h.app.specs.desired(h.db, await h.server(id))).spec.env.ICON ?? ''

  test('shows instead of the picked icon, and reaches the server through its own link', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    const own = picture(200)
    await h.app.servers.saveIdentity(owner, id, { icon: 'grass', picture: own })

    expect((await h.server(id)).ownIcon).toBe(own.sha256)
    expect(await h.app.queries.get(owner, id)).toMatchObject({
      icon: 'grass',
      ownIcon: ownIconPath(id, own.sha256),
    })
    const link = await iconLink(id)
    expect(link).toStartWith(`${h.artifactsUrl}/runtime/v1/icons/${id}/${own.sha256}.png?t=`)
    const fetched = await fetch(link)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), own.png)).toBe(0)
    expect(await icons.forPage(id, own.sha256)).toEqual(own.png)
  }, 40_000)

  test('is never found under another server, nor with another server’s token', async () => {
    const owner = await h.user()
    const other = await h.user('Alex')
    const mine = await h.create(owner)
    const theirs = await h.create(other)
    const own = picture(10)
    await h.app.servers.saveIdentity(owner, mine.id, { picture: own })
    // The other server's link carries its own token once it has a picture of its own too.
    await h.app.servers.saveIdentity(other, theirs.id, { picture: picture(11) })
    const link = new URL(await iconLink(mine.id))
    const theirToken = new URL(await iconLink(theirs.id)).searchParams.get('t') ?? ''
    expect(theirToken).not.toBe(link.searchParams.get('t'))

    // Another server's token for this server's picture.
    expect((await fetch(`${link.origin}${link.pathname}?t=${theirToken}`)).status).toBe(403)
    // This picture asked for under the other server, with that server's own token.
    const asTheirs = `${h.artifactsUrl}/runtime/v1/icons/${theirs.id}/${own.sha256}.png?t=${theirToken}`
    expect((await fetch(asTheirs)).status).toBe(404)
    expect(await icons.forPage(theirs.id, own.sha256)).toBeNull()
    // And no token at all.
    expect((await fetch(`${link.origin}${link.pathname}`)).status).toBe(403)
  }, 40_000)

  test('gives way to a picked icon, and an earlier picture stays fetchable a while', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    const first = picture(1)
    await h.app.servers.saveIdentity(owner, id, { picture: first })
    const firstLink = await iconLink(id)

    await h.app.servers.saveIdentity(owner, id, { icon: 'diamond', picture: null })
    expect(await h.app.queries.get(owner, id)).toMatchObject({ icon: 'diamond', ownIcon: null })
    expect(await iconLink(id)).toBe(`${h.artifactsUrl}/runtime/v1/icons/diamond.png`)
    // A machine restarting on what it booted with still finds the picture it was given.
    expect((await fetch(firstLink)).status).toBe(200)

    // Only the newest few are kept.
    for (const red of [2, 3, 4, 5, 6]) await h.app.servers.saveIdentity(owner, id, { picture: picture(red) })
    expect((await fetch(firstLink)).status).toBe(404)
    expect((await fetch(await iconLink(id))).status).toBe(200)
  }, 40_000)

  test('shows on the server’s public page', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    const own = picture(99)
    await h.app.servers.saveIdentity(owner, id, { picture: own })
    expect(await h.app.sharingQueries.page(slug, owner)).toMatchObject({
      ownIcon: ownIconPath(id, own.sha256),
    })
  }, 40_000)

  test('goes when its server is purged', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    const own = picture(42)
    await h.app.servers.saveIdentity(owner, id, { picture: own })
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    await h.until(id, 'deleted')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: sql`now() - interval '1 hour'` })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged', 20_000)
    await h.settled(id)
    expect(await h.db.select().from(schema.serverIcons).where(eq(schema.serverIcons.serverId, id))).toEqual(
      [],
    )
  }, 60_000)
})
