// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Machines asleep with their memory kept, as Fly suspends one: the switches tests flip (whether a
 * sleep suspends at all, the provider refusing one, dropping what one kept, or a wake that hangs,
 * freezes, wedges or finds no room on its host), and what a sleep and a wake do to one machine. Which verbs sleep or wake a machine, and that a stop ends
 * one asleep, are `fake-runtime.ts`'s; what its workload does meanwhile is the workload's.
 */
import { HostFull, type ObservedState, type RuntimeSpec } from '../../../app/ports/runtime.ts'
import { Hold } from './hold.ts'

/**
 * `suspended`: asleep with its memory kept; the port reads it stopped. `resuming`: on its way back
 * from it, where a hung resume stays until it is stopped, and `wedged`, one no stop ends either;
 * the port reads both starting.
 */
export type MachineState = 'stopped' | 'running' | 'crashed' | 'suspended' | 'resuming' | 'wedged'

/** A machine's state as the port reads it. */
export const observedAs = (state: MachineState): ObservedState =>
  state === 'suspended' ? 'stopped' : state === 'resuming' || state === 'wedged' ? 'starting' : state

interface Sleeper {
  key: string
  spec: RuntimeSpec
  state: MachineState
  changedAt: Date
}

/** What runs on a machine, as far as a sleep reaches it: frozen, thawed, or let go. */
interface Workload<M> {
  stop(machine: M): Promise<void>
  suspend?(machine: M): Promise<void>
  resume?(machine: M): Promise<void>
}

/**
 * A workload a stop ends: running, asleep with its memory kept, or on its way back from it. Asked
 * of a wedged one, it throws what Fly answers a stop of it (community.fly.io/t/28766).
 */
export function holds(machine: { state: MachineState }): boolean {
  if (machine.state === 'wedged') throw new Error('unable to stop machine, current state invalid, starting')
  return machine.state === 'running' || machine.state === 'suspended' || machine.state === 'resuming'
}

export class Sleeps {
  /** Whether a sleep suspends, as FLY_SUSPEND switches Fly's; off, the runtime has no `sleep`. */
  on = false
  /** Every suspend refused, as by a provider that can't this time: the sleep stops instead. */
  refused = false
  /** Machines asleep whose memory the provider dropped: their next start boots from storage. */
  readonly #dropped = new Set<string>()
  /** How the next wake of each machine goes wrong, as a test says (`hang`, `freeze`, `fillHost`). */
  readonly #stalls = new Map<string, 'hang' | 'wedge' | 'freeze' | 'full'>()
  /** The spec each machine asleep went to sleep on: a start on another drops what it kept. */
  readonly #slept = new Map<string, string>()
  readonly #held = new Hold()

  /**
   * The next `count` sleeps or wakes wait, as a suspend writing memory out does, until the returned
   * function lets them go.
   */
  hold(count: number): () => void {
    return this.#held.hold(count)
  }

  /** The provider drops the memory a machine asleep kept, as on a host move: its next start boots. */
  drop(key: string): void {
    this.#dropped.add(key)
  }

  /**
   * The provider's next resume of this machine never finishes: it stays on its way back, running
   * nothing, until it is stopped, which drops what it kept; `wedged`, not even a stop ends it.
   */
  hang(key: string, options: { wedged?: boolean } = {}): void {
    this.#stalls.set(key, options.wedged ? 'wedge' : 'hang')
  }

  /** The provider's next resume of this machine runs it, but what runs on it stays frozen. */
  freeze(key: string): void {
    this.#stalls.set(key, 'freeze')
  }

  /**
   * The next start of this machine, asleep or not, is refused for want of room on the host its
   * storage is on (HostFull), as Fly's "insufficient resources … with existing volume".
   */
  fillHost(key: string): void {
    this.#stalls.set(key, 'full')
  }

  /** Puts a running machine to sleep, freezing what runs on it, unless refused: whether it is asleep. */
  async sleep<M>(machine: Sleeper, workload: Workload<M>, running: M): Promise<boolean> {
    await this.#held.take()
    if (machine.state === 'running' && !this.refused) {
      await workload.suspend?.(running)
      machine.state = 'suspended'
      machine.changedAt = new Date()
      this.#slept.set(machine.key, JSON.stringify(machine.spec))
    }
    return machine.state === 'suspended'
  }

  /**
   * Whether a start of `machine` on `spec` resumes it: asleep on that very spec, or on one its
   * `resumesOn` says it may wake on as it slept, as Fly's runtime reads it.
   */
  resumes(machine: Sleeper | undefined, spec: RuntimeSpec): machine is Sleeper {
    if (machine?.state !== 'suspended') return false
    const slept = this.#slept.get(machine.key)
    if (slept === JSON.stringify(spec)) return true
    return (
      spec.resumesOn !== undefined && slept !== undefined && JSON.parse(slept).resumesOn === spec.resumesOn
    )
  }

  /**
   * Wakes a machine asleep as it was, thawing what runs on it: whether it did, or is on its way
   * back from a resume that hangs (`hang`), which a start leaves so. One whose memory was dropped,
   * or whose spec changed while it slept, is let go instead, and the caller boots it.
   */
  async wake<M>(machine: Sleeper, workload: Workload<M>, running: M): Promise<boolean> {
    const stall = this.#stalls.get(machine.key)
    if (stall === 'full') {
      this.#stalls.delete(machine.key)
      throw new HostFull('fake', `no room on the host of ${machine.key}`)
    }
    if (machine.state === 'resuming' || machine.state === 'wedged') return true
    if (machine.state !== 'suspended') return false
    await this.#held.take()
    this.#stalls.delete(machine.key)
    if (stall !== undefined) {
      // Frozen, it reads running and is not: what ran on it was never thawed.
      machine.state = stall === 'freeze' ? 'running' : stall === 'wedge' ? 'wedged' : 'resuming'
      return true
    }
    const dropped = this.#dropped.delete(machine.key) || !this.resumes(machine, machine.spec)
    if (dropped) await workload.stop(running)
    else await workload.resume?.(running)
    machine.state = dropped ? 'stopped' : 'running'
    return !dropped
  }
}
