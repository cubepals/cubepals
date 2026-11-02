// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Compatibility checks preserve normal provisioning, restart recovery and world moves through cleanup failures. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { AccessReconciler } from '../access/reconciler.ts'
import { AccessPolicy } from '../policy/access-policy.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { BootSequence } from './boot.ts'

let h: Harness
const store = new MemoryStore()
const operator = 'operator:compatibility-regression'
const canary = () => {
  const runtime = h.runtimes.get('canary')
  if (!runtime) throw new Error('The test runtime is missing')
  return runtime
}

describe.skipIf(!hasDatabase)('compatibility lifecycle integration', () => {
  beforeAll(async () => {
    await store.start()
    h = await startHarness({
      capabilities: { archives: store, billing: null },
      otherRuntimes: [{ provider: 'canary' }],
    })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
  })
  test('policy changes between admission and the worker preserve stopped servers', policyChanges, 30_000)
  test(
    'a restart repairs a missing runtime binding without losing the existing world',
    missingBinding,
    30_000,
  )
  test('boot recovery rebuilds the desired spec on provision and restart', recovery, 30_000)
  test('first-start fallback survives best-effort cleanup failures', fallback, 30_000)
  test('moves preserve world bytes through best-effort import and cleanup failures', moves, 60_000)
})

async function recovery() {
  const owner = await h.user('Recover', 'plus')
  const seen = new Set<string>()
  const original = BootSequence.prototype.run
  const run = spyOn(BootSequence.prototype, 'run').mockImplementation(async function (
    this: BootSequence,
    ...args
  ) {
    const [ctx, , , , reprovision] = args
    if (reprovision && !seen.has(ctx.op.kind)) {
      seen.add(ctx.op.kind)
      await reprovision()
    }
    return original.apply(this, args)
  })
  try {
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.restart(owner, id, randomUUID())
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(seen).toEqual(new Set(['provision', 'restart']))
  } finally {
    run.mockRestore()
  }
}

async function fallback() {
  for (const full of [true, false]) {
    const owner = await h.user('Fallback', 'plus')
    const rule = await h.app.placement.addRule({ provider: 'canary', percent: 100 }, operator)
    const target = canary()
    target.fillOnProvision('local', full)
    if (!full) target.failBootWhen(() => 'the sandbox exited')
    const destroy = spyOn(target, 'destroy').mockRejectedValueOnce(new Error('provider cleanup unavailable'))
    try {
      const { id } = await h.create(owner)
      await h.until(id, 'running')
      await h.settled(id)
      expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).provider).toBe('fake')
      expect((await h.app.placement.where(id)).decisions[0]?.kind).toBe('fell_back')
      destroy.mockRestore()
      await h.app.schedules.orphans()
      expect(target.machine(id)).toBeNull()
    } finally {
      destroy.mockRestore()
      target.fillOnProvision('local', false)
      target.failBootWhen(() => null)
      await h.app.placement.changeRule(rule.id, { enabled: false }, operator)
    }
  }
}

async function moves() {
  for (const failRestore of [false, true]) {
    const owner = await h.user('Move', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(h.minecraft.path(id, 'world/kept.txt'), 'world before compatibility checks')
    const original = AccessReconciler.prototype.reconcile
    const access = spyOn(AccessReconciler.prototype, 'reconcile').mockImplementation(async function (
      this: AccessReconciler,
      ...args
    ) {
      if (args[0].id === id && args[2] === 'import') throw new Error('import reconciliation unavailable')
      return original.apply(this, args)
    })
    const target = canary()
    const targetDestroy = spyOn(target, 'destroy')
    const sourceDestroy = spyOn(h.runtime, 'destroy')
    if (failRestore) {
      target.failRestores('the new disk is unavailable')
      targetDestroy
        .mockRejectedValueOnce(new Error('cleanup unavailable'))
        .mockRejectedValueOnce(new Error('cleanup unavailable'))
    } else {
      targetDestroy.mockRejectedValueOnce(new Error('cleanup unavailable'))
      sourceDestroy.mockRejectedValueOnce(new Error('cleanup unavailable'))
    }
    try {
      await h.app.placement.requestMove(id, 'canary', operator)
      await h.app.schedules.relocations()
      await h.settled(id, 30_000)
      expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).provider).toBe(
        failRestore ? 'fake' : 'canary',
      )
      expect((await h.server(id)).lifecycle.status).toBe('running')
      expect(await readFile(h.minecraft.path(id, 'world/kept.txt'), 'utf8')).toBe(
        'world before compatibility checks',
      )
    } finally {
      access.mockRestore()
      targetDestroy.mockRestore()
      sourceDestroy.mockRestore()
      target.failRestores(null)
    }
    await h.app.schedules.orphans()
    expect((failRestore ? target : h.runtime).machine(id)).toBeNull()
  }
}

async function policyChanges() {
  for (const provisioning of [true, false]) {
    const owner = await h.user('Policy changed', 'plus')
    let id: string | undefined
    if (!provisioning) {
      ;({ id } = await h.create(owner))
      await h.until(id, 'running')
      await h.settled(id)
      await h.app.servers.stop(owner, id, randomUUID())
      await h.until(id, 'stopped')
      await h.settled(id)
    }
    const original = AccessPolicy.prototype.check
    const policy = spyOn(AccessPolicy.prototype, 'check').mockImplementation(async function (
      this: AccessPolicy,
      ...args
    ) {
      const [tx, accountId, capability] = args
      if (
        accountId === owner.userId &&
        capability.kind === (provisioning ? 'continue_provisioning' : 'continue_starting')
      )
        await tx
          .update(schema.platformControls)
          .set(provisioning ? { provisioningEnabled: false } : { startsEnabled: false })
      return original.apply(this, args)
    })
    try {
      if (id === undefined) ({ id } = await h.create(owner))
      else await h.app.servers.start(owner, id, randomUUID())
      await h.settled(id)
      expect((await h.server(id)).lifecycle.status).toBe(provisioning ? 'failed' : 'stopped')
    } finally {
      policy.mockRestore()
      await h.db.update(schema.platformControls).set({ provisioningEnabled: true, startsEnabled: true })
    }
  }
}

async function missingBinding() {
  const owner = await h.user('Repair binding', 'plus')
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  await writeFile(h.minecraft.path(id, 'world/kept.txt'), 'binding repair preserves storage')
  await h.db.update(schema.serverRuntimes).set({ handle: null }).where(eq(schema.serverRuntimes.serverId, id))
  await expect(h.app.backups.createBackup(owner, id, randomUUID())).rejects.toThrow('no world to back up')
  await h.app.servers.restart(owner, id, randomUUID())
  await h.settled(id)
  expect((await h.server(id)).lifecycle.status).toBe('running')
  expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).handle).not.toBeNull()
  expect(await readFile(h.minecraft.path(id, 'world/kept.txt'), 'utf8')).toBe(
    'binding repair preserves storage',
  )
}
