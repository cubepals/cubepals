// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared runtime evidence: exact cache identity, scoped artifacts, retry and temporary resource ownership. */
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ArtifactLinks } from '../artifacts/links.ts'
import { ArtifactNotFound } from '../artifacts/service.ts'
import { validationArtifact } from '../artifacts/validation-artifacts.ts'
import { type RuntimeHandle, runtimeKey } from '../ports/runtime.ts'
import { singleKey } from '../secrets.ts'
import { loadRevision } from '../servers/persistence.ts'
import { validationKey, validationSpec } from './validation-plan.ts'
import { IncompatibleMods, ValidationUnavailable } from './validation-runtime.ts'

describe.skipIf(!hasDatabase)('shared mod configuration evidence', () => {
  let h: Harness
  const cdn = new Cdn()
  const secrets = singleKey('validation-test-artifact-secret-0123456789')
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness({ runtimeSecrets: secrets })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })
  test(
    'queued, failed and duplicate jobs retain correct evidence and cleanup ownership',
    () => queuedLifecycle(h, cdn),
    30_000,
  )
  test(
    'exact runtime evidence is shared, scoped to its files and invalidated by any changed input',
    () => validationCache(h, cdn, secrets),
    30_000,
  )
  test(
    'temporary provider failures remain retryable and revoke old attempt access',
    () => validationRetry(h, cdn),
    30_000,
  )
  test(
    'a real loader refusal is cached and leaves no check resource',
    () => validationRefusal(h, cdn),
    30_000,
  )
})

async function validationCache(h: Harness, cdn: Cdn, secrets: ReturnType<typeof singleKey>) {
  const owner = await h.user('Verification', 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const mod = cdn.publish('cache-check')
  const plan = await h.app.configuration.plan({ ...revision, mods: [mod] })
  if (plan === null) throw new Error('Missing validation plan')
  await expect(h.app.configuration.plan({ ...revision, serverId: randomUUID() })).rejects.toThrow(
    'unavailable',
  )
  expect(await h.app.configuration.request(revision)).toBeNull()
  expect((await h.app.configuration.request({ ...revision, mods: [mod] }))?.state).toBe('checking')
  const [first, second] = await Promise.all([
    h.app.modValidation.ensure(plan),
    h.app.modValidation.ensure(plan),
  ])
  expect(first.state).toBe('verified')
  expect(first.key).toBe(second.key)
  const [record] = await h.db
    .select()
    .from(schema.modValidations)
    .where(eq(schema.modValidations.key, first.key))
  expect(record?.evidence?.installed).toContain(mod.artifact.sha512)
  expect(record?.handle).toBeNull()
  const downloads = cdn.downloads
  await h.app.modValidation.ensure(plan)
  expect(cdn.downloads).toBe(downloads)
  for (const changed of [
    { ...plan, loaderVersion: '0.19.6' },
    { ...plan, gameVersion: '26.2' },
    { ...plan, memoryTier: '8g' },
    { ...plan, mods: [{ ...mod, artifact: { ...mod.artifact, sha512: 'b'.repeat(128) } }] },
    { ...plan, mods: [{ ...mod, loaders: ['datapack'] }] },
    { ...plan, files: [{ path: 'config/check.toml', content: 'different' }] },
  ])
    expect(validationKey(changed)).not.toBe(first.key)
  const configured = {
    ...plan,
    files: [
      { path: 'config/a.toml', content: 'a' },
      { path: 'config/b.toml', content: 'b' },
    ],
    mods: [mod, cdn.publish('second-cache-mod')],
  }
  expect(
    validationKey({
      ...configured,
      files: [...configured.files].reverse(),
      mods: [...configured.mods].reverse(),
    }),
  ).toBe(validationKey(configured))
  expect(validationKey({ ...plan, settings: { ...plan.settings, motd: 'A new server name' } })).toBe(
    first.key,
  )
  expect(() =>
    validationSpec({ ...plan, memoryTier: 'unoffered' }, id, 'password', () => 'http://example.test/mod.jar'),
  ).toThrow('Unknown validation server size')
  const spec = validationSpec(plan, id, 'check-password', () => 'http://example.test/mod.jar')
  expect(spec.ports.every((port) => port.audience.every((audience) => audience === 'control'))).toBe(true)
  expect(spec.labels['blockly.purpose']).toBe('mod-validation')
  if (record === undefined) throw new Error('Missing evidence')
  expect(await validationArtifact(h.db, record.runtimeId, mod.artifact.sha512)).toBeNull()
  const scopeId = randomUUID()
  const scopePlan = { ...plan, storageGb: plan.storageGb + 1 }
  const scopeKey = validationKey(scopePlan)
  const leaseUntil = new Date(Date.now() + MINUTE_MS)
  await h.db
    .insert(schema.modValidations)
    .values({ key: scopeKey, plan: scopePlan, runtimeId: scopeId, leaseUntil })
  await h.db.insert(schema.modValidationRuns).values({ id: scopeId, key: scopeKey, leaseUntil })
  expect((await validationArtifact(h.db, scopeId, mod.artifact.sha512))?.artifact.sha512).toBe(
    mod.artifact.sha512,
  )
  const link = new URL(new ArtifactLinks(h.artifactsUrl, secrets).forServer(scopeId)(mod.artifact))
  const token = link.searchParams.get('t') ?? ''
  expect((await h.app.artifacts.locate(scopeId, mod.artifact.sha512, token)).artifact.sizeBytes).toBe(
    mod.artifact.sizeBytes,
  )
  expect(await validationArtifact(h.db, scopeId, '0'.repeat(128))).toBeNull()
  await h.db
    .update(schema.modValidationRuns)
    .set({ finishedAt: new Date() })
    .where(eq(schema.modValidationRuns.id, scopeId))
  expect(await validationArtifact(h.db, scopeId, mod.artifact.sha512)).toBeNull()
  await expect(h.app.artifacts.locate(scopeId, mod.artifact.sha512, token)).rejects.toBeInstanceOf(
    ArtifactNotFound,
  )
  await h.app.modValidation.importGaveUp(first.key, 'late queue failure')
  expect((await h.app.modValidation.status(first.key)).state).toBe('verified')
}

async function validationRefusal(h: Harness, cdn: Cdn) {
  const owner = await h.user('Rejected', 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const plan = await h.app.configuration.plan({ ...revision, mods: [cdn.publish('bad-loader-check')] })
  if (plan === null) throw new Error('Missing validation plan')
  h.minecraft.breakOn((env) =>
    env.MODS?.includes('bad-loader-check')
      ? "Mod 'Waystones' (waystones) 21.1.25 requires any version of balm, which is missing!"
      : null,
  )
  try {
    const refusal = await h.app.modValidation.ensure(plan).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(IncompatibleMods)
    const state = await h.app.modValidation.status(validationKey(plan))
    expect((refusal as Error).message).toBe(state.message ?? '')
    expect(state.state).toBe('blocked')
    expect(state.checkedAt).toBeString()
    expect(state.message?.length).toBeGreaterThan(0)
    const downloads = cdn.downloads
    await expect(h.app.modValidation.ensure(plan)).rejects.toBeInstanceOf(IncompatibleMods)
    expect(cdn.downloads).toBe(downloads)
    const [record] = await h.db
      .select()
      .from(schema.modValidations)
      .where(eq(schema.modValidations.key, state.key))
    expect(record?.handle).toBeNull()
    const provision = spyOn(h.runtime, 'ensureProvisioned')
    try {
      await h.app.modValidation.runImport(state.key)
      expect(provision.mock.calls).toHaveLength(0)
      await h.app.modValidation.importGaveUp(state.key, 'late failed delivery')
      expect((await h.app.modValidation.status(state.key)).state).toBe('blocked')
      await h.db
        .update(schema.modValidations)
        .set({ message: null })
        .where(eq(schema.modValidations.key, state.key))
      const error = await h.app.modValidation.ensure(plan).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(IncompatibleMods)
      expect((error as Error).message.length).toBeGreaterThan(0)
    } finally {
      provision.mockRestore()
    }
  } finally {
    h.minecraft.breakOn(() => null)
  }
}

async function validationRetry(h: Harness, cdn: Cdn) {
  const owner = await h.user('Retry check', 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const mod = cdn.publish('retry-check')
  const plan = await h.app.configuration.plan({ ...revision, mods: [mod] })
  if (plan === null) throw new Error('Missing validation plan')
  const queued = spyOn(h.jobs, 'enqueueModValidation').mockResolvedValue(undefined)
  const outage = new Error('Provider connection closed')
  const provision = spyOn(h.runtime, 'ensureProvisioned').mockRejectedValue(outage)
  try {
    const error = await h.app.modValidation.ensure(plan).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ValidationUnavailable)
    expect((error as Error).cause).toBe(outage)
    const key = validationKey(plan)
    expect((await h.app.modValidation.status(key)).state).toBe('unavailable')
    const [failed] = await h.db.select().from(schema.modValidations).where(eq(schema.modValidations.key, key))
    if (failed === undefined) throw new Error('Missing failed check')
    expect(await validationArtifact(h.db, failed.runtimeId, mod.artifact.sha512)).toBeNull()
    // A temporary failure observes its cooldown; the next eligible request gets a fresh attempt.
    expect((await h.app.modValidation.request(plan)).state).toBe('unavailable')
    expect(queued.mock.calls).toHaveLength(1)
    await h.db
      .update(schema.modValidations)
      .set({ checkedAt: new Date(Date.now() - 2 * MINUTE_MS) })
      .where(eq(schema.modValidations.key, key))
    provision.mockRestore()
    expect((await h.app.modValidation.ensure(plan)).state).toBe('verified')
    expect(queued.mock.calls).toHaveLength(2)
    const [retried] = await h.db
      .select()
      .from(schema.modValidations)
      .where(eq(schema.modValidations.key, key))
    expect(retried?.runtimeId).not.toBe(failed.runtimeId)
    expect(await validationArtifact(h.db, failed.runtimeId, mod.artifact.sha512)).toBeNull()
  } finally {
    provision.mockRestore()
    queued.mockRestore()
  }
}

async function queuedLifecycle(h: Harness, cdn: Cdn) {
  const owner = await h.user('Durable queue', 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const plan = await h.app.configuration.plan({ ...revision, mods: [cdn.publish('durable-queue')] })
  if (plan === null) throw new Error('Missing validation plan')
  const key = validationKey(plan)
  const queued = spyOn(h.jobs, 'enqueueModValidation').mockResolvedValue(undefined)
  const provision = h.runtime.ensureProvisioned.bind(h.runtime)
  const handles = new Map<string, RuntimeHandle>()
  const capture = spyOn(h.runtime, 'ensureProvisioned').mockImplementation(async (...args) => {
    const handle = await provision(...args)
    handles.set(args[0], handle)
    return handle
  })
  const destroyed = spyOn(h.runtime, 'destroy')
  try {
    const missing = 'missing-configuration-evidence'
    expect(await h.app.modValidation.status(missing)).toMatchObject({
      key: missing,
      state: 'unavailable',
      checkedAt: null,
    })
    expect((await h.app.modValidation.status(missing)).message?.length).toBeGreaterThan(0)
    await h.app.modValidation.runImport(missing)
    expect(capture.mock.calls).toHaveLength(0)
    expect(await h.app.modValidation.request(plan)).toMatchObject({
      key,
      state: 'checking',
      message: null,
      checkedAt: null,
    })
    expect((await h.app.modValidation.status(key)).state).toBe('checking')
    expect(queued.mock.calls).toHaveLength(1)
    await h.app.modValidation.importGaveUp(key, 'The queued attempt exhausted its retries')
    const failed = await h.app.modValidation.status(key)
    expect(failed.state).toBe('unavailable')
    expect(failed.message?.length).toBeGreaterThan(0)
    expect(failed.checkedAt).toBeString()
    await expect(h.app.modValidation.ensure(plan)).rejects.toBeInstanceOf(ValidationUnavailable)
    expect(queued.mock.calls).toHaveLength(1)
    const now = Date.now()
    setSystemTime(new Date(now))
    try {
      await h.db
        .update(schema.modValidations)
        .set({ checkedAt: new Date(now - MINUTE_MS) })
        .where(eq(schema.modValidations.key, key))
      expect(await h.app.modValidation.request(plan)).toMatchObject({ state: 'checking', message: null })
      expect(await h.app.modValidation.status(key)).toMatchObject({ state: 'checking', message: null })
      expect(queued.mock.calls).toHaveLength(2)
    } finally {
      setSystemTime()
    }
    const [reserved] = await h.db
      .select()
      .from(schema.modValidations)
      .where(eq(schema.modValidations.key, key))
    if (reserved === undefined) throw new Error('Missing queued ownership')
    await h.app.modValidation.runImport(key)
    const verified = await h.app.modValidation.status(key)
    expect(verified.state).toBe('verified')
    expect(verified.checkedAt).toBeString()
    const record = await evidenceRecord(h, key)
    const handle = handles.get(record.runtimeId)
    if (handle === undefined) throw new Error('The actual provider handle was not retained')
    const count = () =>
      destroyed.mock.calls.filter(
        ([value]) =>
          value === runtimeKey(record.runtimeId) ||
          value === runtimeKey(reserved.runtimeId) ||
          value === handle,
      ).length
    expect(count()).toBe(1)
    await h.app.modValidation.runImport(key)
    expect(count()).toBe(1)
    expect(
      (await h.db.select().from(schema.modValidationRuns).where(eq(schema.modValidationRuns.key, key)))
        .length,
    ).toBe(1)
    for (const residue of [
      { handle, leaseUntil: null },
      { handle: null, leaseUntil: new Date(Date.now() + MINUTE_MS) },
    ]) {
      await h.db.update(schema.modValidations).set(residue).where(eq(schema.modValidations.key, key))
      const before = count()
      await h.app.modValidation.runImport(key)
      expect(count()).toBe(before + 1)
      const cleaned = await evidenceRecord(h, key)
      expect(cleaned).toMatchObject({
        state: 'verified',
        runtimeId: record.runtimeId,
        handle: null,
        leaseUntil: null,
      })
    }
    await h.db
      .update(schema.modValidations)
      .set({ checkedAt: new Date(Date.now() - 2 * MINUTE_MS) })
      .where(eq(schema.modValidations.key, key))
    expect((await h.app.modValidation.request(plan)).state).toBe('verified')
    expect(queued.mock.calls).toHaveLength(2)
  } finally {
    setSystemTime()
    destroyed.mockRestore()
    capture.mockRestore()
    queued.mockRestore()
  }
}

async function evidenceRecord(h: Harness, key: string) {
  const [record] = await h.db.select().from(schema.modValidations).where(eq(schema.modValidations.key, key))
  if (record === undefined) throw new Error('Missing configuration evidence')
  return record
}
