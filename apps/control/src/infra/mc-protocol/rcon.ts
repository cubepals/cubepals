import { Socket } from 'node:net'
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
/** Vanilla reads each packet with one read of at most 1460 bytes; 14 of them are framing. */
const MAX_COMMAND_BYTES = 1446

export interface RconTimings {
  /** Connecting, and then the password's answer: a server that accepts and never answers is hung. */
  connectMs: number
  commandMs: number
}

const TIMINGS: RconTimings = { connectMs: 5_000, commandMs: 10_000 }

type Reply = { id: number; body: string }

/** The server answered, and said no to this password. */
class PasswordRefused extends ConsoleUnavailable {
  constructor() {
    super('The console refused the password')
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
  #buffer = Buffer.alloc(0)
  #failure: Error | null = null
  #nextId = 1

  private constructor(socket: Socket, timings: RconTimings) {
    this.#socket = socket
    this.#timings = timings
    socket.on('data', (chunk) => this.#receive(chunk))
    socket.on('error', (error) =>
      this.#fail(new ConsoleUnavailable('The console connection failed', { cause: error })),
    )
    socket.on('close', () => this.#fail(new ConsoleUnavailable('The console connection closed')))
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
        reject(new ConsoleUnavailable('The console is not reachable', { cause: error }))
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
  async exec(command: string): Promise<string> {
    // Anything longer would make vanilla drop the connection.
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)
      throw new Error(`Commands longer than ${MAX_COMMAND_BYTES} bytes do not fit in one RCON packet`)
    const deadline = setTimeout(
      () => this.#fail(new ConsoleUnavailable('The console stopped answering')),
      this.#timings.commandMs,
    )
    try {
      const id = this.#send(EXEC, command)
      let first = await this.#next()
      while (first.id !== id) first = await this.#next()
      const parts = [first.body]
      const sentinel = this.#send(0, '')
      for (;;) {
        const reply = await this.#next()
        if (reply.id === sentinel) return parts.join('')
        if (reply.id === id) parts.push(reply.body)
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
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readInt32LE(0)
      if (this.#buffer.length < length + 4) return
      const id = this.#buffer.readInt32LE(4)
      // Body runs from byte 12 to the two trailing NULs.
      const body = this.#buffer.toString('utf8', 12, length + 2)
      this.#buffer = this.#buffer.subarray(length + 4)
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

  async runAll(target: ConsoleTarget, commands: readonly string[]) {
    try {
      return await this.#session(target, async (connection) => {
        const results: Array<{ ok: true; output: string } | { ok: false; error: string }> = []
        for (const command of commands) {
          try {
            results.push({ ok: true, output: await connection.exec(command) })
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
   * Signs in with each password in turn: during a key rotation a server has the old one until it
   * is applied again. Anything but a refusal ends the attempt at once.
   */
  async #open(target: ConsoleTarget): Promise<Connection> {
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
