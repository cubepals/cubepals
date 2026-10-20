// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The join reporter (`reporter.ts`): stored as the control plane starts, placed on a Paper server
 * at its start where `JOIN_REPORTER` says, with where it reports, handed to that server over its own
 * link, and never a reason for a sleeping server to boot rather than wake, or for drift.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { REPORT_ENV } from '../../minecraft/runtime-spec.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { deriveServerSecret, singleKey } from '../secrets.ts'
import { installTuning, tuning } from '../tuning.ts'
import { storedArtifact } from './persistence.ts'
import { useReporterJar } from './reporter.ts'

const folder = mkdtempSync(join(tmpdir(), 'reporter-'))
const jar = randomBytes(2_000)
const sha512 = createHash('sha512').update(jar).digest('hex')

describe.skipIf(!hasDatabase)('the join reporter', () => {
  let h: Harness
  const deployed = tuning()
  const placing = (joinReporter: 'off' | 'official' | 'all') =>
    installTuning({ ...deployed, joins: { reporter: joinReporter } })

  beforeAll(async () => {
    writeFileSync(join(folder, 'cubepals-reporter.jar'), jar)
    useReporterJar(join(folder, 'cubepals-reporter.jar'))
    h = await startHarness({ capabilities: { archives: new MemoryStore(), billing: null } })
    const deadline = Date.now() + 10_000
    while ((await storedArtifact(h.db, sha512)) === null && Date.now() < deadline) await Bun.sleep(50)
  }, 30_000)

  afterEach(() => installTuning(deployed))

  afterAll(async () => {
    await h.close()
    useReporterJar()
    rmSync(folder, { recursive: true, force: true })
  })

  /** A Smooth server: Paper, no plugins of its owner's. */
  const smooth = async () => {
    const server = await h.create(await h.user(), { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return server.id
  }
  const desired = async (id: string) => h.app.specs.desired(h.db, await h.server(id))
  const reporterLine = (env: Readonly<Record<string, string>>) =>
    (env.BLOCKLY_JARS ?? '').split('\n').find((line) => line.includes(sha512))

  test('is kept in the store as the control plane starts, and never collected as unused', async () => {
    expect(await storedArtifact(h.db, sha512)).not.toBeNull()
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 400 * DAY_MS))
    expect(await storedArtifact(h.db, sha512)).not.toBeNull()
  })

  test('goes on every Paper server with "all", and only at a start', async () => {
    const id = await smooth()
    const without = await desired(id)
    expect(reporterLine(without.spec.env)).toBeUndefined()
    expect(without.spec.env[REPORT_ENV]).toBeUndefined()

    placing('all')
    const placed = await desired(id)
    expect(reporterLine(placed.spec.env)).toContain('plugins/')
    const token = deriveServerSecret(
      singleKey('test-runtime-secrets-key-0123456789').current.key,
      id,
      'artifacts',
    )
    expect(placed.spec.env[REPORT_ENV]).toBe(`${h.artifactsUrl}/runtime/v1/servers/${id}/joins?t=${token}`)
    // Never a reason to restart a running server, or to boot a sleeping one rather than wake it.
    expect(placed.driftDigest).toBe(without.driftDigest)
    expect(placed.spec.resumesOn).toBe(without.spec.resumesOn)

    // Its link answers the server it was placed on, as a pinned jar's does.
    const located = await h.app.artifacts.locate(id, sha512, token)
    expect(located.name).toEndWith('cubepals-reporter.jar')
  }, 30_000)

  test('with "official", only on the servers Cubepals runs', async () => {
    placing('official')
    const theirs = await smooth()
    const ours = await smooth()
    await h.db.insert(schema.publicListings).values({ serverId: ours, official: true })
    expect(reporterLine((await desired(theirs)).spec.env)).toBeUndefined()
    expect(reporterLine((await desired(ours)).spec.env)).toBeDefined()
  }, 30_000)
})
