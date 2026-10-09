import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'

/**
 * Sharing a server end to end (§15.6): the page anyone can open, the same page as an invitation,
 * and the one thing an invitation can do that a page can't — put its holder on the whitelist.
 */
describe.skipIf(!hasDatabase)('sharing', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id, slug: created.slug, code: created.inviteCode }
  }
  const refusal = async (work: Promise<unknown>) =>
    work.then(
      () => 'none',
      (error: { code?: string; name?: string }) => error.code ?? error.name,
    )

  test('a private server has no page, and its owner sees the one they would publish', async () => {
    const { owner, id, slug } = await running()
    // Nobody else can open it, and nothing about it leaks: the page simply isn't there.
    expect(await h.app.sharingQueries.page(slug, null)).toBeNull()
    const stranger: UserActor = { kind: 'user', userId: (await h.user('Alex')).userId }
    expect(await h.app.sharingQueries.page(slug, stranger)).toBeNull()
    // Its owner sees it, marked as only theirs for now.
    expect(await h.app.sharingQueries.page(slug, owner)).toMatchObject({ preview: true, public: false })

    await h.app.servers.saveIdentity(owner, id, {
      name: 'Sunset Valley',
      description: 'A quiet world',
      icon: 'grass',
      tags: ['survival'],
    })
    await h.app.listings.setPublic(owner, id, true)
    expect(await h.app.sharingQueries.page(slug, null)).toMatchObject({
      name: 'Sunset Valley',
      description: 'A quiet world',
      icon: 'grass',
      tags: ['survival'],
      public: true,
      preview: false,
      awake: true,
      whitelistOnly: false,
    })
  }, 40_000)

  test('an invitation works while the server is private, and stops when the link is replaced', async () => {
    const { owner, id, slug, code } = await running()
    expect(await h.app.sharingQueries.page(slug, null)).toBeNull()
    expect(await h.app.sharingQueries.invite(code)).toMatchObject({ invited: true, public: false })

    await h.app.servers.resetInvite(owner, id)
    expect(await h.app.sharingQueries.invite(code)).toBeNull()
    const fresh = (await h.server(id)).inviteCode
    expect(fresh).not.toBe(code)
    expect(await h.app.sharingQueries.invite(fresh)).toMatchObject({ invited: true })
  }, 40_000)

  test('an invitation puts its holder on the whitelist, and says nothing to add when it is off', async () => {
    const { owner, id, code } = await running()
    // With the whitelist off there is nothing to do: anyone with the address can already join.
    expect(await h.app.sharing.joinThroughInvite(code, 'Notch')).toMatchObject({ added: false })
    expect((await h.app.queries.access(owner, id)).entries).toEqual([])

    await h.app.access.setWhitelistEnabled(owner, id, true)
    const result = await h.app.sharing.joinThroughInvite(code, 'Notch')
    expect(result).toMatchObject({ playerName: 'Notch', added: true })
    const entry = (await h.app.queries.access(owner, id)).entries.find((e) => e.list === 'whitelist')
    expect(entry).toMatchObject({ list: 'whitelist', player: { name: 'Notch' }, origin: 'blockly' })

    // A name nobody owns is caught here rather than at the door.
    h.profiles.unknown('Ghost')
    expect(await refusal(h.app.sharing.joinThroughInvite(code, 'Ghost'))).toBe('unknown_player')
  }, 40_000)

  test('a leaked invitation can only let in so many people an hour', async () => {
    const { owner, id, code } = await running()
    await h.app.access.setWhitelistEnabled(owner, id, true)
    for (let i = 0; i < 10; i++) await h.app.sharing.joinThroughInvite(code, `Player${i}`)
    expect(await refusal(h.app.sharing.joinThroughInvite(code, 'OneTooMany'))).toBe('rate_limited')
    // The owner's own additions are not held to the invitation's limit.
    await h.app.access.add(owner, id, 'whitelist', 'Steve')
    expect((await h.app.queries.access(owner, id)).entries.some((e) => e.player.name === 'Steve')).toBe(true)
  }, 60_000)

  test('a friend joining again is told they are on the list already, and spends none of the link', async () => {
    const { owner, id, code } = await running()
    await h.app.access.setWhitelistEnabled(owner, id, true)
    expect(await h.app.sharing.joinThroughInvite(code, 'Notch')).toMatchObject({
      playerName: 'Notch',
      added: true,
    })
    // A reload, a retry, a new session: the same name, whatever its capitals on a server that
    // checks accounts, is already on it, and says it as Minecraft knows it.
    for (const name of [
      'Notch',
      'notch',
      ' NOTCH ',
      'Notch',
      'notch',
      'Notch',
      'Notch',
      'Notch',
      'Notch',
      'Notch',
    ])
      expect(await h.app.sharing.joinThroughInvite(code, name)).toMatchObject({
        playerName: 'Notch',
        added: false,
      })
    // Nothing was recorded as another person let in.
    const joins = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'access.invite_join')))
    expect(joins).toEqual([{ data: { playerName: 'Notch' } }])
    // None of those were counted, so nine more friends still get in, and the tenth is the limit.
    for (let i = 0; i < 9; i++)
      expect(await h.app.sharing.joinThroughInvite(code, `Friend${i}`)).toMatchObject({ added: true })
    expect(await refusal(h.app.sharing.joinThroughInvite(code, 'OneTooMany'))).toBe('rate_limited')
    // Somebody already in is still told so while the link is full.
    expect(await h.app.sharing.joinThroughInvite(code, 'Notch')).toMatchObject({ added: false })

    // A new link is a new hour: replacing a leaked one lets the friends it goes to in.
    await h.app.servers.resetInvite(owner, id)
    const fresh = (await h.server(id)).inviteCode
    expect(await h.app.sharing.joinThroughInvite(fresh, 'NewFriend')).toMatchObject({ added: true })
  }, 60_000)

  test('opening a page counts once against it, and a busy minute blames nobody', async () => {
    const { owner, id, slug, code } = await running()
    await h.app.listings.setPublic(owner, id, true)
    // Every open reads the page twice: its title, on the web's own server, and then the page.
    // A hundred and twenty opens in a minute all get it.
    for (let i = 0; i < 120; i++) {
      expect(await h.app.sharingQueries.page(slug, null)).not.toBeNull()
      expect(await h.app.sharingQueries.page(slug, null, { reactions: true })).not.toBeNull()
    }
    // The limit is still behind them, and its refusal is nobody's own doing.
    const refused = await h.app.sharingQueries.page(slug, null, { reactions: true }).catch((error) => error)
    expect(refused).toMatchObject({
      code: 'rate_limited',
      message: 'Cubepals is busy for a moment. Try again shortly.',
    })
    // An invitation's two reads can't be told apart, so thirty friends' opens are sixty reads.
    for (let i = 0; i < 60; i++) expect(await h.app.sharingQueries.invite(code)).not.toBeNull()
    expect(await refusal(h.app.sharingQueries.invite(code))).toBe('rate_limited')
  }, 90_000)

  test('what the owner sees behind Share is what the pages are', async () => {
    const { owner, id, slug, code } = await running()
    const before = await h.app.sharingQueries.share(owner, id)
    expect(before).toMatchObject({ public: false, listed: false, whitelistOnly: false })
    expect(before.inviteUrl).toContain(`/join/${code}`)
    expect(before.pageUrl).toContain(`/server/${slug}`)
    expect(before.joinAddress).toContain(slug)

    await h.app.listings.setPublic(owner, id, true)
    const after = await h.app.sharingQueries.share(owner, id)
    expect(after).toMatchObject({ public: true })
    // Another account's server is not theirs to share.
    const stranger = await h.user('Alex')
    expect(await refusal(h.app.sharingQueries.share(stranger, id))).toBe('NotFound')
  }, 40_000)
})
