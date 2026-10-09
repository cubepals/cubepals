/**
 * The registry as placement and operators read it: each node with the ledger's reservations on it,
 * and the health upkeep records for it.
 * It changes no node's lifecycle (`lifecycle.ts`) and takes no report from a node (`heartbeat.ts`).
 */
import type { Db, Queryable } from '@blockly/db'
import { sql } from 'drizzle-orm'
import type { Health, Thresholds } from '../health.ts'
import type { NodeView } from '../placement.ts'
import { event, one, rows } from '../sql.ts'
import { healthOf, NODE_COLUMNS, type NodeRow } from './node.ts'
import { listeningSeconds } from './presence.ts'

// ─── the registry as placement and operators see it ─────────────────────────────────────────

export interface NodeSummary extends NodeRow {
  allocated: { memoryMb: number; cpuMillis: number; diskGb: number; workloads: number }
  running: { memoryMb: number; cpuMillis: number; workloads: number }
  derivedHealth: Health
}

/**
 * Whether placement `p` holds memory and CPU on its node, `o` being its node's report of the copy:
 * while it is being made; while the node reports the copy in use; and from a start until the node
 * reports the copy stopped. A copy made and not yet started (`created`) keeps a start's claim. A
 * sleeping server holds none of either, only its disk (docs/fleet.md, "Admission").
 */
const HOLDS = sql.raw(`(
  p.state = 'placing'
  OR (p.state = 'placed' AND (
    COALESCE(o.state IN ('creating', 'running', 'restarting', 'stopping'), false)
    OR (p.desired_power = 'running' AND NOT COALESCE(
      o.state IN ('stopped', 'crashed', 'missing', 'retained', 'fenced')
        AND o.state_changed_at >= p.power_changed_at, false))
  ))
)`)

/** Whether a server's placement holds memory on its node now, as the ledger counts it. */
export async function holdsMemory(q: Queryable, workload: string): Promise<boolean> {
  const row = await one<{ holds: boolean }>(
    q,
    sql`SELECT ${HOLDS} AS holds FROM fleet_placements p
        LEFT JOIN fleet_observations o ON o.node_id = p.node_id AND o.workload = p.workload
        WHERE p.workload = ${workload}`,
  )
  return row?.holds === true
}

/** Every node that isn't retired, with the ledger's reservations on it. */
export async function nodeSummaries(
  q: Queryable,
  thresholds: Thresholds,
  options: { includeRetired?: boolean } = {},
): Promise<NodeSummary[]> {
  const listening = await listeningSeconds(q)
  const found = await rows<
    NodeRow & {
      alloc_memory: string
      alloc_cpu: string
      alloc_disk: string
      alloc_count: string
      run_memory: string
      run_cpu: string
      run_count: string
    }
  >(
    q,
    sql`SELECT ${NODE_COLUMNS},
          COALESCE(SUM(p.memory_mb) FILTER (WHERE p.state IN ('placing', 'placed')), 0) AS alloc_memory,
          COALESCE(SUM(p.cpu_millis) FILTER (WHERE p.state IN ('placing', 'placed')), 0) AS alloc_cpu,
          COALESCE(SUM(p.disk_gb) FILTER (WHERE p.state IN ('placing', 'placed', 'displaced')), 0) AS alloc_disk,
          COUNT(p.workload) FILTER (WHERE p.state IN ('placing', 'placed')) AS alloc_count,
          COALESCE(SUM(p.memory_mb) FILTER (WHERE ${HOLDS}), 0) AS run_memory,
          COALESCE(SUM(p.cpu_millis) FILTER (WHERE ${HOLDS}), 0) AS run_cpu,
          COUNT(p.workload) FILTER (WHERE ${HOLDS}) AS run_count
        FROM fleet_nodes n
        LEFT JOIN fleet_placements p ON p.node_id = n.id
        LEFT JOIN fleet_observations o ON o.node_id = p.node_id AND o.workload = p.workload
        WHERE ${sql.raw(options.includeRetired ? 'TRUE' : "n.lifecycle <> 'retired'")}
        GROUP BY n.id ORDER BY n.name, n.id`,
  )
  return found.map((row) => ({
    ...row,
    allocated: {
      memoryMb: Number(row.alloc_memory),
      cpuMillis: Number(row.alloc_cpu),
      diskGb: Number(row.alloc_disk),
      workloads: Number(row.alloc_count),
    },
    running: {
      memoryMb: Number(row.run_memory),
      cpuMillis: Number(row.run_cpu),
      workloads: Number(row.run_count),
    },
    derivedHealth: healthOf(row, thresholds, listening),
  }))
}

export function toNodeView(node: NodeSummary): NodeView {
  const c = node.capacity
  return {
    id: node.id,
    name: node.name,
    regionKey: node.region_key,
    lifecycle: node.lifecycle,
    health: node.derivedHealth,
    quarantined: node.duplicate_seen_at !== null,
    features: node.features,
    capacity: {
      allocatableMemoryMb: c.allocatableMemoryMb ?? 0,
      cpus: c.cpus ?? 0,
      reservedCpuMillis: c.reservedCpuMillis ?? 0,
      diskTotalBytes: c.diskTotalBytes ?? null,
      diskAvailableBytes: c.diskAvailableBytes ?? null,
      minFreeDiskMb: c.minFreeDiskMb ?? 0,
      portsTotal: c.portsTotal ?? 0,
      portsAllocated: c.portsAllocated ?? 0,
    },
    allocated: node.allocated,
    running: node.running,
  }
}

/** Health as upkeep records it: a change is written once, with an event, so it can be read back. */
export async function recordHealth(
  db: Db,
  thresholds: Thresholds,
): Promise<Array<{ node: NodeRow; from: Health; to: Health }>> {
  const listening = await listeningSeconds(db)
  const found = await rows<NodeRow>(
    db,
    sql`SELECT ${NODE_COLUMNS} FROM fleet_nodes n WHERE n.lifecycle <> 'retired'`,
  )
  const changed: Array<{ node: NodeRow; from: Health; to: Health }> = []
  for (const node of found) {
    const to = healthOf(node, thresholds, listening)
    if (to === node.health) continue
    await db.execute(sql`UPDATE fleet_nodes SET health = ${to}, health_since = now() WHERE id = ${node.id}`)
    await event(db, 'node.health', {
      node: node.id,
      data: { from: node.health, to, ageSeconds: node.age === null ? null : Math.round(node.age * 10) / 10 },
    })
    changed.push({ node, from: node.health, to })
  }
  return changed
}
