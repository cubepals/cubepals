// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Handler contracts keep compatibility checks before compute and preserve stopped-world rollback semantics. */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../../testing/harness.ts'
import { loadRevision, loadRuntime, loadWorld } from '../../servers/persistence.ts'
import type { DesiredRuntime } from '../../servers/specs.ts'
import type { OperationContext } from '../runner.ts'
import { bringingUp } from './bringing-up.ts'

let h: Harness

describe.skipIf(!hasDatabase)('bringing up compatibility contracts', () => {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('restart checks an unbound runtime even when its retained applied digest matches', async () => {
    const { ctx, desired, binding } = await running()
    const stopped = new Error('checked before compute')
    for (const handle of [binding.handle, null]) {
      const preflight = mock(async () => {
        throw stopped
      })
      const handler = handlers({
        db: h.db,
        bindingOf: async () => ({ ...binding, handle }),
        specs: { desired: async () => desired },
        preflight,
      })
      await expect(handler.restart.run(ctx)).rejects.toBe(stopped)
      expect(preflight).toHaveBeenCalledWith(desired, handle === null ? null : binding.applied, ctx)
    }
  }, 30_000)

  test('start takes a stopped safety copy and returns through the starting rollback contract', async () => {
    const { ctx, desired, binding } = await running()
    const changing: DesiredRuntime = {
      ...desired,
      digest: 'changed-install',
      revision: { ...desired.revision, loader: 'fabric' },
    }
    const capture = mock(async () => {
      throw new Error('snapshot unavailable')
    })
    const rollBack = mock(async () => {})
    const preflight = mock(async () => {})
    const handler = handlers({
      db: h.db,
      stillAllowed: async () => ({ ok: true }),
      bindingOf: async () => binding,
      specs: { desired: async () => changing },
      preflight,
      capture,
      rollBack,
    })
    const result = await handler.start.run(ctx)
    expect(preflight).toHaveBeenCalledWith(changing, binding.applied, ctx)
    expect(ctx.step).toHaveBeenNthCalledWith(1, 'saving')
    expect(capture).toHaveBeenCalledWith(ctx.server, binding.handle, binding.applied, 'pre_apply', false)
    expect(rollBack).toHaveBeenCalledWith(ctx, ctx.server, binding.applied, changing, null, 'starting')
    expect(result).toMatchObject({ status: 'failed', detail: 'snapshot unavailable' })
  }, 30_000)
})

/** Only the owned handler ports used by each contract are supplied; any other use fails immediately. */
function handlers(ports: Partial<Parameters<typeof bringingUp>[0]>) {
  ports.stopWhatFailed = () => async () => {
    throw new Error('Unexpected abandonment')
  }
  const deps = new Proxy({} as Parameters<typeof bringingUp>[0], {
    get(_target, key) {
      if (key in ports) return ports[key as keyof typeof ports]
      return () => {
        throw new Error(`Unexpected handler port: ${String(key)}`)
      }
    },
  })
  return bringingUp(deps)
}

async function running() {
  const owner = await h.user('Handler proof', 'plus')
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  const server = await h.server(id)
  const binding = await loadRuntime(h.db, id, ['fake'])
  const machine = h.runtime.machine(id)
  const op = (await h.operations(id)).at(-1)
  if (!binding.applied || !binding.handle || !machine || !op) throw new Error('The real fixture did not boot')
  const desired: DesiredRuntime = {
    ...binding.applied,
    digest: binding.applied.specDigest,
    driftDigest: binding.applied.driftDigest ?? binding.applied.specDigest,
    validation: { mods: [], files: [], compat: [] },
    revision: await loadRevision(h.db, server.desiredRevisionId),
    world: await loadWorld(h.db, server.activeWorldId),
    spec: machine.spec,
    install: null,
    secretsVersion: binding.applied.secretsVersion ?? 1,
    stopCheaters: binding.applied.placedStopCheaters ?? false,
    proxyProtocol: binding.applied.proxyProtocol ?? false,
    compat: binding.applied.compat ?? [],
  }
  const ctx: OperationContext = {
    server: { ...server, lifecycle: { ...server.lifecycle, status: 'starting' } },
    op: { ...op, kind: 'start' },
    step: mock(async () => {}),
    mark: async () => {},
    reached: () => null,
    stillApplies: async () => true,
  }
  return { ctx, desired, binding }
}
