/**
 * This deployment's sandboxes at Boat, through their life: found by name, made, brought up and
 * kept up as asked, stopped and deleted, each create and resume spent from the plan's starts. It
 * runs nothing inside a sandbox, which `commands.ts` does, and never turns one into a handle,
 * which `boat-runtime.ts` does.
 */

import type { RuntimeKey } from '../../../app/ports/runtime.ts'
import { BoatApiError, type BoatClient, must, type Sandbox } from '../client.ts'
import type { BoatStarts, StartReason } from '../starts.ts'
import { COMING, UP } from './observation.ts'
import type { SandboxType } from './sizes.ts'

/** How long a sandbox may take to come up, or to stop. */
const READY_SECONDS = 600
const STOP_SECONDS = 600

export interface SandboxesOptions {
  client: BoatClient
  deploymentId: string
  /** Only its starts are spent here; whether there is room for a new server is the runtime's. */
  starts: Pick<BoatStarts, 'make'>
  /** Auto-stop for a sandbox kept running, and for one parked for work on a sleeping server. */
  runTtlSeconds: number | null
  parkTtlSeconds: number
  pause: (ms: number) => Promise<void>
}

export class Sandboxes {
  readonly #boat: BoatClient
  readonly #deployment: string
  readonly #starts: Pick<BoatStarts, 'make'>
  readonly #runTtl: number | null
  readonly #parkTtl: number
  readonly #pause: (ms: number) => Promise<void>
  /** Resumes in flight, by sandbox: a second ask while one runs waits for it, not for another. */
  readonly #resuming = new Map<string, Promise<Sandbox>>()

  constructor(options: SandboxesOptions) {
    this.#boat = options.client
    this.#deployment = options.deploymentId
    this.#starts = options.starts
    this.#runTtl = options.runTtlSeconds
    this.#parkTtl = options.parkTtlSeconds
    this.#pause = options.pause
  }

  get #prefix() {
    return `bly-${this.#deployment}-`
  }

  nameOf(key: string): string {
    return `${this.#prefix}${key.replace(/-/g, '')}`
  }

  /** The server a sandbox's name says it holds, when it is this deployment's. */
  keyOf(sandbox: Sandbox): RuntimeKey | null {
    return serverOf(sandbox.name, this.#prefix)
  }

  async get(id: string): Promise<Sandbox | null> {
    const found = await this.#boat.GET('/sandboxes/{sandboxId}', { params: { path: { sandboxId: id } } })
    if (found.response.status === 404) return null
    const sandbox = must(found, 'reading the sandbox').sandbox
    return sandbox.state === 'cancelled' ? null : sandbox
  }

  async *list(): AsyncIterable<Sandbox> {
    let cursor: string | undefined
    do {
      const page = must(
        await this.#boat.GET('/sandboxes', {
          params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
        }),
        'listing sandboxes',
      )
      for (const sandbox of page.sandboxes ?? []) if (sandbox.state !== 'cancelled') yield sandbox
      cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined
    } while (cursor)
  }

  async *named(key: RuntimeKey): AsyncIterable<Sandbox> {
    for await (const sandbox of this.list()) if (serverOf(sandbox.name, this.#prefix) === key) yield sandbox
  }

  async ours(key: RuntimeKey): Promise<Sandbox | null> {
    for await (const sandbox of this.named(key)) return sandbox
    return null
  }

  /**
   * A new sandbox for a server, under a key that names it and the sandbox it had before, so a
   * create whose answer was lost and is asked again finds the one it made. It holds none of the
   * account's secrets (`noEnv`), as Boat asks of sandboxes for other people's work.
   */
  async create(
    key: string,
    type: SandboxType,
    reason: StartReason,
    previous: string | null,
    keep: 'run' | 'park',
  ): Promise<Sandbox> {
    const ttlSeconds = keep === 'run' ? this.#runTtl : this.#parkTtl
    const created = await this.#starts.make('create', reason, key, async () =>
      must(
        await this.#boat.POST('/sandboxes', {
          params: {
            header: { 'Idempotency-Key': `blockly:${this.#deployment}:${key}:${previous ?? 'first'}` },
          },
          body: {
            type,
            ttlSeconds,
            noEnv: true,
            env: { BLOCKLY_DEPLOYMENT: this.#deployment, BLOCKLY_SERVER: key },
          },
        }),
        'creating the sandbox',
      ),
    )
    await this.rename(created.sandbox.id, this.nameOf(key))
    return created.sandbox
  }

  async rename(id: string, name: string): Promise<void> {
    must(
      await this.#boat.PATCH('/sandboxes/{sandboxId}', {
        params: { path: { sandboxId: id } },
        body: { name },
      }),
      'naming the sandbox',
    )
  }

  /**
   * The sandbox up, and kept up as `keep` says: `run` for a server that runs, `park` for one woken
   * only for work, which Boat stops by itself unless a start follows. Only a stopped sandbox is
   * resumed; one coming up is waited for, and one stopping is let finish first.
   */
  async up(
    key: string,
    found: Sandbox,
    reason: StartReason,
    keep: 'run' | 'park',
    type?: SandboxType,
  ): Promise<Sandbox> {
    const ttlSeconds = keep === 'run' ? this.#runTtl : this.#parkTtl
    let sandbox = found
    if (sandbox.state === 'archiving') sandbox = (await this.settled(sandbox.id)) ?? sandbox
    if (sandbox.state === 'error')
      throw new Error(`Boat says the sandbox failed: ${sandbox.error ?? 'no reason given'}`)
    if (sandbox.state === 'archived') return this.#resume(key, sandbox.id, reason, ttlSeconds, type)
    if (COMING.has(sandbox.state)) sandbox = await this.#ready(sandbox.id)
    must(
      await this.#boat.PATCH('/sandboxes/{sandboxId}', {
        params: { path: { sandboxId: sandbox.id } },
        body: { ttlSeconds },
      }),
      'setting when the sandbox stops',
    )
    return sandbox
  }

  #resume(
    key: string,
    id: string,
    reason: StartReason,
    ttlSeconds: number | null,
    type?: SandboxType,
  ): Promise<Sandbox> {
    const inFlight = this.#resuming.get(id)
    if (inFlight !== undefined) return inFlight
    const resumed = (async () => {
      await this.#starts
        .make('resume', reason, key, async () =>
          must(
            await this.#boat.POST('/sandboxes/{sandboxId}/resume', {
              params: { path: { sandboxId: id } },
              body: { ttlSeconds, ...(type === undefined ? {} : { type }) },
            }),
            'resuming the sandbox',
          ),
        )
        .catch((error: unknown) => {
          // Already resuming, by another process: its start is the one to wait for.
          if (!(error instanceof BoatApiError && error.status === 409)) throw error
        })
      return this.#ready(id)
    })().finally(() => this.#resuming.delete(id))
    this.#resuming.set(id, resumed)
    return resumed
  }

  async #ready(id: string): Promise<Sandbox> {
    const deadline = Date.now() + READY_SECONDS * 1000
    while (Date.now() < deadline) {
      const sandbox = await this.get(id)
      if (sandbox === null) throw new Error('The sandbox is gone')
      if (UP.has(sandbox.state)) return sandbox
      if (sandbox.state === 'error')
        throw new Error(`Boat says the sandbox failed: ${sandbox.error ?? 'no reason given'}`)
      if (sandbox.state === 'archived') throw new Error('The sandbox stopped while it was coming up')
      await this.#pause(1000)
    }
    throw new Error('The sandbox did not come up in time')
  }

  /** A sandbox that is up, woken and parked for work on a server that is asleep. */
  async awake(key: string, found: Sandbox, reason: StartReason): Promise<Sandbox> {
    return UP.has(found.state) ? found : this.up(key, found, reason, 'park')
  }

  /**
   * Whether a sandbox is up only for work on a sleeping server, so Boat stops it soon by itself:
   * up, and stopping within the park's own time.
   */
  parked(sandbox: Sandbox): boolean {
    return UP.has(sandbox.state) && stopsWithin(sandbox, this.#parkTtl + 60)
  }

  /** The sandbox once it has finished stopping, if it was; null when it is gone. */
  async settled(id: string): Promise<Sandbox | null> {
    const deadline = Date.now() + STOP_SECONDS * 1000
    for (;;) {
      const sandbox = await this.get(id)
      if (sandbox === null || sandbox.state !== 'archiving') return sandbox
      if (Date.now() > deadline) throw new Error('The sandbox did not finish stopping')
      await this.#pause(1000)
    }
  }

  /**
   * Boat's stop, which saves the disk first. Boat refuses one whose save keeps failing and leaves
   * the sandbox up, retrying on its own and billing nothing for it; that stop fails here too, and
   * is never forced, which would lose what was saved since the last snapshot.
   */
  async stop(id: string): Promise<void> {
    const asked = await this.#boat.POST('/sandboxes/{sandboxId}/stop', {
      params: { path: { sandboxId: id } },
      body: {},
    })
    if (asked.response.status === 404) return
    must(asked, 'stopping the sandbox')
    const deadline = Date.now() + STOP_SECONDS * 1000
    while (Date.now() < deadline) {
      const sandbox = await this.get(id)
      if (sandbox === null || sandbox.state === 'archived') return
      await this.#pause(1000)
    }
    throw new Error('Boat did not stop the sandbox; its snapshot may be failing, and Boat keeps trying')
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.#boat.DELETE('/sandboxes/{sandboxId}', {
      params: { path: { sandboxId: id }, header: { 'X-Ascii-Confirm-Delete': id } },
    })
    if (deleted.response.status === 404) return
    must(deleted, 'deleting the sandbox')
  }
}

/** `bly-<deployment>-<32 hex>`, with or without tags after it, back to the server id. */
export function serverOf(name: string, prefix: string): RuntimeKey | null {
  if (!name.startsWith(prefix)) return null
  const hex = name.slice(prefix.length).split(' ')[0] ?? ''
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as RuntimeKey
}

/** Whether Boat stops the sandbox by itself within `seconds`. */
function stopsWithin(sandbox: Sandbox, seconds: number): boolean {
  const at = Date.parse(sandbox.archiveAfter ?? '')
  return !Number.isNaN(at) && at - Date.now() <= seconds * 1000
}
