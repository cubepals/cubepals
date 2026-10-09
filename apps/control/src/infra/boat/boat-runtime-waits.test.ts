import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { ProgressSink, RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { BoatRuntime } from './boat-runtime.ts'
import { boatClient } from './client.ts'
import { decodeHandle, encodeHandle, encodeSnapshot } from './handle.ts'
import { BoatStarts } from './starts.ts'

/**
 * What BoatRuntime asks of Boat, and how long it waits between, in the order it does: the calls
 * and pauses of its main flows, and the waits and retries the in-memory Boat of
 * boat-runtime.test.ts never makes it take, since its sandboxes come up and stop at once and its
 * commands never fail. Boat here is scripted: each test sets the states and answers it gives.
 */

interface Box {
  id: string
  name: string
  state: string
  type: string
  ip: string | null
  ttlSeconds: number | null
}

/** The words of a verb's command after the program: `blockly <verb> '<arg>'…`. */
function verbOf(command: string): string[] {
  const rest = command.slice(command.lastIndexOf("' blockly ") + "' blockly ".length)
  const out: string[] = []
  let word = ''
  let quoted = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string
    if (quoted) {
      if (c === "'" && rest.startsWith("'\\''", i)) {
        word += "'"
        i += 3
      } else if (c === "'") quoted = false
      else word += c
    } else if (c === "'") quoted = true
    else if (c === ' ') {
      out.push(word)
      word = ''
    } else word += c
  }
  out.push(word)
  return out
}

class ScriptedBoat {
  /** Every call and every pause, in order. */
  readonly seen: string[] = []
  readonly boxes = new Map<string, Box>()
  /** States the next reads of a sandbox see before its own. */
  readonly reads: string[] = []
  /** Answers for the next commands before the program's own: an HTTP status, or what it printed. */
  readonly replies: Array<number | string> = []
  /** Statuses for the next stops and resumes, before Boat's own answer. */
  readonly stops: number[] = []
  readonly resumes: number[] = []
  /** Whether a detached command still runs whenever it is read. */
  jobsHang = false
  /** Whether a stop leaves the sandbox up, as Boat does when its save keeps failing. */
  stopsHang = false
  inspect = 'running 0 false 0 2026-09-28T01:00:00Z 2026-09-28T00:59:00Z'
  archiveBytes = 4096
  #next = 0
  #address = 0
  #jobs: string[] = []
  #now = Date.parse('2026-10-01T00:00:00Z')

  constructor() {
    setSystemTime(new Date(this.#now))
  }

  pause = async (ms: number) => {
    this.seen.push(`pause ${ms}`)
    this.#now += ms
    setSystemTime(new Date(this.#now))
  }

  box(state: string, name = 'bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b'): Box {
    this.#next++
    const made = { id: `bx_${this.#next}`, name, state, type: 'small', ip: this.#ip(), ttlSeconds: null }
    this.boxes.set(made.id, made)
    return made
  }

  #ip() {
    this.#address++
    return `2001:db8::${this.#address}`
  }

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const body = (
      request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json().catch(() => ({}))
    ) as Record<string, unknown>
    const json = (status: number, value: unknown) => Response.json(value, { status })
    const error = (status: number) => json(status, { ok: false, code: `e${status}`, message: `e${status}` })
    const one = /^\/sandboxes\/(bx_\d+)(\/.*)?$/.exec(path)
    const box = one ? this.boxes.get(one[1] as string) : undefined
    const rest = one?.[2] ?? ''
    if (request.method === 'POST' && rest === '/commands') {
      const words = verbOf(String(body.command))
      this.seen.push(`${request.method} ${path} ${body.detached ? 'detached ' : ''}${words.join(' ')}`)
    } else if (request.method === 'POST' && path === '/sandboxes')
      this.seen.push(`POST ${path} ${request.headers.get('idempotency-key')} ${JSON.stringify(body)}`)
    else if (request.method === 'PUT') this.seen.push(`PUT ${path}`)
    else
      this.seen.push(
        `${request.method} ${path}${Object.keys(body).length === 0 ? '' : ` ${JSON.stringify(body)}`}`,
      )
    if (path === '/limits')
      return json(200, {
        canStart: true,
        starts: {
          minute: { limit: 5, used: 0, remaining: 5 },
          hour: { limit: 25, used: 0, remaining: 25 },
          day: { limit: 75, used: 0, remaining: 75 },
        },
      })
    if (request.method === 'POST' && path === '/sandboxes') {
      const made = this.box('ready', 'Box')
      made.type = String(body.type)
      made.ttlSeconds = body.ttlSeconds as number | null
      return json(202, { sandbox: made })
    }
    if (request.method === 'GET' && path === '/sandboxes')
      return json(200, { sandboxes: [...this.boxes.values()], pageInfo: { hasMore: false } })
    if (box === undefined) return error(404)
    if (request.method === 'GET' && rest === '') {
      const read = this.reads.shift()
      return json(200, { sandbox: { ...box, state: read ?? box.state } })
    }
    if (request.method === 'PATCH' && rest === '') {
      if (body.name !== undefined) box.name = String(body.name)
      if (body.ttlSeconds !== undefined) box.ttlSeconds = body.ttlSeconds as number | null
      return json(200, { sandbox: box })
    }
    if (request.method === 'DELETE') {
      this.boxes.delete(box.id)
      return json(202, {})
    }
    if (request.method === 'POST' && rest === '/stop') {
      const status = this.stops.shift()
      if (status !== undefined) return error(status)
      if (!this.stopsHang) {
        box.state = 'archived'
        box.ip = null
      }
      return json(202, { status: 'archiving' })
    }
    if (request.method === 'POST' && rest === '/resume') {
      const status = this.resumes.shift()
      if (status !== undefined) return error(status)
      box.state = 'ready'
      box.ip = this.#ip()
      if (body.type !== undefined) box.type = String(body.type)
      return json(202, { status: 'resuming' })
    }
    if (request.method === 'PUT') return json(200, {})
    if (request.method === 'POST' && rest === '/commands') {
      const reply = this.replies.shift()
      if (typeof reply === 'number') return error(reply)
      const stdout = reply ?? this.#program(verbOf(String(body.command)))
      if (body.detached) {
        this.#jobs.push(stdout)
        return json(200, { processId: this.#jobs.length })
      }
      return json(200, { exitCode: 0, stdout, stderr: '' })
    }
    const job = /^\/commands\/(\d+)$/.exec(rest)
    if (request.method === 'GET' && job)
      return json(200, {
        running: this.jobsHang,
        exitCode: 0,
        stdout: this.#jobs[Number(job[1]) - 1] ?? '',
        stderr: '',
      })
    return error(400)
  }

  #program([verb, ...args]: string[]): string {
    switch (verb) {
      case 'inspect':
        return `ok ${this.inspect}`
      case 'snapshot':
        return 'ok 4096'
      case 'snapshots':
        return 'ok one.tar.gz'
      case 'export':
        return this.archiveBytes > Number(args[2])
          ? `ok parts ${'a'.repeat(64)} ${this.archiveBytes}`
          : `ok ${'a'.repeat(64)} ${this.archiveBytes}`
      case 'export-parts':
        return `ok ${(args[3] ?? '')
          .split('\n')
          .map((_, index) => `${index + 1}="e${index + 1}"`)
          .join(' ')}`
      default:
        return 'ok done'
    }
  }
}

const KEY = '0f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b' as RuntimeKey
const MIB = 1024 ** 2

const spec: RuntimeSpec = {
  image: 'itzg/minecraft-server:2026.9.1-java21',
  env: { EULA: 'TRUE' },
  secrets: { RCON_PASSWORD: 'secret' },
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 3 },
  ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge', 'control'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
}

const sink: ProgressSink = { step: async () => {}, handle: async () => {} }

function setup() {
  const boat = new ScriptedBoat()
  const client = boatClient('boat_p_test', { baseUrl: 'https://boat.test/api/v1', fetch: boat.fetch })
  const starts = new BoatStarts(client, { pause: async () => {}, log: () => {}, cacheMs: 0 })
  const runtime = new BoatRuntime({
    client,
    deploymentId: 'test',
    starts,
    runTtlSeconds: null,
    parkTtlSeconds: 300,
    pause: boat.pause,
    log: (line) => boat.seen.push(`log ${line.replace(/\d+ms/g, 'Nms')}`),
  })
  return { boat, runtime }
}

const handleOf = (box: Box, address = box.ip): RuntimeHandle =>
  encodeHandle({
    deployment: 'test',
    serverId: KEY,
    sandboxId: box.id,
    address,
    ports: { game: 25565 },
    open: [25565],
    previous: null,
  })

/** The calls from `from` on, without the program's own text. */
const since = (boat: ScriptedBoat, from: number) => boat.seen.slice(from)

afterEach(() => {
  setSystemTime()
})

describe('BoatRuntime flows, call by call', () => {
  test('a first provision, then a start of the running server', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink)
    const provisioned = since(boat, 0)
    const at = boat.seen.length
    await runtime.start(handle)
    expect(provisioned).toEqual([
      'GET /sandboxes',
      'GET /limits',
      `POST /sandboxes blockly:test:${KEY}:first {"type":"small","ttlSeconds":null,"noEnv":true,"env":{"BLOCKLY_DEPLOYMENT":"test","BLOCKLY_SERVER":"${KEY}"}}`,
      'PATCH /sandboxes/bx_1 {"name":"bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b"}',
      'PATCH /sandboxes/bx_1 {"ttlSeconds":null}',
      'PUT /sandboxes/bx_1/files',
      'POST /sandboxes/bx_1/commands detached configure fdde075d8b0b334dda717a859006ac16 itzg/minecraft-server:2026.9.1-java21',
      'pause 3000',
      'GET /sandboxes/bx_1/commands/1',
      'POST /sandboxes/bx_1/commands up 25565',
    ])
    expect(since(boat, at)).toEqual([
      'GET /sandboxes/bx_1',
      'PATCH /sandboxes/bx_1 {"ttlSeconds":null}',
      'POST /sandboxes/bx_1/commands up 25565',
    ])
  })

  test('a stop, then a wake', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    const handle = handleOf(box)
    await runtime.stop(handle)
    const at = boat.seen.length
    const woken = await runtime.start(handle)
    expect(boat.seen.slice(0, at)).toEqual([
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands stop',
      'POST /sandboxes/bx_1/stop',
      'GET /sandboxes/bx_1',
      `log boat stop: server=${KEY} sandbox=bx_1 workload=Nms sandbox=Nms`,
    ])
    expect(since(boat, at)).toEqual([
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":null}',
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands up 25565',
      `log boat address: server=${KEY} sandbox=bx_1 2001:db8::1 → 2001:db8::2`,
    ])
    expect(decodeHandle(woken).address).toBe(box.ip)
  })

  test('an export in parts to the archive store, from a sleeping server', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('archived')
    boat.archiveBytes = 100 * MIB
    const target = recordingTarget({ url: 'https://store.test/put?sig=1', maxPutBytes: 64 * MIB })
    const snapshot = encodeSnapshot({ sandboxId: box.id, file: 'one.tar.gz' })
    expect(await runtime.exportSnapshot(snapshot, target)).toEqual({
      sha256: 'a'.repeat(64),
      sizeBytes: 100 * MIB,
    })
    const parts = Array.from({ length: 13 }, (_, index) => `https://store.test/put?sig=1&part=${index + 1}`)
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":300}',
      'GET /sandboxes/bx_1',
      `POST /sandboxes/bx_1/commands detached export one.tar.gz https://store.test/put?sig=1 ${64 * MIB}`,
      'pause 3000',
      'GET /sandboxes/bx_1/commands/1',
      `POST /sandboxes/bx_1/commands detached export-parts one.tar.gz 8 ${100 * MIB} ${parts.join('\n')}`,
      'pause 3000',
      'GET /sandboxes/bx_1/commands/2',
    ])
    expect(target.log.completed[0]).toHaveLength(13)
    expect(target.log.aborted).toBe(0)
  })
})

describe('BoatRuntime waits and retries', () => {
  const pauses = (boat: ScriptedBoat, from = 0) => since(boat, from).filter((s) => s.startsWith('pause'))
  const reads = (boat: ScriptedBoat, id: string, from = 0) =>
    since(boat, from).filter((s) => s === `GET /sandboxes/${id}`).length

  test('a dropped command is asked again twice, three seconds apart, then fails', async () => {
    const { boat, runtime } = setup()
    const handle = handleOf(boat.box('ready'))
    boat.replies.push(502, 504)
    await runtime.restart(handle)
    expect(pauses(boat)).toEqual(['pause 3000', 'pause 3000'])
    boat.replies.push(502, 503, 502)
    const at = boat.seen.length
    await expect(runtime.restart(handle)).rejects.toThrow(
      'Boat: running a command failed with 502 e502: e502',
    )
    expect(pauses(boat, at)).toEqual(['pause 3000', 'pause 3000'])
  })

  test('a command whose program reached no verdict is asked again, then fails with what it printed', async () => {
    const { boat, runtime } = setup()
    const handle = handleOf(boat.box('ready'))
    boat.replies.push('half', 'half', 'half')
    await expect(runtime.restart(handle)).rejects.toThrow("The sandbox couldn't restart: exit 0 (half)")
    expect(pauses(boat)).toEqual(['pause 3000', 'pause 3000'])
    boat.replies.push('failed the workload would not start')
    const at = boat.seen.length
    await expect(runtime.restart(handle)).rejects.toThrow(
      "The sandbox couldn't restart: the workload would not start",
    )
    expect(since(boat, at)).toEqual(['POST /sandboxes/bx_1/commands restart 25565'])
  })

  test('a command Boat refuses while the sandbox comes up is asked again every two seconds, 30 times', async () => {
    const { boat, runtime } = setup()
    const handle = handleOf(boat.box('ready'))
    boat.replies.push(409, 409)
    await runtime.restart(handle)
    expect(pauses(boat)).toEqual(['pause 2000', 'pause 2000'])
    boat.replies.push(...Array.from({ length: 31 }, () => 409))
    const at = boat.seen.length
    await expect(runtime.restart(handle)).rejects.toThrow(
      'Boat: running a command failed with 409 e409: e409',
    )
    expect(pauses(boat, at)).toEqual(Array.from({ length: 30 }, () => 'pause 2000'))
  })

  test('a long command runs detached and is read every three seconds until its six hours are up', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    boat.jobsHang = true
    await expect(runtime.apply(handleOf(box), spec)).rejects.toThrow(
      'A command in the sandbox ran past 360 minutes',
    )
    expect(boat.seen.filter((s) => s.startsWith('GET /sandboxes/bx_1/commands/'))).toHaveLength(7200)
    expect(new Set(pauses(boat))).toEqual(new Set(['pause 3000']))
  })

  test('a sandbox still stopping is waited for, then resumed', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('archived')
    boat.reads.push('archiving', 'archiving', 'archiving')
    await runtime.start(handleOf(box))
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'GET /sandboxes/bx_1',
      'pause 1000',
      'GET /sandboxes/bx_1',
      'pause 1000',
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":null}',
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands up 25565',
      `log boat address: server=${KEY} sandbox=bx_1 2001:db8::1 → 2001:db8::2`,
    ])
  })

  test('a sandbox coming up is waited for; one that fails or stops instead is refused', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    boat.reads.push('provisioning', 'provisioning', 'provisioning')
    await runtime.start(handleOf(box))
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'GET /sandboxes/bx_1',
      'pause 1000',
      'GET /sandboxes/bx_1',
      'pause 1000',
      'GET /sandboxes/bx_1',
      'PATCH /sandboxes/bx_1 {"ttlSeconds":null}',
      'POST /sandboxes/bx_1/commands up 25565',
    ])
    boat.reads.push('error')
    await expect(runtime.start(handleOf(box))).rejects.toThrow(
      'Boat says the sandbox failed: no reason given',
    )
    boat.reads.push('provisioning', 'cloning', 'error')
    await expect(runtime.start(handleOf(box))).rejects.toThrow(
      'Boat says the sandbox failed: no reason given',
    )
    boat.reads.push('provisioning', 'archived')
    await expect(runtime.start(handleOf(box))).rejects.toThrow('The sandbox stopped while it was coming up')
  })

  test('a sandbox that never comes up is given ten minutes, read every second', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    boat.reads.push(...Array.from({ length: 700 }, () => 'provisioning'))
    await expect(runtime.start(handleOf(box))).rejects.toThrow('The sandbox did not come up in time')
    // One read by `start`, then 600 by the wait: READY_SECONDS at a second each.
    expect(reads(boat, box.id)).toBe(601)
    expect(new Set(pauses(boat))).toEqual(new Set(['pause 1000']))
  })

  test('a sandbox that never finishes stopping is given ten minutes, read every second', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('archived')
    boat.reads.push(...Array.from({ length: 700 }, () => 'archiving'))
    await expect(runtime.stop(handleOf(box))).rejects.toThrow('The sandbox did not finish stopping')
    // STOP_SECONDS at a second each, read once more at the deadline and once past it.
    expect(reads(boat, box.id)).toBe(602)
    expect(new Set(pauses(boat))).toEqual(new Set(['pause 1000']))
  })

  test('a resume another process began is waited for, not made again', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    boat.resumes.push(409)
    // Read stopped, then coming up under the other process's resume.
    boat.reads.push('archived', 'provisioning')
    await runtime.start(handleOf(box))
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":null}',
      'GET /sandboxes/bx_1',
      'pause 1000',
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands up 25565',
    ])
    expect(boat.resumes).toEqual([])
  })

  test('a stop of a sandbox already gone is done; one Boat never finishes fails without forcing', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    boat.stops.push(404)
    await runtime.stop(handleOf(box))
    expect(boat.seen.filter((s) => s.endsWith('/stop'))).toHaveLength(1)
    boat.stopsHang = true
    const at = boat.seen.length
    await expect(runtime.stop(handleOf(box))).rejects.toThrow(
      'Boat did not stop the sandbox; its snapshot may be failing, and Boat keeps trying',
    )
    const after = since(boat, at)
    expect(after.filter((s) => s.endsWith('/stop'))).toHaveLength(1)
    // One read before the stop, then STOP_SECONDS at a second each.
    expect(reads(boat, box.id, at)).toBe(601)
  })
})

describe('BoatRuntime changes of size, storage on a sleeping server, and moves', () => {
  test('apply onto another size stops the workload, then the sandbox, and resumes it as that size', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    const bigger = { ...spec, resources: { memoryMb: 6144 }, storage: { mountPath: '/data', sizeGb: 10 } }
    await runtime.apply(handleOf(box), bigger)
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands inspect',
      'POST /sandboxes/bx_1/commands stop',
      'POST /sandboxes/bx_1/stop',
      'GET /sandboxes/bx_1',
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":null,"type":"default"}',
      'GET /sandboxes/bx_1',
      'PUT /sandboxes/bx_1/files',
      'POST /sandboxes/bx_1/commands detached configure 69bfb20f18f833825e8b053dc1498f7b itzg/minecraft-server:2026.9.1-java21',
      'pause 3000',
      'GET /sandboxes/bx_1/commands/1',
      'POST /sandboxes/bx_1/commands up 25565',
    ])
    expect(box.type).toBe('default')
  })

  test('deleting a snapshot of a sleeping server wakes and parks it; one in another deployment is refused', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('archived')
    await runtime.deleteSnapshot(encodeSnapshot({ sandboxId: box.id, file: 'one.tar.gz' }))
    expect(boat.seen).toEqual([
      'GET /sandboxes/bx_1',
      'GET /limits',
      'POST /sandboxes/bx_1/resume {"ttlSeconds":300}',
      'GET /sandboxes/bx_1',
      'POST /sandboxes/bx_1/commands forget one.tar.gz',
    ])
    const theirs = boat.box('ready', 'bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    await expect(
      runtime.deleteSnapshot(encodeSnapshot({ sandboxId: theirs.id, file: 'one.tar.gz' })),
    ).rejects.toThrow('bx_2 does not belong to deployment test')
    const at = boat.seen.length
    await runtime.deleteSnapshot(encodeSnapshot({ sandboxId: 'bx_99', file: 'one.tar.gz' }))
    expect(since(boat, at)).toEqual(['GET /sandboxes/bx_99'])
  })

  test('an export from another deployment’s sandbox, or one that is gone, is refused before anything runs', async () => {
    const { boat, runtime } = setup()
    const theirs = boat.box('ready', 'bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    const target = recordingTarget()
    await expect(
      runtime.exportSnapshot(encodeSnapshot({ sandboxId: theirs.id, file: 'one.tar.gz' }), target),
    ).rejects.toThrow('bx_1 does not belong to deployment test')
    await expect(
      runtime.exportSnapshot(encodeSnapshot({ sandboxId: 'bx_99', file: 'one.tar.gz' }), target),
    ).rejects.toThrow('The snapshot went with its sandbox')
    expect(boat.seen.filter((s) => s.includes('/commands'))).toEqual([])
  })

  test('a server found at another address is logged and handed back there; at the same one, as it was', async () => {
    const { boat, runtime } = setup()
    const box = boat.box('ready')
    const kept = handleOf(box)
    expect(await runtime.start(kept)).toBe(kept)
    const moved = await runtime.start(handleOf(box, '2001:db8::99'))
    expect(decodeHandle(moved).address).toBe(box.ip)
    expect(boat.seen.filter((s) => s.startsWith('log'))).toEqual([
      `log boat address: server=${KEY} sandbox=bx_1 2001:db8::99 → 2001:db8::1`,
    ])
  })
})
