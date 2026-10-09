/**
 * The calls the fleet runtime makes to a node's workload API (blocklyd's docs/protocol.md): each
 * one's method, path, epoch, headers and timeout, and nothing else. A node's refusal or silence
 * comes back as `NodeRefused` or `NodeUnreachable`, untouched.
 *
 * It decides nothing: what the ledger records around a call is the caller's (`ledger.ts`,
 * `admission.ts`), and how an archive is offered in parts is `transfers.ts`'s.
 */
import type { RuntimeSpec } from '../../../app/ports/runtime.ts'
import { CONFIRM_DELETE_HEADER, type NodeAddress, type NodeClient } from '../node-client.ts'
import type { NodeRow } from '../registry.ts'
import type {
  DeleteResponse,
  EnsureResponse,
  ExecResponse,
  ExportResponse,
  FenceResponse,
  PowerResponse,
  RestoreResponse,
  SnapshotResponse,
  WorkloadSpec,
  WorkloadView,
} from '../wire.ts'

/**
 * Teardown (fence, delete) stops a running copy gracefully first, which takes the spec's grace
 * plus the node's margin: a shorter wait would give up on a delete the node goes on to finish.
 */
const TEARDOWN_MS = 10 * 60_000
export const TRANSFER_MS = 3 * 3_600_000

/** A node as the runtime dials it. */
type Dialled = Pick<NodeRow, 'id' | 'api_address'>

export const address = (node: Dialled): NodeAddress => ({ id: node.id, apiAddress: node.api_address })

function toWorkloadSpec(spec: RuntimeSpec): WorkloadSpec {
  return {
    image: spec.image,
    ...(spec.entrypoint ? { entrypoint: [...spec.entrypoint] } : {}),
    env: { ...spec.env },
    secrets: { ...spec.secrets },
    resources: { memoryMb: spec.resources.memoryMb },
    storage: { mountPath: spec.storage.mountPath, sizeGb: spec.storage.sizeGb },
    ports: spec.ports.map((p) => ({
      name: p.name,
      containerPort: p.port,
      protocol: p.protocol,
      audience: [...p.audience],
    })),
    stop: { signal: spec.stop.signal, timeoutSeconds: spec.stop.timeoutSeconds },
    // Fly's and Docker's runtimes start a failing server again three times; blocklyd does it
    // itself, and only while its execution lease lasts: never a fenced copy, nor long without the
    // control plane. After a host reboot it starts again what was running, once the control
    // plane's answer has fenced its copies of servers placed elsewhere meanwhile and granted it a
    // lease.
    restart: { policy: 'on-failure', maxRetries: 3 },
    labels: { ...spec.labels },
  }
}

export class WorkloadApi {
  readonly #nodes: Pick<NodeClient, 'call'>

  constructor(nodes: Pick<NodeClient, 'call'>) {
    this.#nodes = nodes
  }

  /** The node's copy of the workload, as it is now. */
  view(node: Dialled, key: string): Promise<WorkloadView> {
    return this.#nodes.call<WorkloadView>(address(node), 'GET', `/v1/workloads/${key}`)
  }

  put(node: Dialled, key: string, spec: RuntimeSpec, epoch: number): Promise<EnsureResponse> {
    return this.#nodes.call<EnsureResponse>(address(node), 'PUT', `/v1/workloads/${key}`, {
      body: toWorkloadSpec(spec),
      epoch,
      // A first PUT may pull the image.
      timeoutMs: 20 * 60_000,
    })
  }

  power(node: Dialled, key: string, epoch: number, verb: 'start' | 'stop' | 'kill'): Promise<PowerResponse> {
    return this.#nodes.call<PowerResponse>(address(node), 'POST', `/v1/workloads/${key}/${verb}`, {
      epoch,
      timeoutMs: verb === 'stop' ? TEARDOWN_MS : 60_000,
    })
  }

  snapshot(
    node: Dialled,
    key: string,
    epoch: number,
    body: { id: string; quiesced: boolean },
  ): Promise<SnapshotResponse> {
    return this.#nodes.call<SnapshotResponse>(address(node), 'POST', `/v1/workloads/${key}/snapshots`, {
      body,
      epoch,
      timeoutMs: TRANSFER_MS,
    })
  }

  /** An upload or export of an archive, to where `body` says. */
  send(node: Dialled, path: string, body: Record<string, unknown>, epoch?: number): Promise<ExportResponse> {
    return this.#nodes.call<ExportResponse>(address(node), 'POST', path, {
      body,
      ...(epoch === undefined ? {} : { epoch }),
      timeoutMs: TRANSFER_MS,
    })
  }

  dropSnapshot(node: Dialled, key: string, localId: string): Promise<unknown> {
    return this.#nodes.call(address(node), 'DELETE', `/v1/workloads/${key}/snapshots/${localId}`, {
      timeoutMs: TEARDOWN_MS,
    })
  }

  restore(
    node: Dialled,
    key: string,
    epoch: number,
    source: { snapshot: string } | { url: string; sha256: string | null },
  ): Promise<RestoreResponse> {
    const body =
      'snapshot' in source
        ? { snapshot: source.snapshot }
        : { url: source.url, ...(source.sha256 ? { sha256: source.sha256 } : {}) }
    return this.#nodes.call<RestoreResponse>(address(node), 'POST', `/v1/workloads/${key}/restore`, {
      body,
      epoch,
      timeoutMs: TRANSFER_MS,
    })
  }

  exec(
    node: Dialled,
    key: string,
    epoch: number,
    command: readonly string[],
    timeoutSeconds: number,
  ): Promise<ExecResponse> {
    return this.#nodes.call<ExecResponse>(address(node), 'POST', `/v1/workloads/${key}/exec`, {
      body: { command: [...command], timeoutSeconds },
      epoch,
      timeoutMs: (timeoutSeconds + 15) * 1000,
    })
  }

  /** Compute goes; the data stays on the node (`retained`). */
  deleteKeepingData(node: Dialled, key: string, epoch: number): Promise<DeleteResponse> {
    return this.#nodes.call<DeleteResponse>(address(node), 'DELETE', `/v1/workloads/${key}?data=keep`, {
      epoch,
      timeoutMs: TEARDOWN_MS,
    })
  }

  /** Compute and data go, into the node's trash, confirmed by naming the workload again. */
  deleteWithData(node: Dialled, key: string, epoch: number): Promise<DeleteResponse> {
    return this.#nodes.call<DeleteResponse>(address(node), 'DELETE', `/v1/workloads/${key}?data=delete`, {
      epoch,
      headers: { [CONFIRM_DELETE_HEADER]: key },
      timeoutMs: TEARDOWN_MS,
    })
  }

  /** The workload is at `currentEpoch` elsewhere: an older copy here stops and never runs again. */
  fence(node: Dialled, key: string, currentEpoch: number): Promise<FenceResponse> {
    return this.#nodes.call<FenceResponse>(address(node), 'POST', `/v1/workloads/${key}/fence`, {
      body: { currentEpoch },
      timeoutMs: TEARDOWN_MS,
    })
  }
}
