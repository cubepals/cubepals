// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters on a running control plane: who has it on and why, what publishing and the
 * one-time migration change and what they never do, a Free server getting it, the owner's switch,
 * Grim placed only where the owner doesn't run their own, removals and the ban they can bring, and
 * what never restarts a server.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '@blockly/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { LIBERTYBANS, LUCKPERMS } from '../../minecraft/moderation.ts'
import {
  DEFAULT_PUNISHMENTS,
  GRIM,
  PUNISHMENTS_FILE,
  STOP_CHEATERS_ENV,
} from '../../minecraft/stop-cheaters.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { reporterJar, useReporterJar } from '../artifacts/reporter.ts'
import { grimFor } from '../compat/service.ts'
import { loadRevision } from '../servers/persistence.ts'
import { installTuning, tuning } from '../tuning.ts'
import { countRemovals, recordStartMark } from './persistence.ts'
import { BAN_REASON, STOP_CHEATERS_ACTOR } from './service.ts'
import { stopCheatersAtStart } from './start.ts'

let h: Harness
const cdn = new Cdn()

/** STOP_CHEATERS as a deployment sets it: a fixture, not production's own. */
const FIXTURE = {
  punishments:
    'Punishments:\n  BadPackets:\n    commands:\n      - "1:1 cubepals-remove %player% impossible"\n',
  ban: { reason: 'impossible' as const, removals: 4, withinMinutes: 45, minutes: 90 },
}

/** A control plane of its own for each group, with Grim on the catalog and pinned for every release. */
async function begin(options: Parameters<typeof startHarness>[0] = {}): Promise<void> {
  await cdn.start()
  h = await startHarness(options)
  h.catalog.publish(
    {
      projectId: GRIM,
      slug: 'grimac',
      name: 'Grim Anticheat',
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: 'grim-1',
        projectId: GRIM,
        versionLabel: '2.3',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file('grim-1'),
        dependencies: [],
      },
    ],
  )
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}

async function end(): Promise<void> {
  await h.close()
  cdn.close()
}

/** Runs `then` with the join reporter's jar stored, as a deployment stores it at startup. */
async function withReporter(then: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reporter-'))
  const jar = join(dir, 'cubepals-reporter.jar')
  writeFileSync(jar, `reporter ${randomUUID()}`)
  useReporterJar(jar)
  try {
    const read = await reporterJar()
    if (read === null) throw new Error('The test jar was not read')
    await recordStored(h.db, { ...read, key: `built/${read.sha512}`, source: 'built' })
    await then()
  } finally {
    useReporterJar()
  }
}

/** A running server: Smooth (Paper, no plugins) unless a loader is named. */
const running = async (name: string, plan = 'free', loader?: 'vanilla' | 'fabric') => {
  const owner = await h.user(name, plan)
  const created =
    loader === undefined
      ? await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
      : await h.create(owner, { loader })
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id }
}

const view = async (id: string) => {
  const server = await h.server(id)
  return h.app.stopCheaters.view(server, await loadRevision(h.db, server.desiredRevisionId))
}

const setting = async (id: string) =>
  (await h.db.select().from(schema.serverStopCheaters).where(eq(schema.serverStopCheaters.serverId, id)))[0]

/** How many updates the server has been through: each owner's switch is one restart. */
const applies = async (id: string) =>
  (
    await h.db
      .select({ id: schema.serverOperations.id })
      .from(schema.serverOperations)
      .where(and(eq(schema.serverOperations.serverId, id), eq(schema.serverOperations.kind, 'apply')))
  ).length

const punishments = (id: string) => {
  const path = `${h.runtime.machine(id)?.dir ?? ''}/${PUNISHMENTS_FILE}`
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

describe.skipIf(!hasDatabase)('who has Stop cheaters on', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test('a Free server gets the switch, off by default, and on, the public default file, in no revision', async () => {
    const { owner, id } = await running('Fern')
    expect(await view(id)).toMatchObject({
      effective: false,
      setting: 'auto',
      why: null,
      available: { kind: 'yes' },
    })
    await h.app.stopCheaters.set(owner, id, true, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await applies(id)).toBe(1)
    expect(await view(id)).toMatchObject({ effective: true, setting: 'on', why: null })
    // On the disk as the server started, Cubepals' own, alerts and logs only.
    expect(punishments(id)).toBe(DEFAULT_PUNISHMENTS)
    expect(punishments(id)).not.toContain('cubepals-remove')
    // In no revision, so no plan rule counts it, and the server stays a Free one with no plugins.
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.mods).toEqual([])
    expect((await h.app.accountQueries.overview(owner)).plan.key).toBe('free')
    const { spec } = await h.app.specs.desired(h.db, await h.server(id))
    expect(spec.env.PLUGINS).toBe('')
    expect(spec.env.BLOCKLY_JARS?.split('\n').filter((line) => line.includes('grim'))).toHaveLength(1)
    // Off restarts it again, and the file and the jar go.
    await h.app.stopCheaters.set(owner, id, false, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(punishments(id)).toBeNull()
    expect((await h.app.specs.desired(h.db, await h.server(id))).spec.env[STOP_CHEATERS_ENV]).toBeUndefined()
  }, 60_000)

  test('plain Minecraft, which runs on Paper, can run it; a modded server can’t', async () => {
    // Plain Minecraft made where Paper has a build for its release runs on it (`runsOnPaper`).
    const { id } = await running('Ivy')
    const smooth = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const plain = { ...smooth, loader: 'vanilla' as const, loaderVersion: 'paper-build' }
    expect((await grimFor(h.db, plain)).kind).toBe('placed')
    expect((await grimFor(h.db, { ...plain, loaderVersion: null })).kind).toBe('modded')
    const modded = await running('Juno', 'plus', 'fabric')
    expect((await view(modded.id)).available).toEqual({ kind: 'modded' })
    await expect(h.app.stopCheaters.set(modded.owner, modded.id, true, randomUUID())).rejects.toThrow(
      'Stop cheaters runs on plain Minecraft and Paper servers.',
    )
  }, 60_000)

  test('servers made from Duels or Arcade have it on at auto, as their creation says', async () => {
    const { id } = await running('Yara')
    await h.db
      .update(schema.auditLog)
      .set({ data: sql`${schema.auditLog.data} || '{"template":"arcade"}'::jsonb` })
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.created')))
    expect(await view(id)).toMatchObject({ effective: true, setting: 'auto', why: 'template' })
  }, 30_000)
})

describe.skipIf(!hasDatabase)('what changes the setting', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test('publishing turns auto on, saying Browse did it, and restarts nothing; unpublishing leaves it on', async () => {
    const { owner, id } = await running('Gale')
    const drift = (await h.app.specs.desired(h.db, await h.server(id))).driftDigest
    await h.app.listings.setPublic(owner, id, true)
    expect(await setting(id)).toMatchObject({ setting: 'on', reason: 'browse' })
    expect(await view(id)).toMatchObject({ effective: true, why: 'browse' })
    // It arrives at the next start: the running server isn't restarted, and drift sees nothing.
    expect((await h.app.specs.desired(h.db, await h.server(id))).driftDigest).toBe(drift)
    expect(await applies(id)).toBe(0)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    await h.app.listings.setPublic(owner, id, false)
    expect(await view(id)).toMatchObject({ effective: true, why: 'browse' })
  }, 60_000)

  test('off is the owner’s: publishing leaves it, and the switch clears the reason', async () => {
    const { owner, id } = await running('Hale')
    await h.app.stopCheaters.set(owner, id, false, randomUUID())
    await h.app.listings.setPublic(owner, id, true)
    expect(await setting(id)).toMatchObject({ setting: 'off', reason: null })
    const other = await running('Hugo')
    await h.app.listings.setPublic(other.owner, other.id, true)
    await h.app.stopCheaters.set(other.owner, other.id, true, randomUUID())
    expect(await setting(other.id)).toMatchObject({ setting: 'on', reason: null })
    // It already ran: the owner's choice restarts nothing.
    expect(await applies(other.id)).toBe(0)
  }, 60_000)

  test('the migration turns on only published servers left at auto, and restarts none', async () => {
    const published = await running('Kai')
    const unpublished = await running('Lee')
    const off = await running('Mo')
    for (const server of [published, off])
      await h.db
        .insert(schema.publicListings)
        .values({ serverId: server.id, visibility: 'published' })
        .onConflictDoUpdate({ target: schema.publicListings.serverId, set: { visibility: 'published' } })
    await h.db.insert(schema.serverStopCheaters).values({ serverId: off.id, setting: 'off' })
    const migration = readFileSync(
      new URL('../../../../../packages/db/migrations/0094_stop_cheaters.sql', import.meta.url),
      'utf8',
    )
    const once = migration.split('--> statement-breakpoint').at(-1) ?? ''
    await h.db.execute(sql.raw(once))
    expect(await setting(published.id)).toMatchObject({ setting: 'on', reason: 'browse' })
    expect(await setting(unpublished.id)).toBeUndefined()
    expect(await setting(off.id)).toMatchObject({ setting: 'off', reason: null })
    for (const server of [published, unpublished, off]) {
      expect(await applies(server.id)).toBe(0)
      expect((await h.server(server.id)).lifecycle.status).toBe('running')
    }
  }, 60_000)

  test('official servers have it on at auto, with no note', async () => {
    const { id } = await running('Nia')
    await h.db
      .insert(schema.publicListings)
      .values({ serverId: id, official: true })
      .onConflictDoUpdate({ target: schema.publicListings.serverId, set: { official: true } })
    expect(await view(id)).toMatchObject({ effective: true, why: 'official' })
  }, 30_000)

  test('Browse eligibility is the same with it on or off', async () => {
    const { owner, id } = await running('Oli')
    await h.app.servers.saveIdentity(owner, id, { name: 'Castle Builders' })
    await h.app.listings.setPublic(owner, id, true)
    const judged = async () => {
      await h.app.listings.reevaluate([id])
      const [row] = await h.db
        .select()
        .from(schema.publicListings)
        .where(eq(schema.publicListings.serverId, id))
      return { eligible: row?.eligible, reasons: row?.ineligibleReasons }
    }
    const on = await judged()
    await h.app.stopCheaters.set(owner, id, false, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await judged()).toEqual(on)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('what a start places', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test('no second Grim where the owner runs their own, pinned or uploaded', async () => {
    const { id } = await running('Pia')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const placed = await grimFor(h.db, revision)
    if (placed.kind !== 'placed' || placed.jar === null) throw new Error('Grim was not pinned')
    const { dir: _dir, ...theirs } = placed.jar
    expect(await grimFor(h.db, { ...revision, mods: [theirs] })).toEqual({ kind: 'placed', jar: null })
    const upload: PinnedMod = { ...theirs, source: { catalog: 'upload', uploadId: 'u-1' }, name: 'GrimAC' }
    expect(await grimFor(h.db, { ...revision, mods: [upload] })).toEqual({ kind: 'placed', jar: null })
  }, 30_000)

  test('a release Grim has no build for yet says so, and places nothing', async () => {
    const { owner, id } = await running('Quin')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    await h.db
      .delete(schema.compatPlugins)
      .where(
        and(
          eq(schema.compatPlugins.projectId, GRIM),
          eq(schema.compatPlugins.gameVersion, revision.gameVersion),
        ),
      )
    // The switch takes, and restarts nothing: there is nothing to place yet.
    await h.app.stopCheaters.set(owner, id, true, randomUUID())
    expect(await applies(id)).toBe(0)
    expect((await view(id)).available).toEqual({ kind: 'release', release: revision.gameVersion })
    expect((await h.app.specs.desired(h.db, await h.server(id))).spec.env[STOP_CHEATERS_ENV]).toBeUndefined()
    await h.app.setups.compat.refresh()
  }, 60_000)

  test('without the join reporter, a start writes the public default: nothing removes nobody', async () => {
    const { owner, id } = await running('Bea')
    await h.app.stopCheaters.set(owner, id, true, randomUUID())
    const written = async () => {
      const env = (await h.app.specs.desired(h.db, await h.server(id))).spec.env
      return Buffer.from(env[STOP_CHEATERS_ENV] ?? '', 'base64').toString('utf8')
    }
    const before = tuning()
    installTuning({ ...before, stopCheaters: FIXTURE })
    try {
      // No reporter stored, as in development: the configured removals would go nowhere.
      expect(await written()).toBe(DEFAULT_PUNISHMENTS)
      await withReporter(async () => expect(await written()).toContain(FIXTURE.punishments))
    } finally {
      installTuning(before)
    }
  }, 60_000)

  test('the configured file, and an official server’s own at the same path, which wins', async () => {
    const { owner, id } = await running('Rae')
    await h.app.stopCheaters.set(owner, id, true, randomUUID())
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const before = tuning()
    installTuning({ ...before, stopCheaters: FIXTURE })
    try {
      expect((await stopCheatersAtStart(h.db, id, revision, [])).placed?.punishments).toBe(
        FIXTURE.punishments,
      )
      const official = [
        { path: PUNISHMENTS_FILE, content: 'official: true\n' },
        { path: 'plugins/Other/a.yml', content: 'a: 1\n' },
      ]
      const start = await stopCheatersAtStart(h.db, id, revision, official)
      expect(start.placed?.punishments).toBe('official: true\n')
      expect(start.officialFiles.map((file) => file.path)).toEqual(['plugins/Other/a.yml'])
    } finally {
      installTuning(before)
    }
  }, 60_000)

  test('the owner’s own settings are said, and “Use Cubepals’ settings” takes over at the next start', async () => {
    const { owner, id } = await running('Sol')
    await h.app.stopCheaters.set(owner, id, true, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    await recordStartMark(h.db, id, 'own')
    expect((await view(id)).own).toBe(true)
    await h.app.stopCheaters.useOurs(owner, id, randomUUID())
    expect((await h.app.specs.desired(h.db, await h.server(id))).spec.env.BLOCKLY_STOP_CHEATERS_OURS).toBe(
      'TRUE',
    )
    await h.until(id, 'running')
    await h.settled(id)
    // The access sync after the start read Cubepals' file back, and the ask is done.
    expect((await view(id)).own).toBe(false)
    expect(await setting(id)).toMatchObject({ takeOver: false })
  }, 60_000)
})

describe.skipIf(!hasDatabase)('removals and the ban they bring', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  // Each removal a moment of its own, as a server reports them.
  let moment = Date.now()
  const removed = (uuid: string, reason: string, at = new Date(++moment)) => ({
    kind: 'removed' as const,
    at: at.toISOString(),
    uuid,
    name: 'Cheater',
    reason,
  })

  /** Gives a server the moderation tools as its revision has them, as the Players page's switch does. */
  const withTools = async (id: string) => {
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const pin = (projectId: string): PinnedMod => ({
      source: { catalog: 'modrinth', projectId, versionId: `${projectId}-1` },
      name: projectId,
      versionLabel: '1',
      artifact: {
        ref: { kind: 'remote', url: 'https://cdn.example.test/x.jar' },
        sha512: 'x',
        sizeBytes: 1,
        fileName: 'x.jar',
      },
      environment: 'server',
      loaders: ['paper'],
      gameVersions: [],
      origin: 'user',
      requiredBy: [],
    })
    await h.db
      .update(schema.serverRevisions)
      .set({ mods: [pin(LIBERTYBANS), pin(LUCKPERMS)] })
      .where(eq(schema.serverRevisions.id, revision.id))
  }

  const bans = (id: string) =>
    h.db.select().from(schema.serverModerationActions).where(eq(schema.serverModerationActions.serverId, id))

  test('with the moderation tools, impossible removals reaching the rule bring one ban for the rule’s length', async () => {
    const { id } = await running('Tam')
    await withTools(id)
    const before = tuning()
    installTuning({ ...before, stopCheaters: FIXTURE })
    try {
      const uuid = randomUUID()
      await h.app.stopCheaters.recordRemovals(id, [removed(uuid, 'movement'), removed(uuid, 'speed')])
      await h.app.stopCheaters.recordRemovals(id, [removed(uuid, 'impossible'), removed(uuid, 'impossible')])
      expect(await bans(id)).toHaveLength(0)
      await h.app.stopCheaters.recordRemovals(id, [removed(uuid, 'impossible'), removed(uuid, 'impossible')])
      const given = await bans(id)
      expect(given).toHaveLength(1)
      expect(given[0]).toMatchObject({
        playerUuid: uuid,
        kind: 'ban',
        minutes: FIXTURE.ban.minutes,
        reason: BAN_REASON,
        requestedBy: STOP_CHEATERS_ACTOR,
      })
      // On the player's history, where the owner can lift it.
      const history = await h.app.stopCheaters.view(
        await h.server(id),
        await loadRevision(h.db, (await h.server(id)).desiredRevisionId),
      )
      expect(history.removals).toHaveLength(6)
      expect(history.removals[0]?.player).toEqual({ uuid, name: 'Cheater' })
      expect(history.today).toBe(6)
    } finally {
      installTuning(before)
    }
  }, 60_000)

  test('without the moderation tools, or the setting, there are only removals', async () => {
    const { id } = await running('Uma')
    const uuid = randomUUID()
    const events = Array.from({ length: 5 }, () => removed(uuid, 'impossible'))
    const before = tuning()
    installTuning({ ...before, stopCheaters: FIXTURE })
    try {
      await h.app.stopCheaters.recordRemovals(id, events)
    } finally {
      installTuning(before)
    }
    const other = await running('Vic')
    await withTools(other.id)
    await h.app.stopCheaters.recordRemovals(other.id, events)
    expect(await bans(id)).toHaveLength(0)
    expect(await bans(other.id)).toHaveLength(0)
    expect(await countRemovals(h.db, id, null)).toBe(5)
  }, 60_000)

  test('a batch sent again keeps each removal once, and brings no ban the player didn’t earn', async () => {
    const { id } = await running('Ash')
    await withTools(id)
    const before = tuning()
    installTuning({ ...before, stopCheaters: FIXTURE })
    try {
      const uuid = randomUUID()
      const batch = [removed(uuid, 'impossible', new Date(1000)), removed(uuid, 'impossible', new Date(2000))]
      await h.app.stopCheaters.recordRemovals(id, batch)
      // The reporter heard no answer and sent the same batch twice more.
      await h.app.stopCheaters.recordRemovals(id, batch)
      await h.app.stopCheaters.recordRemovals(id, batch)
      expect(await countRemovals(h.db, id, null)).toBe(2)
      expect(await bans(id)).toHaveLength(0)
    } finally {
      installTuning(before)
    }
  }, 60_000)

  test('what isn’t a removal is passed over', async () => {
    const { id } = await running('Wren')
    await h.app.stopCheaters.recordRemovals(id, [
      removed('not-a-uuid', 'speed'),
      removed(randomUUID(), 'flying'),
      { kind: 'left', at: new Date().toISOString(), uuid: randomUUID(), reason: 'speed' },
    ])
    expect(await countRemovals(h.db, id, null)).toBe(0)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a server that sleeps instead of stopping', () => {
  beforeAll(async () => {
    await begin()
    h.runtime.sleeps.on = true
  }, 30_000)
  afterAll(end)

  const sleep = async (owner: UserActor, id: string) => {
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('suspended')
  }

  /** Wakes it: whether it booted, rather than resumed as it slept. */
  const wake = async (owner: UserActor, id: string) => {
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const [last] = await h.db
      .select({ steps: schema.serverOperations.steps })
      .from(schema.serverOperations)
      .where(and(eq(schema.serverOperations.serverId, id), eq(schema.serverOperations.kind, 'start')))
      .orderBy(desc(schema.serverOperations.createdAt))
      .limit(1)
    return (last?.steps ?? []).some((entry) => entry.step === 'booting')
  }

  test('published while asleep, it boots once at its next wake to place it, then wakes as it slept', async () => {
    const { owner, id } = await running('Zed')
    await sleep(owner, id)
    await h.app.listings.setPublic(owner, id, true)
    expect(await wake(owner, id)).toBe(true)
    expect(punishments(id)).toBe(DEFAULT_PUNISHMENTS)
    await sleep(owner, id)
    expect(await wake(owner, id)).toBe(false)
    expect(await applies(id)).toBe(0)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('STOP_CHEATERS unset in production', () => {
  beforeAll(() => begin({ stopCheatersProblem: 'unset' }), 30_000)
  afterAll(end)

  const raised = async () => (await h.app.alerts.sweep()).raised.includes('stop_cheaters_default')

  test('an admin alert says so only once a server runs Stop cheaters, with Grim placed', async () => {
    const paper = await running('Xan')
    expect(await raised()).toBe(false)
    // On, but where Grim can't run: a modded server, and a release with no Grim build yet.
    const modded = await running('Yul', 'plus', 'fabric')
    await h.app.listings.setPublic(modded.owner, modded.id, true)
    expect(await raised()).toBe(false)
    const { gameVersion } = await loadRevision(h.db, (await h.server(paper.id)).desiredRevisionId)
    await h.db
      .delete(schema.compatPlugins)
      .where(and(eq(schema.compatPlugins.projectId, GRIM), eq(schema.compatPlugins.gameVersion, gameVersion)))
    await h.app.listings.setPublic(paper.owner, paper.id, true)
    expect(await raised()).toBe(false)
    // Grim pinned for its release again: it runs at the next start, and the alert says so. With no
    // join reporter stored, another says it removes nobody; once one is, that one clears.
    await h.app.setups.compat.refresh()
    const swept = await h.app.alerts.sweep()
    expect(swept.raised).toContain('stop_cheaters_default')
    expect(swept.raised).toContain('stop_cheaters_no_reporter')
    await withReporter(async () =>
      expect((await h.app.alerts.sweep()).cleared).toContain('stop_cheaters_no_reporter'),
    )
  }, 90_000)
})
