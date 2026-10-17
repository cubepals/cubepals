// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a node's heartbeat may change, and what it may not: a node speaks for its own copies only,
 * a second host with its identity is given nothing to act on, and the ledger takes a copy as made
 * only once its node has made it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Db } from '@blockly/db'
import { sql } from 'drizzle-orm'
import {
  beat,
  enrollNode,
  freshDatabase,
  hasDatabase,
  registryOptions,
  report,
  testCa,
} from '../../testing/fleet.ts'
import type { FleetCa } from './ca.ts'
import { Ledger, nextEpoch } from './fleet-runtime/ledger.ts'
import { THRESHOLDS } from './health.ts'
import { heartbeat, nodeSummaries } from './registry.ts'
import { rows } from './sql.ts'
import type { HeartbeatRequest } from './wire.ts'

let db: Db
let ca: FleetCa
let drop: () => Promise<void>

const send = (n: { id: string; sha: string }, request: HeartbeatRequest) =>
  heartbeat(db, registryOptions(), n.id, n.sha, request)

const summary = async (id: string) => (await nodeSummaries(db, THRESHOLDS)).find((n) => n.id === id)

/** The session's switch, as long ago as the previous session's beats could still be in flight. */
const pastInFlight = (id: string) =>
  db.execute(sql`UPDATE fleet_nodes SET session_started_at = now() - interval '20 seconds' WHERE id = ${id}`)

async function place(workload: string, nodeId: string, epoch: number, state = 'placed'): Promise<void> {
  await db.execute(sql`
    INSERT INTO fleet_placements (workload, node_id, epoch, state, region_key, memory_mb, cpu_millis, disk_gb,
      desired_power, power_changed_at)
    VALUES (${workload}, ${nodeId}, ${epoch}, ${state}, 'eu', 1024, 250, 2, 'running', now())`)
  await db.execute(sql`
    INSERT INTO fleet_placement_history (workload, epoch, node_id, reason)
    VALUES (${workload}, ${epoch}, ${nodeId}, 'placed')`)
}

beforeAll(async () => {
  if (!hasDatabase) return
  ;({ db, drop } = await freshDatabase())
  ca = await testCa()
  await db.execute(sql`INSERT INTO fleet_endpoints VALUES ('test', now() - interval '1 hour', now())`)
})
afterAll(() => drop?.())

describe.skipIf(!hasDatabase)('the lease, and who may beat for a node', () => {
  test('a second host beating with a new session gets no lease and no edge, then or once caught', async () => {
    const a = await enrollNode(db, ca, 'clone-lease', { apiAddress: '10.0.0.5:7443' })
    for (let seq = 1; seq <= 3; seq++) await send(a, beat(a, 'original', seq))
    const elsewhere = { addresses: { api: '10.0.0.9:7443', edge: '10.0.0.9', control: '10.0.0.9' } }
    // A copy of the disk boots: a new session while the original still beats.
    expect((await send(a, beat(a, 'clone', 1, [], elsewhere))).leaseSeconds).toBe(0)
    expect((await send(a, beat(a, 'clone', 2, [], elsewhere))).leaseSeconds).toBe(0)
    expect((await summary(a.id))?.edge_host).toBe('10.0.0.5')
    // The original beats on past the in-flight window, and is caught.
    await pastInFlight(a.id)
    await expect(send(a, beat(a, 'original', 4))).rejects.toMatchObject({ code: 'duplicate_identity' })
    // Quarantined: nothing resumes on its own until an operator decides, and the edge stays put.
    expect((await send(a, beat(a, 'clone', 3, [], elsewhere))).leaseSeconds).toBe(0)
    expect((await summary(a.id))?.edge_host).toBe('10.0.0.5')
  })

  test('a rebooted node gets its lease, and is reached at its new address, once the old session is past', async () => {
    const a = await enrollNode(db, ca, 'reboot-lease', { apiAddress: '10.0.0.6:7443' })
    expect((await send(a, beat(a, 'one', 1))).leaseSeconds).toBe(120)
    const rebooted = {
      bootId: 'boot-2',
      addresses: { api: '10.0.0.7:7443', edge: '10.0.0.7', control: '10.0.0.7' },
    }
    expect((await send(a, beat(a, 'two', 1, [], rebooted))).leaseSeconds).toBe(0)
    await pastInFlight(a.id)
    expect((await send(a, beat(a, 'two', 2, [], rebooted))).leaseSeconds).toBe(120)
    expect((await summary(a.id))?.edge_host).toBe('10.0.0.7')
  })
})

describe.skipIf(!hasDatabase)('epochs, as nodes report them', () => {
  test('an epoch past the exact integers is refused', async () => {
    const a = await enrollNode(db, ca, 'epoch-exact')
    await expect(send(a, beat(a, 's', 1, [report('w-exact', 2 ** 53)]))).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      send(a, beat(a, 's', 1, [report('w-exact', 1, { supersededBy: 2 ** 53 })])),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test("a server's next epoch counts its own nodes' reports, and no other node's", async () => {
    const a = await enrollNode(db, ca, 'epoch-home')
    const b = await enrollNode(db, ca, 'epoch-other')
    await place('w-far', a.id, 1)
    await send(b, beat(b, 's', 1, [report('w-far', Number.MAX_SAFE_INTEGER - 1)]))
    expect(await nextEpoch(db, 'w-far')).toBe(2)
    await send(a, beat(a, 's', 1, [report('w-far', 1, { state: 'fenced', supersededBy: 6 })]))
    expect(await nextEpoch(db, 'w-far')).toBe(7)
  })
})

describe.skipIf(!hasDatabase)('a first placement, as its node reports it', () => {
  test('one whose copy is still being made waits for it, and is undone if it never is', async () => {
    const ledger = new Ledger({ db, deployment: 'test' })
    const a = await enrollNode(db, ca, 'pulling')
    await place('w-pull', a.id, 1, 'placing')
    await db.execute(
      sql`UPDATE fleet_placements SET updated_at = now() - interval '31 minutes' WHERE workload = 'w-pull'`,
    )
    // The node took the PUT and is pulling the image.
    await send(a, beat(a, 's', 1, [report('w-pull', 1, { state: 'creating', ports: {} })]))
    expect(await ledger.finishReported()).toBe(0)
    expect(await ledger.abandonUnmade()).toBe(0)
    const state = async () =>
      (
        await rows<{ state: string }>(db, sql`SELECT state FROM fleet_placements WHERE workload = 'w-pull'`)
      )[0]?.state
    expect(await state()).toBe('placing')
    // The pull fails, and the node forgets the copy: the placement goes, and its room with it.
    await send(a, beat(a, 's', 2, []))
    expect(await ledger.abandonUnmade()).toBe(1)
    expect(await state()).toBeUndefined()
    expect((await summary(a.id))?.running.memoryMb).toBe(0)
  })

  test('one whose copy is made is finished from its report', async () => {
    const ledger = new Ledger({ db, deployment: 'test' })
    const a = await enrollNode(db, ca, 'made')
    await place('w-made', a.id, 1, 'placing')
    await db.execute(
      sql`UPDATE fleet_placements SET updated_at = now() - interval '1 minute' WHERE workload = 'w-made'`,
    )
    await send(a, beat(a, 's', 1, [report('w-made', 1, { state: 'created' })]))
    expect(await ledger.finishReported()).toBe(1)
  })
})
