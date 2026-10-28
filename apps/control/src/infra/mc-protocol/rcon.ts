// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { LockBusy, type Locks } from '../../app/ports/locks.ts'
import { type ConsoleTarget, ConsoleUnavailable, type ServerConsole } from '../../app/ports/minecraft.ts'

/**
 * Minecraft's RCON over TCP. One connection per call: the control plane talks to a server a few
 * times a minute, and a fresh connection never inherits a half-read response.
 *
 * Hand-written on purpose. Five npm clients were run against a real 26.3 server on 2026-09-19
 * (docs/dependency-audit.md). Each one truncated answers at 4 KiB, broke on fragmented or coalesced
 * packets, hung when the server went quiet or away, or pipelined its end-of-answer marker, which
 * vanilla drops. None passed every case Blockly depends on; this client does.
 *
 * Vanilla also captures every RCON connection's answers in one shared buffer: commands arriving
 * on two connections at once swap or lose their answers. So each session holds its server's lock,
 * across every control-plane process.
 */

const AUTH = 3
const EXEC = 2
/** Long enough for another session's batch to finish. */
const LOCK_WAIT_MS = 15_000
/** Between tries at a console that refused or dropped the connection. */
const TRY_AGAIN_MS = 500
/** Vanilla reads each packet with one read of at most 1460 bytes; 14 of them are framing. */
const MAX_COMMAND_BYTES = 1446
/** A reply's length field counts its id, its type and the two trailing NULs: 10 bytes at least. */
const LEAST_REPLY_LENGTH = 10
/**
 * Vanilla splits an answer into bodies of at most 4096 UTF-16 units, each at most 3 bytes in
 * UTF-8, so no reply it sends has a length field above this.
 */
const MOST_REPLY_LENGTH = LEAST_REPLY_LENGTH + 4096 * 3
/** The most characters a connection holds of one command's answer: far past any command's output. */
const MOST_ANSWER_CHARACTERS = 1024 * 1024

export interface RconTimings {
  /** Connecting, and then the password's answer: a server that accepts and never answers is hung. */
  connectMs: number
  commandMs: number
  /** How long a console that refuses or drops the connection is tried again: one just coming up. */
  comingUpMs: number
}

const TIMINGS: RconTimings = { connectMs: 5_000, commandMs: 10_000, comingUpMs: 10_000 }

type Reply = { id: number; body: string }

/** The server answered, and said no to this password. */
class PasswordRefused extends ConsoleUnavailable {
  constructor() {
    super('The console refused the password')
  }
}
/**
 * The connection was refused, or closed or broken before an answer. Through Flycast every
 * connection is accepted, by Fly's proxy, and closed when the machine's port doesn't take it: a
 * console not listening yet, as just after a server comes up, reads as closed rather than refused.
 */
class Dropped extends ConsoleUnavailable {}

/** The server sent what RCON can't carry: a length out of bounds, or an answer too long to hold. */
class Unreadable extends ConsoleUnavailable {
  constructor(what: string) {
    super(`The console sent ${what}`)
  }
}

type Waiter = { resolve: (reply: Reply) => void; reject: (error: Error) => void }

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const buffer = Buffer.alloc(14 + payload.length)
  buffer.writeInt32LE(10 + payload.length, 0)
  buffer.writeInt32LE(id, 4)
  buffer.writeInt32LE(type, 8)
  payload.copy(buffer, 12)
  return buffer
}

class Connection {
  readonly #socket: Socket
  readonly #timings: RconTimings
  readonly #waiters: Waiter[] = []
  /** Replies that arrived before anyone asked for them. */
  readonly #replies: Reply[] = []
  /** What has arrived of the next reply, not yet joined: joining is put off until it is whole. */
  #pending: Buffer[] = []
  #pendingBytes = 0
  /** How many bytes the next reply needs, once its length is known. */
  #needed = 4
  #failure: Error | null = null
  #nextId = 1

  private constructor(socket: Socket, timings: RconTimings) {
    this.#socket = socket
    this.#timings = timings
    socket.on('data', (chunk) => this.#receive(chunk))
    socket.on('error', (error) => this.#fail(new Dropped('The console connection failed', { cause: error })))
    socket.on('close', () => this.#fail(new Dropped('The console connection closed')))
  }

  static async open(
    endpoint: ConsoleTarget['endpoint'],
    password: string,
    timings: RconTimings,
  ): Promise<Connection> {
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new ConsoleUnavailable('The console did not answer'))
      }, timings.connectMs)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Dropped('The console is not reachable', { cause: error }))
      })
      socket.connect(endpoint.port, endpoint.host, () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const connection = new Connection(socket, timings)
    // A frozen server still accepts connections; its silence is the only sign.
    const deadline = setTimeout(
      () => connection.#fail(new ConsoleUnavailable('The console did not answer')),
      timings.connectMs,
    )
    try {
      const id = connection.#send(AUTH, password)
      const reply = await connection.#next()
      // A rejected password answers with id -1.
      if (reply.id !== id) {
        connection.close()
        throw new PasswordRefused()
      }
    } finally {
      clearTimeout(deadline)
    }
    return connection
  }

  /**
   * Sends a command and collects its answer. Answers over 4 KiB arrive in fragments, so after the
   * first one a sentinel request follows: everything before its reply belongs to the command.
   * The sentinel must wait for that first reply — vanilla reads one packet per TCP read and drops
   * whatever else arrived with it.
   */
  async exec(command: string, commandMs = this.#timings.commandMs): Promise<string> {
    // Anything longer would make vanilla drop the connection.
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)
      throw new Error(`Commands longer than ${MAX_COMMAND_BYTES} bytes do not fit in one RCON packet`)
    const deadline = setTimeout(
      () => this.#fail(new ConsoleUnavailable('The console stopped answering')),
      commandMs,
    )
    try {
      const id = this.#send(EXEC, command)
      let first = await this.#next()
      while (first.id !== id) first = await this.#next()
      const parts = [first.body]
      let characters = first.body.length
      const sentinel = this.#send(0, '')
      for (;;) {
        const reply = await this.#next()
        if (reply.id === sentinel) return parts.join('')
        if (reply.id !== id) continue
        parts.push(reply.body)
        characters += reply.body.length
        if (characters > MOST_ANSWER_CHARACTERS) {
          const failure = new Unreadable(`an answer over ${MOST_ANSWER_CHARACTERS} characters`)
          this.#fail(failure)
          throw failure
        }
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  close(): void {
    this.#socket.destroy()
  }

  #send(type: number, body: string): number {
    const id = this.#nextId++
    this.#socket.write(packet(id, type, body))
    return id
  }

  #next(): Promise<Reply> {
    const ready = this.#replies.shift()
    if (ready) return Promise.resolve(ready)
    if (this.#failure) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  #receive(chunk: Buffer): void {
    this.#pending.push(chunk)
    this.#pendingBytes += chunk.length
    while (!this.#failure && this.#pendingBytes >= this.#needed) {
      const buffer = this.#pending.length === 1 ? (this.#pending[0] as Buffer) : Buffer.concat(this.#pending)
      this.#pending = [buffer]
      const length = buffer.readInt32LE(0)
      if (length < LEAST_REPLY_LENGTH || length > MOST_REPLY_LENGTH) {
        const bounds = `${LEAST_REPLY_LENGTH} to ${MOST_REPLY_LENGTH}`
        this.#fail(new Unreadable(`a reply of length ${length}, outside ${bounds}`))
        return
      }
      this.#needed = length + 4
      if (buffer.length < this.#needed) return
      const id = buffer.readInt32LE(4)
      // Body runs from byte 12 to the two trailing NULs.
      const body = buffer.toString('utf8', 12, length + 2)
      const rest = buffer.subarray(length + 4)
      this.#pending = rest.length > 0 ? [rest] : []
      this.#pendingBytes = rest.length
      this.#needed = 4
      const waiter = this.#waiters.shift()
      if (waiter) waiter.resolve({ id, body })
      else this.#replies.push({ id, body })
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
    this.#socket.destroy()
  }
}

export class RconConsole implements ServerConsole {
  readonly #locks: Locks
  readonly #timings: RconTimings

  constructor(locks: Locks, timings: RconTimings = TIMINGS) {
    this.#locks = locks
    this.#timings = timings
  }

  run(target: ConsoleTarget, command: string): Promise<string> {
    return this.#session(target, async (connection) => connection.exec(command))
  }

  async runAll(target: ConsoleTarget, commands: readonly string[], options: { commandMs?: number } = {}) {
    try {
      return await this.#session(target, async (connection) => {
        const results: Array<{ ok: true; output: string } | { ok: false; error: string }> = []
        for (const command of commands) {
          try {
            results.push({ ok: true, output: await connection.exec(command, options.commandMs) })
          } catch (error) {
            results.push({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        return results
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return commands.map(() => ({ ok: false as const, error: message }))
    }
  }

  /**
   * Signs in, trying again for a while when the connection is refused or dropped before the
   * password's answer: nothing has run yet, and a server that just came up may not have its console
   * listening. A console that accepts and stays silent is not tried again; it is hung.
   */
  async #open(target: ConsoleTarget): Promise<Connection> {
    const deadline = Date.now() + this.#timings.comingUpMs
    for (;;) {
      try {
        return await this.#signIn(target)
      } catch (error) {
        if (!(error instanceof Dropped) || Date.now() + TRY_AGAIN_MS > deadline) throw error
        await sleep(TRY_AGAIN_MS)
      }
    }
  }

  /**
   * Signs in with each password in turn: during a key rotation a server has the old one until it
   * is applied again. Anything but a refusal ends the attempt at once.
   */
  async #signIn(target: ConsoleTarget): Promise<Connection> {
    let refused: PasswordRefused | null = null
    for (const password of target.passwords) {
      try {
        return await Connection.open(target.endpoint, password, this.#timings)
      } catch (error) {
        if (!(error instanceof PasswordRefused)) throw error
        refused = error
      }
    }
    throw refused ?? new ConsoleUnavailable('No password to sign in with')
  }

  /** One connection, with the server to itself for as long as it is open. */
  async #session<T>(target: ConsoleTarget, work: (connection: Connection) => Promise<T>): Promise<T> {
    const key = `rcon:${target.endpoint.host}:${target.endpoint.port}`
    try {
      return await this.#locks.hold(key, LOCK_WAIT_MS, async () => {
        const connection = await this.#open(target)
        try {
          return await work(connection)
        } finally {
          connection.close()
        }
      })
    } catch (error) {
      if (error instanceof LockBusy) throw new ConsoleUnavailable('The console is busy with another command')
      throw error
    }
  }
}
