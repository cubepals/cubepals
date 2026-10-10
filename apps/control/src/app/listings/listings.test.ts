// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'

// Public listings end to end (§15.3): the owner's intent, trust of what the server booted, the
// eligibility read model kept by its queue, reports and moderation, and the platform switch.
describe.skipIf(!hasDatabase)('listings', () => {
  let h: Harness
  const cdn = new Cdn()
  const admin: Actor = { kind: 'admin', userId: 'set in beforeAll' }

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    const first = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: first.userId, grantedBy: 'test' })
    Object.assign(admin, { userId: first.userId })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  const running = async (loader: 'vanilla' | 'fabric' = 'vanilla') => {
    const owner = await h.user('Steve', loader === 'vanilla' ? 'free' : 'plus')
    const created = await h.create(owner, { loader })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  /** The owner's one switch: public means a page anyone can open and a place in the directory. */
  const listed = async (owner: UserActor, id: string, name = 'Castle Builders') => {
    await h.app.servers.saveIdentity(owner, id, { name })
    await h.app.listings.setPublic(owner, id, true)
  }
  /** The eligibility queue works on its own time: wait for the read model to say so. */
  const until = async (
    owner: UserActor,
    id: string,
    want: (v: { eligible: boolean; visible: boolean }) => boolean,
  ) => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const view = await h.app.listingQueries.own(owner, id)
      if (view !== null && want(view)) return view
      if (Date.now() > deadline) throw new Error(`The listing never got there: ${JSON.stringify(view)}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const inDirectory = async (id: string) =>
    (await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 })).listings.some(
      (l) => l.serverId === id,
    )
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string; name: string }) => error.code ?? error.name,
    )
  const catalogMod = (projectId: string) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name: `Mod ${projectId}`,
        summary: '',
        iconUrl: null,
        environments: [],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          publishedAt: new Date(),
          file: cdn.file(`${projectId}-${randomUUID().slice(0, 6)}`),
          dependencies: [],
        } satisfies CatalogVersion,
      ],
    )

  test('a server is shown once its owner makes it public, and goes when they stop', async () => {
    const { owner, id } = await running()
    // Private until its owner says otherwise: no page, no directory.
    expect(await h.app.listingQueries.own(owner, id)).toBeNull()
    expect(await inDirectory(id)).toBe(false)
    expect(await h.app.sharingQueries.page((await h.server(id)).slug, owner)).toMatchObject({
      preview: true,
      public: false,
    })

    await h.app.servers.saveIdentity(owner, id, { name: 'Castle Builders', tags: ['building'] })
    await h.app.listings.setPublic(owner, id, true)
    expect(await h.app.listingQueries.own(owner, id)).toMatchObject({
      visibility: 'published',
      eligible: true,
      visible: true,
      reasons: [],
    })
    expect(await inDirectory(id)).toBe(true)
    const card = await h.app.listingQueries.detail(id)
    expect(card).toMatchObject({
      name: 'Castle Builders',
      tags: ['building'],
      joinAddress: expect.stringContaining('.play.test'),
      online: 0,
      awake: true,
      whitelistOnly: false,
      gameVersion: '26.3',
      loader: 'vanilla',
      mods: [],
    })
    const tagged = await h.app.listingQueries.browse({ search: 'castle', tag: 'building', offset: 0 })
    expect(tagged.listings.map((l) => l.serverId)).toContain(id)
    expect(
      (await h.app.listingQueries.browse({ search: '', tag: 'pvp', offset: 0 })).listings.map(
        (l) => l.serverId,
      ),
    ).not.toContain(id)

    await h.app.listings.setPublic(owner, id, false)
    expect(await inDirectory(id)).toBe(false)
    expect(await refusal(h.app.listingQueries.detail(id))).toBe('NotFound')
    // A name too long for a server is refused wherever identity is saved.
    expect(await refusal(h.app.servers.saveIdentity(owner, id, { name: '' }))).toBe('invalid_name')
  }, 30_000)

  test('the directory filters by words, tags, and whether a server runs mods', async () => {
    const plain = await running()
    await h.app.servers.saveIdentity(plain.owner, plain.id, {
      name: 'Quiet Cove',
      description: 'A gentle place to build',
      tags: ['building'],
    })
    await h.app.listings.setPublic(plain.owner, plain.id, true)
    const names = async (query: Partial<Parameters<typeof h.app.listingQueries.browse>[0]>) =>
      (await h.app.listingQueries.browse({ search: '', tag: null, offset: 0, ...query })).listings.map(
        (l) => l.name,
      )

    expect(await names({ search: 'quiet' })).toContain('Quiet Cove')
    // The words searched are the server's own, name and description alike.
    expect(await names({ search: 'gentle place' })).toContain('Quiet Cove')
    expect(await names({ search: 'nothing-like-this' })).toEqual([])
    expect(await names({ tag: 'building' })).toContain('Quiet Cove')
    expect(await names({ tag: 'pvp' })).not.toContain('Quiet Cove')
    // It runs no mods, so it is in the plain list and not the modded one.
    expect(await names({ kind: 'vanilla' })).toContain('Quiet Cove')
    expect(await names({ kind: 'modded' })).not.toContain('Quiet Cove')
    // Nobody is playing, so "someone playing" leaves it out.
    expect(await names({ onlineNow: true })).not.toContain('Quiet Cove')
  }, 40_000)

  test('mods list only when Blockly vouches for them and the catalog still publishes them', async () => {
    const { owner, id } = await running('fabric')
    const project = `vouched-${randomUUID().slice(0, 6)}`
    catalogMod(project)
    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: project }] })
    if (plan.kind !== 'ok') throw new Error('No plan')
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      { add: [{ projectId: project }] },
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)

    await listed(owner, id)
    const untrusted = await until(owner, id, (v) => !v.eligible)
    expect(untrusted.reasons).toEqual([{ code: 'untrusted_mods', detail: `Mod ${project}: not_allowlisted` }])

    await h.app.listings.trustProject(admin, project, 'Performance, widely used')
    await until(owner, id, (v) => v.visible)
    expect((await h.app.listingQueries.detail(id)).mods).toEqual([`Mod ${project}`])
    expect((await h.app.listingQueries.allowlist(admin)).map((p) => p.projectId)).toContain(project)

    // The catalog takes it back; the next refresh re-evaluates the listings that pin it.
    h.catalog.setProjectState(project, 'withheld')
    await h.app.schedules.catalogRefresh()
    const revoked = await until(owner, id, (v) => !v.eligible)
    expect(revoked.reasons).toEqual([{ code: 'untrusted_mods', detail: `Mod ${project}: project_revoked` }])
    expect(await inDirectory(id)).toBe(false)
    // Its owner is told why, and where to fix it (§15.3), once.
    const told = h.mail.to(`${owner.userId}@example.test`)
    expect(told).toHaveLength(1)
    expect(told[0]?.subject).toBe('“Castle Builders” left the Cubepals directory')
    expect(told[0]?.text).toContain(`- Mod ${project}: taken down by its author or the catalog`)
    expect(told[0]?.text).toContain(`http://localhost:3000/servers/${id}/mods`)
    await h.app.listings.sweep()
    expect(h.mail.to(`${owner.userId}@example.test`)).toHaveLength(1)
  }, 60_000)

  test('a revocation seen while planning mods takes listings out at once, before any refresh', async () => {
    const { owner, id } = await running('fabric')
    const project = `seen-${randomUUID().slice(0, 6)}`
    catalogMod(project)
    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: project }] })
    if (plan.kind !== 'ok') throw new Error('No plan')
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      { add: [{ projectId: project }] },
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    await listed(owner, id)
    await h.app.listings.trustProject(admin, project, 'Widely used')
    await until(owner, id, (v) => v.visible)
    // Evaluations queued so far have run; nothing else would look at this listing again.
    await new Promise((resolve) => setTimeout(resolve, 2_000))

    // The catalog withholds it; before the hourly refresh, its owner plans another mod.
    h.catalog.setProjectState(project, 'withheld')
    expect((await h.app.listingQueries.own(owner, id))?.visible).toBe(true)
    const other = `other-${randomUUID().slice(0, 6)}`
    catalogMod(other)
    await h.app.mods.plan(owner, id, { add: [{ projectId: other }] })
    const revoked = await until(owner, id, (v) => !v.eligible)
    expect(revoked.reasons).toEqual([{ code: 'untrusted_mods', detail: `Mod ${project}: project_revoked` }])
    expect(await inDirectory(id)).toBe(false)
  }, 60_000)

  test('standing and restrictions are inputs, and the owner’s wish outlives them', async () => {
    const { owner, id } = await running()
    await listed(owner, id)
    expect(await inDirectory(id)).toBe(true)
    await h.app.accounts.setRestrictions(admin, owner.userId, { publicListing: true })
    expect((await until(owner, id, (v) => !v.eligible)).reasons).toEqual([{ code: 'restricted' }])
    await h.app.accounts.setRestrictions(admin, owner.userId, {})
    await until(owner, id, (v) => v.visible)

    await h.app.accounts.suspend(admin, owner.userId, 'spam')
    expect((await until(owner, id, (v) => !v.eligible)).reasons).toEqual([{ code: 'account_not_active' }])
    await h.app.accounts.reinstate(admin, owner.userId)
    // Still published: it comes back without the owner doing anything.
    const back = await until(owner, id, (v) => v.eligible)
    expect(back.visibility).toBe('published')
  }, 40_000)

  test('deleting and undeleting a server takes its listing out and back at once (§5)', async () => {
    const { owner, id } = await running()
    await listed(owner, id)
    expect(await inDirectory(id)).toBe(true)
    const { slug } = await h.server(id)
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    expect((await until(owner, id, (v) => !v.eligible)).reasons).toContainEqual({ code: 'server_deleted' })
    // Strangers found it through the directory: its address rests for 180 days, not 30 (§19.1).
    const [retired] = await h.db.select().from(schema.retiredSlugs).where(eq(schema.retiredSlugs.slug, slug))
    expect(
      Math.round(
        ((retired?.availableAfter.getTime() ?? 0) - (retired?.retiredAt.getTime() ?? 0)) / 86_400_000,
      ),
    ).toBe(180)
    // Evaluations queued before the delete have run by now; the daily sweep runs while it's in
    // the trash, as it may. Nothing else is left to bring it back.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await h.app.listings.sweep()
    expect((await h.app.listingQueries.own(owner, id))?.eligible).toBe(false)
    await h.app.servers.undeleteServer(owner, id)
    // Back without a boot or another sweep: still published, it returns on its own.
    const back = await until(owner, id, (v) => v.eligible)
    expect(back.visibility).toBe('published')
    expect(await inDirectory(id)).toBe(true)
  }, 40_000)

  test('reports reach admins, whose removal the owner sees with its note', async () => {
    const { owner, id } = await running()
    await listed(owner, id, 'Griefers Welcome')
    const player = await h.user('Player')
    expect(await refusal(h.app.listings.report(owner, id, 'my own'))).toBe('invalid_choice')
    await h.app.listings.report(player, id, 'Advertises griefing')
    expect(await refusal(h.app.listings.report(player, id, 'again'))).toBe('invalid_choice')
    const [report] = (await h.app.listingQueries.reports(admin)).filter((r) => r.serverId === id)
    expect(report).toMatchObject({
      serverName: 'Griefers Welcome',
      reason: 'Advertises griefing',
      moderation: 'clear',
    })
    expect(await refusal(h.app.listingQueries.reports(player))).toBe('NotFound')

    await h.app.listings.moderate(admin, id, 'remove', 'Listings may not invite griefing.')
    expect(await inDirectory(id)).toBe(false)
    expect(await h.app.listingQueries.own(owner, id)).toMatchObject({
      moderation: 'removed',
      moderationNote: 'Listings may not invite griefing.',
      visible: false,
    })
    expect((await h.app.listingQueries.reports(admin)).filter((r) => r.serverId === id)).toEqual([])
    const [settled] = await h.db
      .select()
      .from(schema.listingReports)
      .where(eq(schema.listingReports.serverId, id))
    expect(settled?.status).toBe('actioned')

    await h.app.listings.moderate(admin, id, 'restore', '')
    expect(await inDirectory(id)).toBe(true)
    expect(await refusal(h.app.listings.moderate(owner, id, 'restore', ''))).toBe('NotFound')
  }, 30_000)

  test('the platform switch empties the directory when it is read, and refuses publishing', async () => {
    const { owner, id } = await running()
    await listed(owner, id)
    await h.db.update(schema.platformControls).set({ publicListingEnabled: false })
    try {
      expect(await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 })).toEqual({
        listings: [],
        total: 0,
        paused: true,
      })
      expect(await h.app.listingQueries.own(owner, id)).toMatchObject({
        visible: false,
        directoryPaused: true,
        eligible: true,
      })
      expect(await refusal(h.app.listings.setPublic(owner, id, true))).toBe('platform_paused')
    } finally {
      await h.db.update(schema.platformControls).set({ publicListingEnabled: true })
    }
    expect(await inDirectory(id)).toBe(true)
  }, 30_000)
  test('a copy follows the directory’s judgement, and then the owner’s choice', async () => {
    const { owner, id } = await running('fabric')
    const project = `copied-${randomUUID().slice(0, 6)}`
    catalogMod(project)
    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: project }] })
    if (plan.kind !== 'ok') throw new Error('No plan')
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      { add: [{ projectId: project }] },
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    const { slug, inviteCode } = await h.server(id)
    const stranger = await h.user('Alex')
    const copy = { kind: 'server' as const, slug, invite: inviteCode }
    const said = (work: Promise<unknown>) =>
      work.then(
        () => null,
        (error: Error) => error.message,
      )

    // A mod Blockly hasn't checked: nobody else gets a copy, and the owner can't offer one.
    expect((await h.app.sharingQueries.share(owner, id)).copying).toEqual({
      on: false,
      locked: true,
      why: 'It runs mods Cubepals hasn’t checked yet.',
    })
    expect(await refusal(h.app.listings.setCopyable(owner, id, true))).toBe('invalid_choice')
    expect((await h.app.sharingQueries.invite(inviteCode, stranger))?.copyable).toBe(false)
    expect(await said(h.app.queries.setupPreview(stranger, copy))).toBe(
      'This server runs mods Cubepals hasn’t checked, so it can’t make another like it.',
    )
    // Its owner can still set up another of their own; the page just doesn't offer it to them.
    expect((await h.app.sharingQueries.invite(inviteCode, owner))?.yours).toBe(true)
    expect((await h.app.sharingQueries.invite(inviteCode, stranger))?.yours).toBe(false)
    await h.app.queries.setupPreview(owner, copy)

    // Once Blockly vouches for the mod, copies are offered, and the owner can take that back.
    await h.app.listings.trustProject(admin, project, 'Widely used')
    expect((await h.app.sharingQueries.share(owner, id)).copying).toEqual({
      on: true,
      locked: false,
      why: null,
    })
    expect((await h.app.sharingQueries.invite(inviteCode, stranger))?.copyable).toBe(true)
    await h.app.queries.setupPreview(stranger, copy)

    await h.app.listings.setCopyable(owner, id, false)
    expect((await h.app.sharingQueries.share(owner, id)).copying).toEqual({
      on: false,
      locked: false,
      why: null,
    })
    expect((await h.app.sharingQueries.invite(inviteCode, stranger))?.copyable).toBe(false)
    expect(await said(h.app.queries.setupPreview(stranger, copy))).toBe(
      'Its owner doesn’t offer copies of this server.',
    )
  }, 60_000)
})
