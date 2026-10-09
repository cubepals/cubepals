/**
 * What one heartbeat does to the registry: the certificate the node must present, its report
 * applied in one transaction, and the fences sent back for copies it must not run.
 * New certificates are issued in `renewal.ts`; how a node's health is judged lives in `node.ts`;
 * which blocklyd the answer offers is `upgrades.ts`.
 */
import type { Db, Queryable } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { event, exec, jsonb, one, rows, textArray, toDate } from '../sql.ts'
import type {
  Fence,
  HeartbeatRequest,
  HeartbeatResponse,
  NodeAddresses,
  UpgradeOffer,
  WorkloadReport,
} from '../wire.ts'
import { ADDRESS, HOST } from './enrollment.ts'
import { getNode, type NodeRow, Refused, type RegistryOptions } from './node.ts'
import { rollout } from './upgrades.ts'

// ─── heartbeats ─────────────────────────────────────────────────────────────────────────────

/** How long after a session switch a beat from the previous session may still be in flight. */
const LATE_BEAT_SECONDS = 15

type Certificate = 'current' | 'next'

/** Which of the node's certificates the peer presented, if either: any other is refused. */
export function certificateOf(node: NodeRow, peerCertSha256: string): Certificate | null {
  if (node.cert_sha256 !== null && node.cert_sha256 === peerCertSha256) return 'current'
  if (node.next_cert_sha256 !== null && node.next_cert_sha256 === peerCertSha256) return 'next'
  return null
}

/**
 * One heartbeat: the node's whole state, applied in one transaction, answered with the copies it
 * holds that are superseded and the lease for what it does unasked. `peerCertSha256` is the client
 * certificate the TLS layer verified.
 */
export async function heartbeat(
  db: Db,
  options: RegistryOptions,
  nodeId: string,
  peerCertSha256: string,
  request: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  if (request?.nodeId !== nodeId)
    throw new Refused(400, 'invalid_request', 'the heartbeat is for another node')
  const outcome = await db.transaction(
    async (t): Promise<{ response: HeartbeatResponse } | { refused: Refused }> => {
      const node = await getNode(t, nodeId, true)
      if (node === null) throw new Refused(404, 'unknown_node', 'no such node')
      if (node.lifecycle === 'retired') throw new Refused(403, 'retired', 'this node is retired')
      const certificate = certificateOf(node, peerCertSha256)
      if (certificate === null)
        throw new Refused(403, 'certificate_not_current', "this certificate is not the node's current one")

      const session = sessionOf(node, request)
      if (session === 'duplicate') {
        // Committed, not rolled back with the refusal: the quarantine must outlast this beat.
        if (node.duplicate_seen_at === null) {
          await t.execute(sql`UPDATE fleet_nodes SET duplicate_seen_at = now() WHERE id = ${node.id}`)
          await event(t, 'node.duplicate_identity', {
            node: node.id,
            data: { current: node.session_id, other: request.sessionId, otherSeq: request.seq },
          })
        }
        return {
          refused: new Refused(409, 'duplicate_identity', 'another host is beating with this identity'),
        }
      }
      if (session === 'replaced')
        return {
          refused: new Refused(409, 'session_replaced', 'a newer daemon session reports for this node'),
        }
      if (certificate === 'next') {
        await t.execute(sql`
        UPDATE fleet_nodes SET cert_sha256 = next_cert_sha256, cert_expires_at = next_cert_expires_at,
          next_cert_sha256 = NULL, next_cert_expires_at = NULL WHERE id = ${node.id}`)
        await event(t, 'node.certificate_renewed', { node: node.id })
      }
      const upgrade =
        session === 'stale'
          ? undefined
          : await apply(t, node, request, session === 'switched', options.release)
      const fences = await fencesFor(t, nodeId)
      const renewDue =
        certificate === 'current' &&
        node.cert_seconds_left !== null &&
        node.cert_seconds_left < options.renewDays * 86_400
      return {
        response: {
          lifecycle: node.lifecycle,
          fences,
          heartbeatSeconds: options.heartbeatSeconds,
          // A node an operator declared lost restarts nothing on its own: a copy of it may run elsewhere.
          leaseSeconds: node.lifecycle === 'lost' ? 0 : options.leaseSeconds,
          ...(renewDue ? { renew: true } : {}),
          upgrade,
        },
      }
    },
  )
  if ('refused' in outcome) throw outcome.refused
  return outcome.response
}

/**
 * Which daemon session a beat is from. A new session is a daemon restart. The previous one
 * beating again after its in-flight window, or a new one far into its count while the current one
 * still beats, is a second host with this identity: quarantined, and an operator decides.
 */
export function sessionOf(
  node: Pick<NodeRow, 'session_id' | 'heartbeat_seq' | 'previous_session_id' | 'session_age' | 'age'>,
  request: Pick<HeartbeatRequest, 'sessionId' | 'seq'>,
): 'current' | 'switched' | 'stale' | 'replaced' | 'duplicate' {
  if (node.session_id === request.sessionId)
    return request.seq > Number(node.heartbeat_seq) ? 'current' : 'stale'
  const sinceSwitch = node.session_age ?? Number.POSITIVE_INFINITY
  const currentFresh = node.age !== null && node.age < 30
  if (request.sessionId === node.previous_session_id)
    return sinceSwitch > LATE_BEAT_SECONDS ? 'duplicate' : 'replaced'
  // A restarted daemon starts counting at 1. One far into its count while the current session
  // still beats has been running all along, somewhere else.
  if (node.session_id !== null && request.seq > 3 && currentFresh) return 'duplicate'
  return 'switched'
}

/** Addresses a node reports, when they are addresses and nothing more. */
function validAddresses(addresses: NodeAddresses | null | undefined): NodeAddresses | null {
  if (!addresses) return null
  if (!ADDRESS.test(addresses.api) || !HOST.test(addresses.edge) || !HOST.test(addresses.control)) return null
  return addresses
}

/** The report applied to the node's row and its copies; returns the upgrade to offer it, if any. */
async function apply(
  t: Queryable,
  node: NodeRow,
  request: HeartbeatRequest,
  switched: boolean,
  release: UpgradeOffer | null | undefined,
): Promise<UpgradeOffer | undefined> {
  const addresses = validAddresses(request.addresses)
  const moved =
    addresses !== null &&
    (addresses.api !== node.api_address ||
      addresses.edge !== node.edge_host ||
      addresses.control !== node.control_host)
  await t.execute(sql`
    UPDATE fleet_nodes SET
      last_heartbeat_at = now(), heartbeat_seq = ${request.seq}, session_id = ${request.sessionId},
      previous_session_id = CASE WHEN ${switched} THEN session_id ELSE previous_session_id END,
      session_started_at = CASE WHEN ${switched} OR session_started_at IS NULL THEN now() ELSE session_started_at END,
      boot_id = ${request.bootId}, runtime_up = ${request.runtimeUp}, reconciled = ${request.reconciled},
      capacity = ${jsonb(request.capacity)}, daemon_version = ${request.daemonVersion},
      features = ${jsonb(request.features)}, issues = ${jsonb(request.issues)},
      api_address = ${addresses?.api ?? node.api_address}, edge_host = ${addresses?.edge ?? node.edge_host},
      control_host = ${addresses?.control ?? node.control_host}, updated_at = now()
    WHERE id = ${node.id}`)
  if (moved)
    await event(t, 'node.addresses_changed', {
      node: node.id,
      data: {
        from: { api: node.api_address, edge: node.edge_host, control: node.control_host },
        to: addresses,
      },
    })
  if (switched && node.session_id !== null)
    await event(t, 'node.daemon_restarted', { node: node.id, data: { seq: request.seq } })
  if (node.boot_id !== null && request.bootId !== null && node.boot_id !== request.bootId)
    await event(t, 'node.rebooted', { node: node.id })
  if (
    node.lifecycle === 'lost' &&
    (node.last_heartbeat_at === null ||
      (node.lost_at !== null && toDate(node.last_heartbeat_at) < toDate(node.lost_at)))
  )
    await event(t, 'node.returned_while_lost', { node: node.id, data: { fencedBy: node.fenced_by } })

  await observe(t, node, request.workloads)
  // What the node no longer reports, it no longer holds.
  await t.execute(sql`
    DELETE FROM fleet_observations
    WHERE node_id = ${node.id} AND NOT (workload = ANY(${textArray(request.workloads.map((r) => r.id))}))`)
  return rollout(t, node, request, release)
}

/**
 * Every copy a node reports, in one statement that writes only the reports that changed: most
 * beats write nothing here, so the cost grows with what happens, not with how many servers there
 * are. How fresh an unchanged report is, the node's `last_heartbeat_at` says.
 */
async function observe(t: Queryable, node: NodeRow, reported: WorkloadReport[]): Promise<void> {
  const written = await rows<{ workload: string; inserted: boolean }>(
    t,
    sql`INSERT INTO fleet_observations (node_id, workload, epoch, superseded_by, state, spec_digest, report)
        SELECT ${node.id}, r->>'id', (r->>'epoch')::bigint, (r->>'supersededBy')::bigint, r->>'state',
               r->>'specDigest', r
        FROM jsonb_array_elements(${jsonb(reported)}) AS r
        ON CONFLICT (node_id, workload) DO UPDATE SET
          epoch = EXCLUDED.epoch, superseded_by = EXCLUDED.superseded_by, spec_digest = EXCLUDED.spec_digest,
          report = EXCLUDED.report, observed_at = now(),
          state_changed_at = CASE WHEN fleet_observations.state = EXCLUDED.state
                                  AND fleet_observations.epoch IS NOT DISTINCT FROM EXCLUDED.epoch
                             THEN fleet_observations.state_changed_at ELSE now() END,
          state = EXCLUDED.state
        WHERE fleet_observations.report IS DISTINCT FROM EXCLUDED.report
        RETURNING workload, (xmax = 0) AS inserted`,
  )
  const changed = new Set(written.map((w) => w.workload))
  const withEpochs = reported.filter((r) => r.epoch !== null)
  if (withEpochs.length === 0) return
  const placements = await rows<{ workload: string; epoch: string; node_id: string | null }>(
    t,
    sql`SELECT workload, epoch, node_id FROM fleet_placements
        WHERE workload = ANY(${textArray(withEpochs.map((r) => r.id))})`,
  )
  const placementOf = new Map(placements.map((p) => [p.workload, p]))
  for (const report of withEpochs) {
    const epoch = report.epoch ?? 0
    const current = placementOf.get(report.id)
    if (current === undefined || epoch <= Number(current.epoch)) continue
    // A node knows a newer epoch than the database: the database was restored from a backup. The
    // epoch only ever rises, so the placement adopts it when the node is the placement's own.
    if (current.node_id === node.id) {
      const adopted = await exec(
        t,
        sql`UPDATE fleet_placements SET epoch = ${epoch}, updated_at = now()
            WHERE workload = ${report.id} AND epoch < ${epoch}`,
      )
      if (adopted > 0) await event(t, 'epoch.adopted', { node: node.id, workload: report.id, epoch })
    } else if (changed.has(report.id))
      await event(t, 'epoch.conflict', {
        node: node.id,
        workload: report.id,
        epoch,
        data: { placementEpoch: Number(current.epoch), placementNode: current.node_id },
      })
  }
  for (const { workload } of written.filter((w) => w.inserted)) {
    const report = withEpochs.find((r) => r.id === workload)
    if (report === undefined) continue
    if (!placementOf.has(workload)) {
      await event(t, 'copy.orphaned', {
        node: node.id,
        workload,
        epoch: report.epoch,
        data: { state: report.state },
      })
      continue
    }
    // A copy from an epoch that ended because its host was declared lost: whatever it played since
    // the backup it was rebuilt from exists only here. A fork, kept for its owner.
    const ended = await one<{ end_reason: string | null }>(
      t,
      sql`SELECT end_reason FROM fleet_placement_history WHERE workload = ${workload} AND epoch = ${report.epoch}`,
    )
    if (ended?.end_reason === 'lost') {
      const current = placementOf.get(workload)
      await event(t, 'fork.detected', {
        node: node.id,
        workload,
        epoch: report.epoch,
        data: { state: report.state, currentEpoch: current ? Number(current.epoch) : null },
      })
    }
  }
}

/**
 * The copies a node holds from an epoch older than their server's current one. Not a copy a new
 * epoch is being placed onto on its own node (a restore in place): the new epoch's PUT takes it
 * over, and a fence first would keep it from ever running again.
 */
async function fencesFor(q: Queryable, nodeId: string): Promise<Fence[]> {
  const found = await rows<{ workload: string; epoch: string }>(
    q,
    sql`SELECT o.workload, p.epoch FROM fleet_observations o
        JOIN fleet_placements p ON p.workload = o.workload
        WHERE o.node_id = ${nodeId} AND o.epoch IS NOT NULL AND o.epoch < p.epoch
          AND (o.superseded_by IS NULL OR o.superseded_by < p.epoch)
          AND NOT (p.node_id = o.node_id AND p.state = 'placing')
        UNION ALL
        -- A copy of no placement at all: its server was destroyed while its node couldn't be
        -- reached, or the database was restored from before the server existed. Either way it
        -- must never run; one epoch past its own fences it, and server ids are never reused.
        SELECT o.workload, o.epoch + 1 FROM fleet_observations o
        WHERE o.node_id = ${nodeId} AND o.epoch IS NOT NULL AND o.superseded_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM fleet_placements p WHERE p.workload = o.workload)`,
  )
  return found.map((r) => ({ workload: r.workload, currentEpoch: Number(r.epoch) }))
}
