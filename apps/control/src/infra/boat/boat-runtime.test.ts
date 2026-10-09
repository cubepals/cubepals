import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ProgressSink,
  RuntimeFull,
  type RuntimeHandle,
  type RuntimeKey,
  type RuntimeSpec,
  RuntimeUnsupported,
} from '../../app/ports/runtime.ts'
import { RoutedAdapters, RuntimeRouter } from '../../app/runtimes/router.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { FakeRuntime } from '../fake/fake-runtime.ts'
import { BoatConsole, BoatLogSource, BoatProbe, linesOf } from './boat-minecraft.ts'
import { BoatRuntime, serverOf, stateOf, typeFor, workloadObservation } from './boat-runtime.ts'
import { boatClient } from './client.ts'
import { decodeHandle, encodeHandle } from './handle.ts'
import { BoatStarts } from './starts.ts'

// ─── An in-memory Boat ────────────────────────────────────────────────────────────────────────

interface FakeSandbox {
  id: string
  name: string
  state: string
  type: string
  ip: string | null
  ttlSeconds: number | null
  env: Record<string, string>
  updatedAt: string
  files: Map<string, string>
  /** The workload, as Docker in the sandbox holds it. */
  workload: {
    state: 'missing' | 'created' | 'running' | 'exited'
    digest: string | null
    exitCode: number
    restarts: number
  }
  firewall: Set<string>
  snapshots: Set<string>
  config: string | null
}

/** Splits a shell command into words, as bash would for single quotes. */
function words(command: string): string[] {
  const out: string[] = []
  let word = ''
  let quoted = false
  let any = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quoted) {
      if (c === "'") quoted = false
      else word += c
    } else if (c === "'") {
      quoted = true
      any = true
    } else if (c === '\\') {
      i++
      word += command[i] ?? ''
    } else if (c === ' ') {
      if (any || word) out.push(word)
      word = ''
      any = false
    } else word += c
  }
  if (any || word) out.push(word)
  return out
}

const MIB = 1024 ** 2

class FakeBoat {
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly calls: string[] = []
  readonly idempotency = new Map<string, string>()
  limits = { minute: { limit: 5, used: 0 }, hour: { limit: 25, used: 0 }, day: { limit: 75, used: 0 } }
  canStart = true
  /** Refusals for the next starts, in order: a Boat error code with 429. */
  refuseStarts: string[] = []
  /** The workload ignores a stop, as a hung Minecraft would. */
  workloadHangs = false
  /** Boat restores the container this many reads of it after a resume. */
  restoreAfter = 0
  /** The archive an export packs; the arguments of each export verb; and whether parts fail. */
  archiveBytes = 4096
  readonly exports: string[][] = []
  partsFail = false
  #pendingRestore = new Map<string, number>()
  #next = 0
  #address = 0
  #processes = new Map<number, { stdout: string; exitCode: number }>()

  starts(): number {
    return this.calls.filter((c) => /^POST \/api\/v1\/sandboxes(\/bx_[a-z0-9]+\/resume)?$/.test(c)).length
  }

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const body =
      request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json().catch(() => ({}))
    this.calls.push(`${request.method} ${url.pathname}`)
    const json = (status: number, value: unknown) => Response.json(value, { status })
    const error = (status: number, code: string) => json(status, { ok: false, code, message: code, status })
    const one = /^\/sandboxes\/(bx_[a-z0-9]+)(\/.*)?$/.exec(path)
    const sandbox = one ? this.sandboxes.get(one[1] as string) : undefined
    const rest = one?.[2] ?? ''
    if (request.method === 'GET' && path === '/limits') {
      const window = (w: { limit: number; used: number }) => ({ ...w, remaining: w.limit - w.used })
      return json(200, {
        ok: true,
        canStart: this.canStart,
        starts: {
          minute: window(this.limits.minute),
          hour: window(this.limits.hour),
          day: window(this.limits.day),
        },
      })
    }
    if (request.method === 'POST' && path === '/sandboxes') {
      const key = request.headers.get('idempotency-key')
      const made = key ? this.idempotency.get(key) : undefined
      if (made) return json(202, { ok: true, sandbox: this.#view(this.sandboxes.get(made) as FakeSandbox) })
      const refused = this.#refused()
      if (refused) return refused
      const created = this.#create(
        body as { type?: string; ttlSeconds?: number | null; env?: Record<string, string> },
      )
      if (key) this.idempotency.set(key, created.id)
      return json(202, { ok: true, sandbox: this.#view(created) })
    }
    if (request.method === 'GET' && path === '/sandboxes') {
      const all = [...this.sandboxes.values()].map((s) => this.#view(s))
      const at = Number(url.searchParams.get('cursor') ?? 0)
      const page = all.slice(at, at + 2)
      const more = at + 2 < all.length
      return json(200, {
        ok: true,
        sandboxes: page,
        pageInfo: { hasMore: more, nextCursor: more ? String(at + 2) : null },
      })
    }
    if (sandbox === undefined) return error(404, 'not_found')
    if (request.method === 'GET' && rest === '') return json(200, { ok: true, sandbox: this.#view(sandbox) })
    if (request.method === 'PATCH' && rest === '') {
      const change = body as { name?: string; ttlSeconds?: number | null }
      if (change.name !== undefined) sandbox.name = change.name
      if (change.ttlSeconds !== undefined) sandbox.ttlSeconds = change.ttlSeconds
      return json(200, { ok: true, sandbox: this.#view(sandbox) })
    }
    if (request.method === 'DELETE' && rest === '') {
      if (request.headers.get('x-ascii-confirm-delete') !== sandbox.id) return error(409, 'confirm')
      this.sandboxes.delete(sandbox.id)
      return json(202, { ok: true })
    }
    if (request.method === 'POST' && rest === '/stop') {
      sandbox.state = 'archived'
      sandbox.ip = null
      // What was running comes back running on the next resume; what was stopped, stopped.
      if (sandbox.workload.state !== 'missing') this.#pendingRestore.set(sandbox.id, this.restoreAfter)
      this.#touch(sandbox)
      return json(202, { ok: true, status: 'archiving' })
    }
    if (request.method === 'POST' && rest === '/resume') {
      if (sandbox.state !== 'archived') return error(409, 'not_archived')
      const refused = this.#refused()
      if (refused) return refused
      this.#count()
      const resume = body as { ttlSeconds?: number | null; type?: string }
      sandbox.state = 'ready'
      sandbox.ip = this.#nextAddress()
      if (resume.ttlSeconds !== undefined) sandbox.ttlSeconds = resume.ttlSeconds
      if (resume.type !== undefined) sandbox.type = resume.type
      // Boat rewrites its firewall on a resume: what Blockly opened is gone (probed 2026-09-28).
      sandbox.firewall.clear()
      this.#touch(sandbox)
      return json(202, { ok: true, status: 'resuming' })
    }
    if (request.method === 'PUT' && rest === '/files') {
      const file = body as { path: string; content: string }
      sandbox.files.set(file.path, file.content)
      return json(200, { ok: true })
    }
    if (request.method === 'POST' && rest === '/commands') {
      if (sandbox.state !== 'ready') return error(409, 'machine_not_running')
      const command = body as { command: string; detached?: boolean }
      const result = this.#command(sandbox, command.command)
      if (command.detached) {
        const id = this.#processes.size + 1
        this.#processes.set(id, result)
        return json(200, { ok: true, processId: id, pid: id })
      }
      return json(200, {
        ok: true,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: '',
      })
    }
    const process = /^\/commands\/(\d+)$/.exec(rest)
    if (request.method === 'GET' && process) {
      const result = this.#processes.get(Number(process[1]))
      return json(200, {
        ok: true,
        running: false,
        status: 'exited',
        exitCode: result?.exitCode ?? -1,
        stdout: result?.stdout ?? '',
        stderr: '',
      })
    }
    return error(400, `unhandled ${request.method} ${path}`)
  }

  /** A sandbox made outside this runtime, as the owner's own or another deployment's. */
  foreign(name: string): FakeSandbox {
    const made = this.#create({})
    made.name = name
    return made
  }

  #refused(): Response | null {
    const code = this.refuseStarts.shift()
    if (code === undefined) return null
    return Response.json({ ok: false, code, message: `refused: ${code}`, status: 429 }, { status: 429 })
  }

  #count() {
    for (const window of Object.values(this.limits)) window.used++
  }

  #nextAddress() {
    this.#address++
    return `2001:db8::${this.#address.toString(16)}`
  }

  #create(request: { type?: string; ttlSeconds?: number | null; env?: Record<string, string> }): FakeSandbox {
    this.#count()
    this.#next++
    const sandbox: FakeSandbox = {
      id: `bx_${this.#next.toString().padStart(8, 'a')}`,
      name: `Box ${this.#next}`,
      state: 'ready',
      type: request.type ?? 'default',
      ip: this.#nextAddress(),
      ttlSeconds: request.ttlSeconds === undefined ? 3600 : request.ttlSeconds,
      env: request.env ?? {},
      updatedAt: new Date().toISOString(),
      files: new Map(),
      workload: { state: 'missing', digest: null, exitCode: 0, restarts: 0 },
      firewall: new Set(),
      snapshots: new Set(),
      config: null,
    }
    this.sandboxes.set(sandbox.id, sandbox)
    return sandbox
  }

  #touch(sandbox: FakeSandbox) {
    sandbox.updatedAt = new Date().toISOString()
  }

  #view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      type: sandbox.type,
      ip: sandbox.ip,
      updatedAt: sandbox.updatedAt,
      archiveAfter:
        sandbox.ttlSeconds === null ? null : new Date(Date.now() + sandbox.ttlSeconds * 1000).toISOString(),
      desktopAvailable: false,
      snapshotAvailable: true,
    }
  }

  /** The sandbox's program, and Docker in it, as far as the runtime asks of them. */
  #command(sandbox: FakeSandbox, command: string): { stdout: string; exitCode: number } {
    const said = words(command)
    const w = sandbox.workload
    // Boat brings the container back some reads into a resume.
    const pending = this.#pendingRestore.get(sandbox.id)
    if (pending !== undefined) {
      if (pending > 0) this.#pendingRestore.set(sandbox.id, pending - 1)
      else this.#pendingRestore.delete(sandbox.id)
    }
    const restoring = this.#pendingRestore.has(sandbox.id)
    const ok = (text = '') => ({ stdout: `ok ${text}`.trim(), exitCode: 0 })
    const failed = (text: string) => ({ stdout: `failed ${text}`, exitCode: 1 })
    if (said[0] === 'docker' && said[1] === 'exec') {
      const inside = said.slice(3)
      if (w.state !== 'running') return { stdout: 'container is not running', exitCode: 1 }
      if (inside[0] === 'mc-monitor')
        return { stdout: "localhost:25565 : version=1.21.8 online=2 max=20 motd='hi'", exitCode: 0 }
      if (inside[0] === 'sh' && inside[2]?.includes('rcon-cli'))
        return {
          stdout: inside
            .slice(4)
            .map((c) => `said ${c}\n\n@@blockly-end 0`)
            .join('\n'),
          exitCode: 0,
        }
      return { stdout: inside.join(' '), exitCode: 0 }
    }
    if (said[0] === 'docker' && said[1] === 'logs')
      return {
        stdout: '2026-09-28T01:40:00.1Z [Server thread/INFO]: Done (1.0s)!\n2026-09-28T01:40:00.12Z second\n',
        exitCode: 0,
      }
    if (said[0] !== 'bash' || said[3] !== 'blockly') return failed(`unknown command ${command.slice(0, 40)}`)
    const [verb, ...args] = said.slice(4)
    const state = restoring ? 'missing' : w.state
    switch (verb) {
      case 'configure': {
        const next = sandbox.files.get('/home/user/.blockly/workload.next.json')
        if (next === undefined) return failed('keeping the configuration')
        sandbox.config = next
        if (w.digest === args[0]) return ok('unchanged')
        const was = state === 'running'
        this.#pendingRestore.delete(sandbox.id)
        sandbox.workload = { ...w, state: was ? 'running' : 'created', digest: args[0] ?? null }
        return ok('created')
      }
      case 'up':
        this.#pendingRestore.delete(sandbox.id)
        for (const port of args) sandbox.firewall.add(port)
        w.state = 'running'
        return ok('running')
      case 'stop':
        this.#pendingRestore.delete(sandbox.id)
        if (w.state !== 'running') return ok('stopped')
        if (this.workloadHangs) return failed('the workload did not stop')
        w.state = 'exited'
        w.exitCode = 0
        return ok('stopped')
      case 'kill':
        w.state = 'exited'
        w.exitCode = 137
        return ok('killed')
      case 'restart':
        w.state = 'running'
        for (const port of args) sandbox.firewall.add(port)
        return ok('running')
      case 'inspect':
        if (state === 'missing') return ok('missing')
        return ok(`${w.state} ${w.exitCode} false ${w.restarts} 2026-09-28T01:00:00Z 2026-09-28T00:59:00Z`)
      case 'snapshot':
        sandbox.snapshots.add(args[0] as string)
        return ok('4096')
      case 'snapshots':
        return ok([...sandbox.snapshots].join(' '))
      case 'forget':
        sandbox.snapshots.delete(args[0] as string)
        return ok('forgotten')
      case 'restore-snapshot':
        if (!sandbox.snapshots.has(args[0] as string)) return failed('the snapshot is gone')
        return w.state === 'running' ? failed('the workload is running') : ok('restored')
      case 'restore-archive':
        return w.state === 'running' ? failed('the workload is running') : ok('restored')
      case 'export':
        if (!sandbox.snapshots.has(args[0] as string)) return failed('the snapshot is gone')
        this.exports.push(args)
        return this.archiveBytes > Number(args[2])
          ? ok(`parts ${'a'.repeat(64)} ${this.archiveBytes}`)
          : ok(`${'a'.repeat(64)} ${this.archiveBytes}`)
      case 'export-parts': {
        if (!sandbox.snapshots.has(args[0] as string)) return failed('the snapshot is gone')
        this.exports.push(args)
        if (this.partsFail) return failed('uploading part 1')
        const urls = (args[3] ?? '').split('\n')
        return ok(urls.map((_, index) => `${index + 1}="etag-${index + 1}"`).join(' '))
      }
      default:
        return failed(`no verb ${verb}`)
    }
  }
}

// ─── The runtime against it ───────────────────────────────────────────────────────────────────

const KEY = '0f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b' as RuntimeKey
const OTHER = '1f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b' as RuntimeKey

const spec: RuntimeSpec = {
  image: 'itzg/minecraft-server:2026.9.1-java21',
  env: { EULA: 'TRUE' },
  secrets: { RCON_PASSWORD: 'secret-rcon-password' },
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 3 },
  ports: [
    { name: 'game', port: 25565, protocol: 'tcp', audience: ['edge', 'control'] },
    { name: 'rcon', port: 25575, protocol: 'tcp', audience: ['control'] },
  ],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
}

const sink = (saved: RuntimeHandle[] = []): ProgressSink => ({
  step: async () => {},
  handle: async (handle) => {
    saved.push(handle)
  },
})

function setup(options: { runTtlSeconds?: number | null } = {}) {
  const boat = new FakeBoat()
  const lines: string[] = []
  const client = boatClient('boat_p_test', { baseUrl: 'https://boat.test/api/v1', fetch: boat.fetch })
  const pause = async () => {}
  const starts = new BoatStarts(client, { pause, log: (line) => lines.push(line), cacheMs: 0 })
  const runtime = new BoatRuntime({
    client,
    deploymentId: 'test',
    starts,
    runTtlSeconds: options.runTtlSeconds === undefined ? null : options.runTtlSeconds,
    parkTtlSeconds: 300,
    pause,
    log: (line) => lines.push(line),
  })
  return { boat, runtime, lines, starts }
}

const only = (boat: FakeBoat) => {
  const [sandbox] = boat.sandboxes.values()
  if (sandbox === undefined) throw new Error('no sandbox')
  return sandbox
}

describe('BoatRuntime provisioning', () => {
  test('makes one sandbox holding no account secrets, named for the server, and starts its workload', async () => {
    const { boat, runtime } = setup()
    const saved: RuntimeHandle[] = []
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink(saved))
    const sandbox = only(boat)
    expect(sandbox.name).toBe('bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    expect(sandbox.type).toBe('small')
    expect(sandbox.ttlSeconds).toBeNull()
    expect(sandbox.env).toEqual({ BLOCKLY_DEPLOYMENT: 'test', BLOCKLY_SERVER: KEY })
    expect(sandbox.workload.state).toBe('running')
    // Only the game port is let in; the console port never leaves the container.
    expect([...sandbox.firewall]).toEqual(['25565'])
    const config = JSON.parse(sandbox.config ?? '{}')
    expect(Object.keys(config.HostConfig.PortBindings)).toEqual(['25565/tcp'])
    expect(config.Env).toContain('RCON_PASSWORD=secret-rcon-password')
    expect(config.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' })
    // The secret went through the file endpoint, never on a command line.
    expect(boat.calls.some((c) => c.includes('files'))).toBe(true)
    expect(saved).toEqual([handle])
    expect(decodeHandle(handle)).toMatchObject({ sandboxId: sandbox.id, address: sandbox.ip, open: [25565] })
  })

  test('asking again makes nothing and spends no start', async () => {
    const { boat, runtime } = setup()
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    expect(boat.sandboxes.size).toBe(1)
    expect(boat.starts()).toBe(1)
  })

  test('a create whose answer was lost is asked again under the same key and finds the one it made', async () => {
    const { boat, runtime } = setup()
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const [key] = boat.idempotency.keys()
    expect(key).toBe(`blockly:test:${KEY}:first`)
  })

  test('a server asleep is woken by provisioning at its new address, with the firewall open again', async () => {
    const { boat, runtime } = setup()
    const first = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(first)
    const woken = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    expect(decodeHandle(woken).address).not.toBe(decodeHandle(first).address)
    expect(only(boat).firewall.has('25565')).toBe(true)
    expect(boat.starts()).toBe(2)
  })

  test('sizes hold the workload beside the system, and the world twice beside the image', () => {
    expect(typeFor({ memoryMb: 3072, storageGb: 3 })).toBe('small')
    expect(typeFor({ memoryMb: 4096, storageGb: 5 })).toBe('default')
    expect(typeFor({ memoryMb: 3072, storageGb: 10 })).toBe('default')
    expect(typeFor({ memoryMb: 8192, storageGb: 20 })).toBe('large')
    expect(typeFor({ memoryMb: 16384, storageGb: 3 })).toBeNull()
    expect(typeFor({ memoryMb: 3072, storageGb: 80 })).toBeNull()
  })

  test('a server no size holds is refused, never put on one too small for it', async () => {
    const { boat, runtime } = setup()
    const huge = { ...spec, resources: { memoryMb: 16384 } }
    await expect(runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, huge, sink())).rejects.toBeInstanceOf(
      RuntimeUnsupported,
    )
    expect(boat.sandboxes.size).toBe(0)
  })
})

describe('BoatRuntime power', () => {
  test('start resumes a stopped sandbox once, and returns the handle at its new address', async () => {
    const { boat, runtime } = setup()
    const first = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(first)
    const started = await runtime.start(first)
    expect(started).not.toBe(first)
    expect(decodeHandle(started).address).toBe(only(boat).ip)
    expect(only(boat).workload.state).toBe('running')
    // Started again, nothing more is spent.
    expect(await runtime.start(started)).toBe(started)
    expect(boat.starts()).toBe(2)
  })

  test('two starts at once resume the sandbox once', async () => {
    const { boat, runtime } = setup()
    const first = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(first)
    const [a, b] = await Promise.all([runtime.start(first), runtime.start(first)])
    expect(a).toBe(b)
    expect(boat.calls.filter((c) => c.endsWith('/resume'))).toHaveLength(1)
  })

  test('a start waits for Boat to bring the workload back before starting it', async () => {
    const { boat, runtime } = setup()
    const first = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(first)
    boat.restoreAfter = 2
    const started = await runtime.start(first)
    expect(only(boat).workload.state).toBe('running')
    expect((await runtime.observe(started)).state).toBe('running')
  })

  test('stop stops the workload before the sandbox, and leaves a workload that won’t stop running', async () => {
    const { boat, runtime, lines } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const order = boat.calls.length
    await runtime.stop(handle)
    const after = boat.calls.slice(order)
    expect(after.findIndex((c) => c.endsWith('/commands'))).toBeLessThan(
      after.findIndex((c) => c.endsWith('/stop')),
    )
    expect(only(boat).state).toBe('archived')
    expect(lines.some((l) => l.startsWith('boat stop:'))).toBe(true)

    const again = await runtime.start(handle)
    boat.workloadHangs = true
    await expect(runtime.stop(again)).rejects.toThrow(/did not stop/)
    expect(only(boat).state).toBe('ready')
    // Forced, it is killed, and the sandbox then stops the ordinary way.
    await runtime.forceStop(again)
    expect(only(boat).state).toBe('archived')
    expect(only(boat).workload.exitCode).toBe(137)
  })

  test('stop is idempotent, and restart keeps the sandbox and its address', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.restart(handle)
    expect(only(boat).state).toBe('ready')
    expect(boat.starts()).toBe(1)
    await runtime.stop(handle)
    await runtime.stop(handle)
    expect(boat.calls.filter((c) => c.endsWith('/stop'))).toHaveLength(1)
  })

  test('apply on a stopped server wakes and parks its sandbox; the start after it spends nothing', async () => {
    const { boat, runtime } = setup({ runTtlSeconds: 7200 })
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(handle)
    const applied = await runtime.apply(handle, { ...spec, env: { EULA: 'TRUE', MOTD: 'new' } })
    expect(only(boat).ttlSeconds).toBe(300)
    expect(only(boat).workload.state).toBe('created')
    const started = await runtime.start(applied)
    expect(started).toBe(applied)
    expect(only(boat).ttlSeconds).toBe(7200)
    expect(boat.starts()).toBe(2)
  })
})

describe('BoatRuntime start limits', () => {
  test('a plan with no starts left for the day is refused before Boat is asked', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(handle)
    boat.limits.day.used = boat.limits.day.limit
    await expect(runtime.start(handle)).rejects.toBeInstanceOf(RuntimeFull)
    expect(boat.calls.some((c) => c.endsWith('/resume'))).toBe(false)
  })

  test('upkeep on a sleeping server leaves the end of the day to wakes', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(handle)
    boat.limits.day.used = 70
    await expect(runtime.snapshot(handle)).rejects.toBeInstanceOf(RuntimeFull)
    await runtime.start(handle)
    expect(boat.starts()).toBe(2)
  })

  test('a minute’s limit Boat refuses is waited out; a full plan is not', async () => {
    const { boat, runtime, lines } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(handle)
    boat.refuseStarts = ['rate_limited']
    await runtime.start(handle)
    expect(boat.calls.filter((c) => c.endsWith('/resume'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('boat start:'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('boat start:')).at(-1)).toMatch(
      /kind=resume reason=start server=.* today=2 minute=\d+\/5 hour=\d+\/25 day=\d+\/75/,
    )

    await runtime.stop(handle)
    boat.refuseStarts = ['limit_reached']
    await expect(runtime.start(handle)).rejects.toBeInstanceOf(RuntimeFull)
  })

  test('an account that can’t start anything is refused', async () => {
    const { boat, runtime } = setup()
    boat.canStart = false
    await expect(runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())).rejects.toBeInstanceOf(
      RuntimeFull,
    )
    expect(boat.sandboxes.size).toBe(0)
  })
})

describe('BoatRuntime observation', () => {
  test('a stopped sandbox is stopped; a running workload is running; a gone one is absent', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    expect((await runtime.observe(handle)).state).toBe('running')
    await runtime.stop(handle)
    expect((await runtime.observe(handle)).state).toBe('stopped')
    boat.sandboxes.clear()
    expect((await runtime.observe(handle)).state).toBe('absent')
  })

  test('a sandbox parked for work on a sleeping server is listed stopped, so reconcile leaves it be', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const listed = async () => {
      const states = []
      for await (const item of runtime.observeChanged(new Date(0))) states.push(item.observation.state)
      return states
    }
    expect(await listed()).toEqual(['running'])
    await runtime.stop(handle)
    // A snapshot of the sleeping server wakes its sandbox and parks it.
    await runtime.snapshot(handle)
    expect(only(boat).state).toBe('ready')
    expect(await listed()).toEqual(['stopped'])
  })

  test('compute Boat brought back at another address is observed with the handle to keep', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    expect((await runtime.observe(handle)).handle).toBeUndefined()
    only(boat).ip = '2001:db8::99'
    const seen = await runtime.observe(handle)
    expect(seen.state).toBe('running')
    expect(decodeHandle(seen.handle as RuntimeHandle).address).toBe('2001:db8::99')
  })

  test('the workload’s own state: crashes, restarts after one, and a resume still bringing it back', () => {
    const now = new Date('2026-09-28T02:00:00Z')
    expect(
      workloadObservation('exited 1 false 0 2026-09-28T01:00:00Z 2026-09-28T01:30:00Z', now),
    ).toMatchObject({
      state: 'crashed',
      exit: { code: 1, oom: false },
      at: new Date('2026-09-28T01:30:00Z'),
    })
    expect(workloadObservation('exited 143 false 0 x 2026-09-28T01:30:00Z', now).state).toBe('stopped')
    expect(workloadObservation('exited 137 true 0 x 2026-09-28T01:30:00Z', now)).toMatchObject({
      state: 'crashed',
      exit: { oom: true },
    })
    expect(
      workloadObservation('running 0 false 2 2026-09-28T01:31:00Z 2026-09-28T01:30:00Z', now),
    ).toMatchObject({
      state: 'running',
      failedAt: new Date('2026-09-28T01:30:00Z'),
    })
    expect(workloadObservation('missing', now).state).toBe('starting')
    expect(workloadObservation('created 0 false 0 x x', now).state).toBe('stopped')
    expect(stateOf('archived')).toBe('stopped')
    expect(stateOf('archiving')).toBe('stopping')
    expect(stateOf('provisioning')).toBe('starting')
    expect(stateOf('error')).toBe('crashed')
  })

  test('changes, inventory and removal cover only this deployment’s sandboxes, across pages', async () => {
    const { boat, runtime } = setup()
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.ensureProvisioned(OTHER, { regionKey: 'eu' }, spec, sink())
    boat.foreign('bx owner trial box')
    boat.foreign('bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    const listed = []
    for await (const item of runtime.observeChanged(new Date(0))) listed.push(item.key)
    expect(listed.sort()).toEqual([KEY, OTHER])
    const held = []
    for await (const item of runtime.inventory()) held.push(item.key)
    expect(held.sort()).toEqual([KEY, OTHER])
    await runtime.destroy(KEY)
    expect([...boat.sandboxes.values()].map((s) => s.name).sort()).toEqual([
      'bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b',
      'bly-test-1f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b',
      'bx owner trial box',
    ])
  })

  test('destroy refuses a handle naming another deployment’s sandbox', async () => {
    const { boat, runtime } = setup()
    const theirs = boat.foreign('bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    const forged = encodeHandle({
      deployment: 'test',
      serverId: KEY,
      sandboxId: theirs.id,
      address: null,
      ports: {},
      open: [],
      previous: null,
    })
    await expect(runtime.destroy(forged)).rejects.toThrow(/does not belong/)
    expect(boat.sandboxes.has(theirs.id)).toBe(true)
  })

  test('names map back to server ids, with tags after them, and only this deployment’s', () => {
    expect(serverOf('bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b', 'bly-test-')).toBe(KEY)
    expect(serverOf('bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b owner=ana', 'bly-test-')).toBe(KEY)
    expect(serverOf('bly-staging-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b', 'bly-test-')).toBeNull()
    expect(serverOf('Box 2026-09-28 00:47', 'bly-test-')).toBeNull()
  })
})

describe('BoatRuntime endpoints and tags', () => {
  test('the edge reaches the address; the control plane reaches the sandbox; a released server nothing', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    expect(runtime.stableEndpoints).toBe(false)
    expect(runtime.endpoint(handle, 'game', 'edge')).toEqual({ host: only(boat).ip as string, port: 25565 })
    expect(runtime.endpoint(handle, 'rcon', 'control')).toEqual({ host: only(boat).id, port: 25575 })
    const released = await runtime.release(handle)
    expect(boat.sandboxes.size).toBe(0)
    expect(runtime.endpoint(released, 'game', 'edge')).toEqual({ host: '0.0.0.0', port: 0 })
  })

  test('tags follow the sandbox’s name, written only where they changed', async () => {
    const { boat, runtime } = setup()
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const tags = new Map([[KEY, { owner: 'ana@example.com', name: 'Castle' }]])
    expect(await runtime.tag(tags)).toBe(1)
    expect(only(boat).name).toBe(
      'bly-test-0f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b owner=ana@example.com name=Castle',
    )
    expect(await runtime.tag(tags)).toBe(0)
  })

  test('prices by size while running, and nothing for a stopped one’s disk', () => {
    const { runtime } = setup()
    const handle = encodeHandle({
      deployment: 'test',
      serverId: KEY,
      sandboxId: 'bx_aaaaaaa1',
      address: null,
      ports: {},
      open: [],
      previous: null,
    })
    expect(runtime.prices(handle, { memoryMb: 3072, storageGb: 3 })).toEqual({
      runningHourCents: 1.8,
      storageMonthCents: 0,
    })
    expect(runtime.prices(handle, { memoryMb: 6144, storageGb: 10 })).toEqual({
      runningHourCents: 3.6,
      storageMonthCents: 0,
    })
  })
})

describe('BoatRuntime storage', () => {
  test('a snapshot is an archive in the sandbox: listed, exported, deleted', async () => {
    const { runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const { snapshot, sizeBytes } = await runtime.snapshot(handle)
    expect(sizeBytes).toBe(4096)
    expect((await runtime.goneSnapshots([snapshot])).size).toBe(0)
    expect(
      await runtime.exportSnapshot(snapshot, recordingTarget({ url: 'https://store.test/put' })),
    ).toEqual({
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
    })
    await runtime.deleteSnapshot(snapshot)
    expect([...(await runtime.goneSnapshots([snapshot]))]).toEqual([snapshot])
  })

  test('one larger than a PUT carries goes in parts, their links on one command line', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const { snapshot } = await runtime.snapshot(handle)
    boat.archiveBytes = 100 * MIB
    const target = recordingTarget({ url: 'https://store.test/put?sig=1', maxPutBytes: 64 * MIB })
    expect(await runtime.exportSnapshot(snapshot, target)).toEqual({
      sha256: 'a'.repeat(64),
      sizeBytes: 100 * MIB,
    })
    // Asked for few parts, so their links fit the command; 100 MiB in parts of 8 MiB, the least
    // the plan makes one, is 13 of them, and only those links go.
    expect(target.log.asked).toEqual([{ sizeBytes: 100 * MIB, most: 16 }])
    const [file, mib, size, urls] = boat.exports[1] ?? []
    expect(boat.exports[0]?.slice(1, 3)).toEqual(['https://store.test/put?sig=1', String(64 * MIB)])
    expect([file, mib, size]).toEqual([boat.exports[0]?.[0], '8', String(100 * MIB)])
    expect(urls?.split('\n')).toHaveLength(13)
    expect(target.log.completed).toEqual([
      Array.from({ length: 13 }, (_, index) => ({ number: index + 1, etag: `"etag-${index + 1}"` })),
    ])
  })

  test('parts that fail to go drop the upload in parts', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const { snapshot } = await runtime.snapshot(handle)
    boat.archiveBytes = 100 * MIB
    boat.partsFail = true
    const target = recordingTarget({ maxPutBytes: 64 * MIB })
    await expect(runtime.exportSnapshot(snapshot, target)).rejects.toThrow('uploading part 1')
    expect(target.log.completed).toEqual([])
    expect(target.log.aborted).toBe(1)
  })

  test('a snapshot of a sleeping server wakes and parks its sandbox; a stopped one is not asked about', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    await runtime.stop(handle)
    const { snapshot } = await runtime.snapshot(handle)
    expect(only(boat).ttlSeconds).toBe(300)
    await runtime.stop(handle)
    expect((await runtime.goneSnapshots([snapshot])).size).toBe(0)
  })

  test('restore from a snapshot stops the workload first and leaves it running as it was', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const { snapshot } = await runtime.snapshot(handle)
    const restored = await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, sink())
    expect(decodeHandle(restored).sandboxId).toBe(only(boat).id)
    expect(only(boat).workload.state).toBe('running')
  })

  test('a released world comes back on a new sandbox, under a key naming the one before, parked', async () => {
    const { boat, runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const before = decodeHandle(handle).sandboxId
    const released = await runtime.release(handle)
    expect(decodeHandle(released)).toMatchObject({ sandboxId: null, address: null, previous: before })
    const saved: RuntimeHandle[] = []
    const restored = await runtime.restore(
      released,
      { kind: 'archive', download: { url: 'https://store.test/get' } },
      spec,
      sink(saved),
    )
    expect(saved).toEqual([restored])
    expect(boat.idempotency.has(`blockly:test:${KEY}:${before}`)).toBe(true)
    expect(only(boat).ttlSeconds).toBe(300)
    expect(only(boat).workload.state).toBe('created')
    await runtime.start(restored)
    expect(only(boat).workload.state).toBe('running')
  })

  test('a snapshot from another server’s sandbox is refused', async () => {
    const { runtime } = setup()
    const mine = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const theirs = await runtime.ensureProvisioned(OTHER, { regionKey: 'eu' }, spec, sink())
    const { snapshot } = await runtime.snapshot(theirs)
    await expect(runtime.restore(mine, { kind: 'snapshot', snapshot }, spec, sink())).rejects.toThrow(
      /another server/,
    )
  })
})

describe('Boat console, readiness and output', () => {
  test('commands run through the image’s console tool, each with its own result', async () => {
    const { runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const target = { endpoint: runtime.endpoint(handle, 'rcon', 'control'), passwords: ['unused'] }
    const console = new BoatConsole(runtime)
    expect(await console.run(target, 'list')).toBe('said list')
    expect(await console.runAll(target, ['time set day', 'list'])).toEqual([
      { ok: true, output: 'said time set day' },
      { ok: true, output: 'said list' },
    ])
    await expect(
      console.run({ ...target, endpoint: { host: 'released', port: 25575 } }, 'list'),
    ).rejects.toThrow(/no sandbox/)
  })

  test('readiness is a status ping inside the workload', async () => {
    const { runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const probe = new BoatProbe(runtime)
    expect(await probe.ping(runtime.endpoint(handle, 'game', 'control'), AbortSignal.timeout(1000))).toEqual({
      version: '1.21.8',
      online: 2,
      max: 20,
    })
  })

  test('output comes with Docker’s times, in order whatever their precision', async () => {
    const { runtime } = setup()
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu' }, spec, sink())
    const lines = await new BoatLogSource(runtime).recent(handle, 10)
    expect(lines.map((l) => l.text)).toEqual(['[Server thread/INFO]: Done (1.0s)!', 'second'])
    expect(linesOf('not a line\n')).toEqual([])
  })
})

describe('Boat beside other runtimes, behind the router (docs/runtimes.md)', () => {
  const place = { regionKey: 'eu' }

  test('each server goes to the runtime that owns it, and Boat’s console, probe and logs to Boat', async () => {
    const { runtime } = setup()
    const root = await mkdtemp(join(tmpdir(), 'blockly-boat-router-'))
    const fly = new FakeRuntime({
      provider: 'fake-fly',
      deploymentId: 'test',
      root,
      regionMap: { eu: 'fra' },
    })
    const fleet = new FakeRuntime({
      provider: 'fake-fleet',
      deploymentId: 'test',
      root,
      regionMap: { eu: 'rbx' },
    })
    const router = new RuntimeRouter([fly, runtime, fleet])
    const onBoat = await router.ensureProvisioned('boat', KEY, place, spec, sink())
    const onFly = await router.ensureProvisioned('fake-fly', OTHER, place, spec, sink())
    const third = '2f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b' as RuntimeKey
    const onFleet = await router.ensureProvisioned('fake-fleet', third, place, spec, sink())
    expect([onBoat, onFly, onFleet].map((h) => router.providerOf(h))).toEqual([
      'boat',
      'fake-fly',
      'fake-fleet',
    ])
    // Boat's addresses move; the others' stay.
    expect([onBoat, onFly, onFleet].map((h) => router.stableEndpoint(h))).toEqual([false, true, true])
    expect(router.sameCompute(onBoat, onFly)).toBe(false)

    const said: string[] = []
    const routed = new RoutedAdapters(
      router,
      new Map([
        [
          'boat',
          {
            console: new BoatConsole(runtime),
            probe: new BoatProbe(runtime),
            logs: new BoatLogSource(runtime),
          },
        ],
        [
          'fake-fly',
          {
            console: {
              run: async (_target: unknown, command: string) => {
                said.push(command)
                return 'fly'
              },
              runAll: async () => [],
            },
            probe: { ping: async () => ({ online: 0, max: 0, version: 'fly' }) },
            logs: { recent: async () => [], tail: async function* () {} },
          },
        ],
      ]),
    )
    const boatTarget = { endpoint: router.endpoint(onBoat, 'rcon', 'control'), passwords: ['unused'] }
    expect(await routed.console.run(boatTarget, 'list')).toBe('said list')
    const flyTarget = { endpoint: router.endpoint(onFly, 'rcon', 'control'), passwords: ['unused'] }
    expect(await routed.console.run(flyTarget, 'list')).toBe('fly')
    expect(said).toEqual(['list'])
    expect(
      (await routed.probe.ping(router.endpoint(onBoat, 'game', 'control'), AbortSignal.timeout(1000)))
        .version,
    ).toBe('1.21.8')
    expect((await routed.logs.recent(onBoat, 10)).map((l) => l.text)).toContain('second')

    // A start on Boat may come back elsewhere: the router hands back Boat's handle to keep.
    await router.stop(onBoat)
    expect(router.providerOf(await router.start(onBoat))).toBe('boat')
    await rm(root, { recursive: true, force: true })
  })

  test('a world from another runtime is adopted, and comes onto a new sandbox from its archive', async () => {
    const { boat, runtime } = setup()
    const adopted = await runtime.adopt(OTHER, place, spec)
    expect(runtime.owns(adopted)).toBe(true)
    expect(decodeHandle(adopted)).toMatchObject({ serverId: OTHER, sandboxId: null, previous: null })
    expect(boat.sandboxes.size).toBe(0)
    const restored = await runtime.restore(
      adopted,
      { kind: 'archive', download: { url: 'https://store.test/world.tar.gz' } },
      spec,
      sink(),
    )
    // A new sandbox, made for this server, its world brought in by the archive's link.
    expect(decodeHandle(restored).sandboxId).toBe(only(boat).id)
    expect(only(boat).name).toBe('bly-test-1f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b')
    expect(boat.calls.filter((call) => call.endsWith('/commands')).length).toBeGreaterThan(0)
    expect(await runtime.capacity()).toBeNull()
  })

  test('room for a new server is a region Boat serves, with starts to spare beyond the wakes', async () => {
    const boat = new FakeBoat()
    const client = boatClient('boat_p_test', { baseUrl: 'https://boat.test/api/v1', fetch: boat.fetch })
    const starts = new BoatStarts(client, { pause: async () => {}, log: () => {}, cacheMs: 0 })
    const runtime = new BoatRuntime({
      client,
      deploymentId: 'test',
      starts,
      runTtlSeconds: null,
      regions: ['eu'],
    })
    expect(await runtime.hasRoom(place)).toBe(true)
    expect(await runtime.hasRoom({ regionKey: 'us' })).toBe(false)
    // 70 of 75 used: what is left is the share kept for wakes, not for new servers.
    boat.limits.day.used = 70
    expect(await runtime.hasRoom(place)).toBe(false)
    boat.limits.day.used = 0
    boat.canStart = false
    expect(await runtime.hasRoom(place)).toBe(false)
  })
})
