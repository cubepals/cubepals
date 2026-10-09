/**
 * The MinecraftServer state machine. Commands are what people and systems ask for; outcomes are
 * what workers report back. Both are decided here, without touching infrastructure, so services
 * (accepting a request) and workers (re-validating before they act) agree on every transition.
 */

export type ServerStatus =
  | 'provisioning'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'updating'
  | 'restoring'
  | 'relocating'
  | 'failed'
  | 'deleted'
  | 'purged'
  /** Its world is being packed away, and then its compute and storage let go. Brief. */
  | 'storing'
  /**
   * Nobody played for a while, so its world sits in the archive store and it holds no compute and
   * no storage. A join or a start brings it back from that copy.
   */
  | 'stored'

export type StopReason = 'user' | 'idle' | 'policy' | 'entitlement' | 'crash' | 'maintenance' | 'session_cap'

/** The phase an operation was in when it failed; retry resumes it. */
export type Phase = 'provisioning' | 'starting' | 'stopping' | 'updating' | 'restoring' | 'relocating'

export type OperationKind =
  | 'provision'
  | 'start'
  | 'stop'
  | 'restart'
  | 'apply'
  | 'relocate'
  | 'backup'
  | 'archive'
  | 'restore'
  | 'access_sync'
  | 'prune_worlds'
  | 'decommission'
  | 'purge'
  | 'store'
  | 'unstore'

interface Failure {
  during: Phase
  message: string
  operationId: string
  /**
   * What would fix it, where Blockly recognised the failure in the server's own output
   * (`minecraft/diagnosis.ts`). Absent when nothing did, and the message stands on its own.
   */
  remedy?: string
}

export interface Lifecycle {
  status: ServerStatus
  stopReason: StopReason | null
  failure: Failure | null
}

export type Command =
  | { type: 'start' }
  | { type: 'stop'; reason: StopReason }
  | { type: 'restart' }
  /** A new revision, a world switch or a resize. */
  | { type: 'apply' }
  /** Back to an earlier revision. From a failure it boots that revision again. */
  | { type: 'rollback' }
  | { type: 'restore' }
  | { type: 'relocate' }
  | { type: 'retry' }
  | { type: 'delete' }
  /** `stored`: its world was stored away when it was deleted, and comes back stored. */
  | { type: 'undelete'; stored: boolean }

export type Decision =
  /** Accepted: move to `to`, and enqueue `operation` when there is work to do. */
  | { kind: 'accept'; to: Lifecycle; operation: OperationKind | null }
  /** Already where the command leads; succeed without doing anything. */
  | { kind: 'noop' }
  | { kind: 'invalid' }

export type Outcome =
  | { type: 'provisioned' }
  | { type: 'started' }
  | { type: 'stopped'; reason: StopReason }
  | { type: 'crashed' }
  | { type: 'updated'; running: boolean; reason?: StopReason }
  /** A server that comes back stopped says why: its owner's choice, or policy refusing the boot. */
  | { type: 'restored'; running: boolean; reason?: StopReason }
  | { type: 'relocated'; running: boolean; reason?: StopReason }
  /** A restart's stop half is done; its start half begins (§10: stopping → starting). */
  | { type: 'restarting' }
  | { type: 'failed'; failure: Failure }
  /** Policy changed between the request and the work (a kill switch, a suspension). */
  | { type: 'refused'; reason: StopReason }
  | { type: 'purged' }
  /** Its world is safely in the archive store; its compute and storage are being let go. */
  | { type: 'storing' }
  /** It holds nothing but the stored copy of its world: stored away, or put back after a wake failed. */
  | { type: 'stored' }

export class InvalidTransition extends Error {
  readonly from: ServerStatus
  readonly event: string

  constructor(from: ServerStatus, event: string) {
    super(`A server that is ${from} cannot take ${event}`)
    this.name = 'InvalidTransition'
    this.from = from
    this.event = event
  }
}

const TERMINAL: readonly ServerStatus[] = ['deleted', 'purged']

const moving = (status: ServerStatus): Lifecycle => ({ status, stopReason: null, failure: null })
const accept = (status: ServerStatus, operation: OperationKind | null): Decision => ({
  kind: 'accept',
  to: moving(status),
  operation,
})

const RETRY: Record<Phase, { status: ServerStatus; operation: OperationKind }> = {
  provisioning: { status: 'provisioning', operation: 'provision' },
  starting: { status: 'starting', operation: 'start' },
  stopping: { status: 'stopping', operation: 'stop' },
  updating: { status: 'updating', operation: 'apply' },
  restoring: { status: 'restoring', operation: 'restore' },
  relocating: { status: 'relocating', operation: 'relocate' },
}

export function decide(current: Lifecycle, command: Command): Decision {
  const { status } = current
  switch (command.type) {
    case 'start':
      if (status === 'stopped') return accept('starting', 'start')
      // Its world comes back from the stored copy while nothing routes to it, so the access
      // record is back on the files before anyone can join (§15.1), then it boots.
      if (status === 'stored') return accept('restoring', 'unstore')
      // Already coming up: a second join or press waits for the same boot.
      if (status === 'starting' || status === 'running' || status === 'restoring') return { kind: 'noop' }
      return { kind: 'invalid' }
    case 'stop':
      if (status === 'running') return accept('stopping', 'stop')
      if (status === 'stopping' || status === 'stopped' || status === 'storing' || status === 'stored')
        return { kind: 'noop' }
      return { kind: 'invalid' }
    case 'restart':
      if (status === 'running') return accept('stopping', 'restart')
      if (status === 'stopped') return accept('starting', 'start')
      if (status === 'stored') return accept('restoring', 'unstore')
      if (status === 'starting') return { kind: 'noop' }
      return { kind: 'invalid' }
    case 'apply':
      if (status === 'running') return accept('updating', 'apply')
      // A stopped server keeps its new desired config; the next start boots it.
      if (status === 'stopped') return { kind: 'accept', to: current, operation: null }
      return { kind: 'invalid' }
    case 'rollback':
      if (status === 'running') return accept('updating', 'apply')
      if (status === 'stopped') return { kind: 'accept', to: current, operation: null }
      if (status === 'failed') return accept('starting', 'start')
      return { kind: 'invalid' }
    case 'restore':
      if (status === 'running' || status === 'stopped' || status === 'failed')
        return accept('restoring', 'restore')
      return { kind: 'invalid' }
    case 'relocate':
      // A failed server can be moved too, off a lost host or out of a remapped region: it ends
      // stopped, and its failure goes with the move.
      if (status === 'running' || status === 'stopped' || status === 'failed')
        return accept('relocating', 'relocate')
      return { kind: 'invalid' }
    case 'retry': {
      if (status !== 'failed' || current.failure === null) return { kind: 'invalid' }
      const next = RETRY[current.failure.during]
      return accept(next.status, next.operation)
    }
    case 'delete':
      if (TERMINAL.includes(status)) return { kind: 'noop' }
      return accept('deleted', 'decommission')
    case 'undelete':
      // A world that was stored when its server was deleted is still only in the store: the
      // server comes back stored, never stopped with storage it no longer has.
      if (status === 'deleted')
        return {
          kind: 'accept',
          to: command.stored
            ? { status: 'stored', stopReason: null, failure: null }
            : { status: 'stopped', stopReason: 'user', failure: null },
          operation: null,
        }
      return { kind: 'invalid' }
  }
}

const stoppedBecause = (reason: StopReason): Lifecycle => ({
  status: 'stopped',
  stopReason: reason,
  failure: null,
})
const settledAt = (running: boolean, reason: StopReason = 'user'): Lifecycle =>
  running ? moving('running') : stoppedBecause(reason)

/** Applies a worker-reported outcome, or throws InvalidTransition when it does not fit. */
export function transition(current: Lifecycle, outcome: Outcome): Lifecycle {
  const { status } = current
  const fits = (...from: ServerStatus[]) => {
    if (!from.includes(status)) throw new InvalidTransition(status, outcome.type)
  }
  switch (outcome.type) {
    case 'provisioned':
      fits('provisioning')
      return moving('running')
    case 'started':
      fits('starting')
      return moving('running')
    case 'stopped':
      fits('stopping')
      return stoppedBecause(outcome.reason)
    case 'crashed':
      // A crash while starting is the start operation's failure, not reconciliation's finding.
      fits('running')
      return stoppedBecause('crash')
    case 'updated':
      fits('updating')
      return settledAt(outcome.running, outcome.reason)
    case 'restored':
      fits('restoring')
      return settledAt(outcome.running, outcome.reason)
    case 'relocated':
      fits('relocating')
      return settledAt(outcome.running, outcome.reason)
    case 'restarting':
      fits('stopping')
      return moving('starting')
    case 'failed':
      // A restart that fails in its stop half fails as the start it was on its way to (§9).
      if (outcome.failure.during === 'starting') fits('starting', 'stopping')
      else fits(outcome.failure.during)
      return { status: 'failed', stopReason: null, failure: outcome.failure }
    case 'refused':
      fits('starting')
      return stoppedBecause(outcome.reason)
    case 'storing':
      fits('stopped')
      return moving('storing')
    case 'stored':
      // Stored away; or put back, whole, after bringing it back failed.
      fits('storing', 'restoring')
      return { status: 'stored', stopReason: null, failure: null }
    case 'purged':
      fits('deleted')
      return { status: 'purged', stopReason: null, failure: null }
  }
}

/** Statuses whose server is reachable at its address (routes exist for these). */
export const ROUTABLE: readonly ServerStatus[] = [
  'stopped',
  // A join is what wakes a stored world, so its address keeps resolving.
  'stored',
  'starting',
  'running',
  'stopping',
  'updating',
  'relocating',
]
