// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ArchiveTarget,
  type PutPart,
  type RuntimeSpec,
  runtimeKey,
  type SnapshotHandle,
} from '../../../app/ports/runtime.ts'
import { DockerRuntime } from '../docker-runtime.ts'
import { decodeHandle } from '../handle.ts'

// What the runtime asks of the Docker daemon, in order, for the flows that move worlds: a first
// provision with an install, a snapshot and its restore, an export in parts, a helper that fails,
// and host ports. The daemon is a recording fake on a unix socket, so these run without Docker.

type Request = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }
type HelperRun = { code: number; stdout?: string; stderr?: string }
type Container = {
  id: string
  name: string
  config: Record<string, unknown>
  labels: Record<string, string>
  running: boolean
  helper: boolean
}

const SOCKET = join(tmpdir(), `blockly-engine-${process.pid}.sock`)
const DEPLOYMENT = 'test'
const requests: Request[] = []
const containers = new Map<string, Container>()
const volumes = new Map<string, Record<string, string>>()
/** What a helper prints and exits with, by its command; its `wait` can be held by `holdWait`. */
let helper: (cmd: string[], env: string[]) => HelperRun = () => ({ code: 0 })
let holdWait: (cmd: string[]) => Promise<void> | undefined = () => undefined
let nextId = 0

const spec: RuntimeSpec = {
  image: 'game:1',
  env: { A: '1' },
  secrets: { S: '2' },
  resources: { memoryMb: 64 },
  storage: { mountPath: '/data', sizeGb: 1 },
  ports: [],
  stop: { signal: 'SIGTERM', timeoutSeconds: 7 },
  labels: { 'blockly.server': 'from-spec' },
}
const progress = () => {
  const said: string[] = []
  return {
    said,
    sink: { step: async (s: string) => void said.push(s), handle: async () => void said.push('handle') },
  }
}

function framed(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

function find(idOrName: string): Container | undefined {
  return containers.get(idOrName) ?? [...containers.values()].find((c) => c.name === idOrName)
}

/** A reply, written by `node:http`: the global `Response` may not be Bun's own (Hono's node server swaps it). */
type Answer = { status: number; body?: Buffer; type?: string }
const json = (value: unknown, status = 200): Answer => ({
  status,
  body: Buffer.from(JSON.stringify(value)),
  type: 'application/json',
})
const none = (status = 204): Answer => ({ status })

async function answer(req: Request): Promise<Answer> {
  const { method, path, body } = req
  if (method === 'GET' && path === '/networks') return json([{ Name: 'games' }])
  if (method === 'GET' && /^\/images\/.+\/json$/.test(path)) return json({ Id: 'image' })
  if (method === 'GET' && path === '/volumes') {
    const filter = JSON.parse(req.query.get('filters') ?? '{}').label as string[]
    const matches = (labels: Record<string, string>) =>
      filter.every((f) => {
        const [k, v] = f.split('=')
        return k !== undefined && k in labels && (v === undefined || labels[k] === v)
      })
    return json({
      Volumes: [...volumes].filter(([, l]) => matches(l)).map(([Name, Labels]) => ({ Name, Labels })),
    })
  }
  if (method === 'POST' && path === '/volumes/create') {
    volumes.set(body.Name as string, (body.Labels ?? {}) as Record<string, string>)
    return json({ Name: body.Name }, 201)
  }
  const volume = path.match(/^\/volumes\/(.+)$/)
  if (volume) {
    const name = decodeURIComponent(volume[1] as string)
    if (!volumes.has(name)) return json({ message: 'no such volume' }, 404)
    if (method === 'DELETE') {
      volumes.delete(name)
      return none()
    }
    return json({ Name: name, Labels: volumes.get(name) })
  }
  if (method === 'GET' && path === '/containers/json')
    return json(
      [...containers.values()]
        .filter((c) => c.labels['blockly.deployment'] === DEPLOYMENT)
        .map((c) => ({ Id: c.id, Labels: c.labels, Ports: [] })),
    )
  if (method === 'POST' && path === '/containers/create') {
    const id = `c${++nextId}`
    const name = req.query.get('name') ?? id
    const labels = (body.Labels ?? {}) as Record<string, string>
    containers.set(id, { id, name, config: body, labels, running: false, helper: !req.query.get('name') })
    return json({ Id: id }, 201)
  }
  const m = path.match(/^\/containers\/([^/]+)(\/[a-z]+)?$/)
  if (!m) return json({ message: path }, 500)
  const container = find(decodeURIComponent(m[1] as string))
  if (!container) return json({ message: 'no such container' }, 404)
  const verb = m[2] ?? ''
  if (method === 'GET' && verb === '/json')
    return json({
      Id: container.id,
      Name: `/${container.name}`,
      Config: { Labels: container.labels },
      State: {
        Running: container.running,
        Restarting: false,
        Status: container.running ? 'running' : 'created',
        ExitCode: 0,
        OOMKilled: false,
        StartedAt: '0001-01-01T00:00:00Z',
        FinishedAt: '0001-01-01T00:00:00Z',
      },
      Mounts: ((container.config.HostConfig as { Mounts?: { Source: string }[] })?.Mounts ?? []).map(
        (mount) => ({
          Type: 'volume',
          Name: mount.Source,
        }),
      ),
    })
  if (method === 'POST' && verb === '/start') {
    if (container.running) return none(304)
    container.running = !container.helper
    return none()
  }
  if (method === 'POST' && verb === '/stop') {
    if (!container.running) return none(304)
    container.running = false
    return none()
  }
  if (method === 'DELETE' && verb === '') {
    containers.delete(container.id)
    return none()
  }
  const cmd = (container.config.Cmd ?? []) as string[]
  if (method === 'POST' && verb === '/wait') {
    await holdWait(cmd)
    return json({ StatusCode: helper(cmd, (container.config.Env ?? []) as string[]).code })
  }
  if (method === 'GET' && verb === '/logs') {
    const run = helper(cmd, (container.config.Env ?? []) as string[])
    return {
      status: 200,
      body: Buffer.concat([framed(1, run.stdout ?? ''), framed(2, run.stderr ?? '')]),
      type: 'application/vnd.docker.raw-stream',
    }
  }
  return json({ message: `${method} ${path}` }, 500)
}

const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString()
  const url = new URL(incoming.url ?? '/', 'http://docker')
  const req = {
    method: incoming.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    body: text.startsWith('{') ? JSON.parse(text) : {},
  }
  requests.push(req)
  const reply = await answer(req)
  outgoing.writeHead(
    reply.status,
    reply.body === undefined ? {} : { 'Content-Type': reply.type, 'Content-Length': reply.body.length },
  )
  outgoing.end(reply.body)
})
beforeAll(async () => {
  rmSync(SOCKET, { force: true })
  await new Promise<void>((resolve) => server.listen(SOCKET, resolve))
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(SOCKET, { force: true })
})

beforeEach(() => {
  requests.length = 0
  containers.clear()
  volumes.clear()
  helper = () => ({ code: 0 })
  holdWait = () => undefined
  nextId = 0
})

const runtime = () =>
  new DockerRuntime({ socketPath: SOCKET, deploymentId: DEPLOYMENT, gameNetwork: 'games' })
const lines = () => requests.map((r) => `${r.method} ${r.path}`)
const helperCreates = () =>
  requests.filter((r) => r.path === '/containers/create' && !r.query.get('name')).map((r) => r.body)
const script = (body: Record<string, unknown>) => (body.Cmd as string[])[2]
const key = runtimeKey('0b6c6a3e-3f43-4c39-9a52-2a8a1d1b7f10')
const base = `bly-${DEPLOYMENT}-0b6c6a3e3f434c399a522a8a1d1b7f10`

test('a first provision with an install seed makes the server, copies nothing yet, and makes the install once', async () => {
  const install = { key: 'release 1', env: { TYPE: 'X' }, paths: ['server.jar', '.manifest.json'] }
  const made = `bly-${DEPLOYMENT}-install-${createHash('sha256').update(install.key).digest('hex').slice(0, 16)}`
  helper = (cmd) => (cmd[3] === 'seed' ? { code: 0, stdout: 'missing\n' } : { code: 0 })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  holdWait = (cmd) => (cmd.length === 0 ? held : undefined)
  const said = progress()
  const other = runtimeKey('1b6c6a3e-3f43-4c39-9a52-2a8a1d1b7f10')
  const docker = runtime()
  const handle = await docker.ensureProvisioned(key, { regionKey: 'local' }, spec, said.sink, install)
  // A second server with the same install while the first one is being made starts no other.
  await docker.ensureProvisioned(other, { regionKey: 'local' }, spec, progress().sink, install)

  expect(said.said).toEqual(['allocating', 'storage', 'compute', 'handle', 'booting'])
  expect(decodeHandle(handle)).toEqual({
    deployment: DEPLOYMENT,
    serverId: key,
    container: base,
    volume: `${base}-data`,
    ports: {},
  })
  expect(lines().slice(0, 13)).toEqual([
    'GET /networks',
    'GET /images/game:1/json',
    `GET /volumes/${base}-data`,
    'POST /volumes/create',
    `GET /containers/${base}/json`,
    'GET /containers/json',
    'POST /containers/create',
    `GET /volumes/${made}`,
    'POST /volumes/create',
    'GET /images/alpine:3.22/json',
    'POST /containers/create',
    'POST /containers/c2/start',
    'POST /containers/c2/wait',
  ])
  expect(requests[3]?.body).toEqual({
    Name: `${base}-data`,
    Labels: { 'blockly.deployment': DEPLOYMENT, 'blockly.server': key },
  })
  expect(requests[6]?.query.get('name')).toBe(base)
  expect(requests[6]?.body).toEqual({
    name: base,
    Image: 'game:1',
    Env: ['A=1', 'S=2'],
    Labels: {
      'blockly.server': key,
      'blockly.deployment': DEPLOYMENT,
      'blockly.spec-digest': createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 32),
      'blockly.stop-timeout': '7',
      'blockly.ports': '{}',
    },
    ExposedPorts: {},
    StopSignal: 'SIGTERM',
    StopTimeout: 7,
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: `${base}-data`, Target: '/data' }],
      Memory: 64 * 1024 * 1024,
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 4096,
      PortBindings: {},
      NetworkMode: 'games',
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
  })
  expect(requests[8]?.body).toEqual({
    Name: made,
    Labels: { 'blockly.deployment': DEPLOYMENT, 'blockly.install': 'release 1' },
  })
  const copy = helperCreates()[0] ?? {}
  expect(copy).toEqual({
    Image: 'alpine:3.22',
    Cmd: [
      'sh',
      '-c',
      '[ -f /made/.blockly-install-done ] || { echo missing; exit 0; }; cd /made && cp -an -- "$@" /data/ && echo copied',
      'seed',
      'server.jar',
      '.manifest.json',
    ],
    User: '0',
    Env: [],
    Labels: { 'blockly.deployment': `${DEPLOYMENT}-helper` },
    HostConfig: {
      Mounts: [
        { Type: 'volume', Source: made, Target: '/made', ReadOnly: true },
        { Type: 'volume', Source: `${base}-data`, Target: '/data' },
      ],
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
  })
  // The server starts while its install is still being made.
  expect(lines()).toContain(`POST /containers/${base}/start`)

  release()
  for (let i = 0; i < 100 && helperCreates().length < 5; i++) await Bun.sleep(10)
  await Bun.sleep(50)
  const makes = helperCreates().filter((body) => (body.Cmd as string[])[3] !== 'seed')
  expect(makes.map((body) => [body.Image, body.Cmd, body.Env, body.HostConfig])).toEqual([
    [
      'alpine:3.22',
      ['sh', '-c', 'find /made -mindepth 1 -delete'],
      [],
      {
        Mounts: [{ Type: 'volume', Source: made, Target: '/made' }],
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    ],
    [
      'game:1',
      [],
      ['TYPE=X'],
      {
        Mounts: [{ Type: 'volume', Source: made, Target: '/data' }],
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    ],
    [
      'alpine:3.22',
      [
        'sh',
        '-c',
        'set -e; mkdir /keep; cd /made; cp -a -- "$@" /keep/; find /made -mindepth 1 -delete; cp -a /keep/. /made/; touch /made/.blockly-install-done',
        'keep',
        'server.jar',
        '.manifest.json',
      ],
      [],
      {
        Mounts: [{ Type: 'volume', Source: made, Target: '/made' }],
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    ],
  ])
  // Every helper went once it was done.
  expect([...containers.values()].filter((c) => c.helper)).toEqual([])
})

test('a snapshot copies the volume into a labelled one, and a restore from it stops, wipes, copies and remakes', async () => {
  helper = (cmd) => (cmd[2]?.endsWith('du -sk /to') ? { code: 0, stdout: '12\t/to\n' } : { code: 0 })
  const docker = runtime()
  const handle = await docker.ensureProvisioned(key, { regionKey: 'local' }, spec, progress().sink)
  requests.length = 0
  const taken = await docker.snapshot(handle)
  const snapVolume = (requests[0]?.body.Name as string) ?? ''
  expect(snapVolume).toBe(`${base}-data-snap-${taken.at.getTime()}`)
  expect(taken.snapshot).toBe(`docker-snap:v1:${snapVolume}` as SnapshotHandle)
  expect(taken.sizeBytes).toBe(12 * 1024)
  expect(requests[0]?.body.Labels).toEqual({
    'blockly.deployment': DEPLOYMENT,
    'blockly.server': key,
    'blockly.snapshot-of': `${base}-data`,
  })
  expect(helperCreates().map((b) => [b.Image, script(b), b.HostConfig])).toEqual([
    [
      'alpine:3.22',
      'cp -a /from/. /to/ && du -sk /to',
      {
        Mounts: [
          { Type: 'volume', Source: `${base}-data`, Target: '/from', ReadOnly: true },
          { Type: 'volume', Source: snapVolume, Target: '/to' },
        ],
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    ],
  ])

  requests.length = 0
  const said = progress()
  const restored = await docker.restore(
    handle,
    { kind: 'snapshot', snapshot: taken.snapshot },
    spec,
    said.sink,
  )
  expect(restored).toBe(handle)
  expect(said.said).toEqual(['storage', 'compute'])
  expect(lines()).toEqual([
    `GET /containers/${base}/json`,
    `GET /containers/${base}/json`,
    `POST /containers/${base}/stop`,
    `GET /volumes/${base}-data`,
    'GET /images/alpine:3.22/json',
    'POST /containers/create',
    'POST /containers/c3/start',
    'POST /containers/c3/wait',
    'GET /containers/c3/logs',
    'DELETE /containers/c3',
    `GET /containers/${base}/json`,
    `GET /containers/${base}/json`,
    `POST /containers/${base}/stop`,
    `DELETE /containers/${base}`,
    'GET /images/game:1/json',
    'POST /containers/create',
    `POST /containers/${base}/start`,
  ])
  expect(script(helperCreates()[0] ?? {})).toBe(
    'find /to -mindepth 1 -delete && cp -a /from/. /to/ && du -sk /to',
  )
  expect(requests[2]?.query.get('t')).toBe('7')
  expect(requests[12]?.query.get('t')).toBe('7')
  expect(requests[13]?.query.get('force')).toBe('true')
})

test('an export larger than one PUT goes in parts, and the volume it waited in goes', async () => {
  const hash = 'a'.repeat(64)
  helper = (cmd) =>
    cmd[3] === 'export'
      ? { code: 0, stdout: `${hash}  /out/world.tar.gz\n12582912\nparts\n` }
      : { code: 0, stdout: '1="e1"\n2="e2"\n' }
  const completed: PutPart[][] = []
  let aborted = 0
  const asked: number[] = []
  const target: ArchiveTarget = {
    put: { url: 'http://store/put', headers: { 'x-a': '1' } },
    maxPutBytes: 4 * 1024 * 1024,
    inParts: async (size) => {
      asked.push(size)
      return {
        partSize: 8 * 1024 * 1024,
        urls: ['http://store/1', 'http://store/2', 'http://store/3'],
        headers: { 'x-b': '2' },
        complete: async (parts) => void completed.push([...parts]),
        abort: async () => void aborted++,
      }
    },
  }
  const snapshot = 'docker-snap:v1:world-snap-1' as SnapshotHandle
  const before = Date.now()
  const exported = await runtime().exportSnapshot(snapshot, target)
  expect(exported).toEqual({ sha256: hash, sizeBytes: 12582912 })
  expect(asked).toEqual([12582912])
  expect(completed).toEqual([
    [
      { number: 1, etag: '"e1"' },
      { number: 2, etag: '"e2"' },
    ],
  ])
  expect(aborted).toBe(0)
  const scratch = requests[0]?.body.Name as string
  expect(scratch.startsWith('world-snap-1-export-')).toBe(true)
  expect(Number(scratch.slice('world-snap-1-export-'.length))).toBeGreaterThanOrEqual(before)
  expect(requests[0]?.body.Labels).toEqual({ 'blockly.deployment': DEPLOYMENT })
  expect(lines().at(-1)).toBe(`DELETE /volumes/${scratch}`)
  const [pack, parts] = helperCreates()
  expect(pack?.Image).toBe('curlimages/curl:8.22.0')
  expect(pack?.Cmd).toEqual([
    'sh',
    '-c',
    'tar -czf /out/world.tar.gz -C /from . && sha256sum /out/world.tar.gz && stat -c %s /out/world.tar.gz && if [ "$(stat -c %s /out/world.tar.gz)" -gt "$MOST" ]; then echo parts; else curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-delay 2 -o /dev/null -X PUT -T /out/world.tar.gz "$@" "$TARGET" && echo put; fi',
    'export',
    '-H',
    'x-a: 1',
  ])
  expect(pack?.Env).toEqual(['TARGET=http://store/put', `MOST=${4 * 1024 * 1024}`])
  expect(pack?.HostConfig).toEqual({
    Mounts: [
      { Type: 'volume', Source: 'world-snap-1', Target: '/from', ReadOnly: true },
      { Type: 'volume', Source: scratch, Target: '/out' },
    ],
    ExtraHosts: ['host.docker.internal:host-gateway'],
  })
  expect(parts?.Image).toBe('curlimages/curl:8.22.0')
  expect((parts?.Cmd as string[] | undefined)?.slice(3)).toEqual(['parts', '-H', 'x-b: 2'])
  expect(script(parts ?? {})).toBe(
    [
      'i=1',
      'while [ "$i" -le "$PARTS" ]; do',
      '  eval "url=\\$PART_$i"',
      '  len=$(( SIZE - (i - 1) * MIB * 1048576 )); [ "$len" -gt $(( MIB * 1048576 )) ] && len=$(( MIB * 1048576 ))',
      '  tries=0',
      '  while :; do',
      '    tag=$(dd if=/out/world.tar.gz bs=1048576 skip=$(( (i - 1) * MIB )) count="$MIB" 2>/dev/null | curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o /dev/null -D - -X PUT -T - -H "Content-Length: $len" -H "Transfer-Encoding:" "$@" "$url" | tr -d \'\\r\' | sed -n \'s/^[Ee][Tt][Aa][Gg]: *//p\')',
      '    [ -n "$tag" ] && break',
      '    tries=$((tries + 1)); [ "$tries" -lt 3 ] || exit 1',
      '    sleep 2',
      '  done',
      '  echo "$i=$tag"',
      '  i=$((i + 1))',
      'done',
    ].join('\n'),
  )
  expect(parts?.Env).toEqual([
    'SIZE=12582912',
    'MIB=8',
    'PARTS=2',
    'PART_1=http://store/1',
    'PART_2=http://store/2',
  ])
  expect(parts?.HostConfig).toEqual({
    Mounts: [{ Type: 'volume', Source: scratch, Target: '/out', ReadOnly: true }],
    ExtraHosts: ['host.docker.internal:host-gateway'],
  })

  // The parts fail: the upload is aborted, the error is the helper's, and the scratch still goes.
  requests.length = 0
  helper = (cmd) =>
    cmd[3] === 'export'
      ? { code: 0, stdout: `${hash}  /out/world.tar.gz\n12582912\nparts\n` }
      : { code: 1, stderr: 'curl: (22) 403\n' }
  const failed = await runtime()
    .exportSnapshot(snapshot, target)
    .catch((error: Error) => error)
  expect((failed as Error).message).toBe('A helper container failed with code 1: curl: (22) 403')
  expect(aborted).toBe(1)
  expect(lines().at(-1)).toBe(`DELETE /volumes/${requests[0]?.body.Name as string}`)
  expect([...containers.values()].filter((c) => c.helper)).toEqual([])
})

test('a restore from an archive whose helper fails is removed, says why, and goes no further', async () => {
  const docker = runtime()
  const handle = await docker.ensureProvisioned(key, { regionKey: 'local' }, spec, progress().sink)
  requests.length = 0
  helper = () => ({
    code: 22,
    stdout: 'ignored',
    stderr: '  curl: (22) The requested URL returned error: 404\n',
  })
  const said = progress()
  const failed = await docker
    .restore(handle, { kind: 'archive', download: { url: 'http://store/get' } }, spec, said.sink)
    .catch((error: Error) => error)
  expect((failed as Error).message).toBe(
    'A helper container failed with code 22: curl: (22) The requested URL returned error: 404',
  )
  expect(said.said).toEqual(['storage'])
  const [fetch] = helperCreates()
  expect(fetch?.Image).toBe('curlimages/curl:8.22.0')
  expect(fetch?.Cmd).toEqual([
    'sh',
    '-c',
    'curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-delay 2 -o /tmp/world.tar.gz "$SOURCE" && tar -tzf /tmp/world.tar.gz > /dev/null && find /to -mindepth 1 -delete && tar -xzf /tmp/world.tar.gz -C /to',
  ])
  expect(fetch?.Env).toEqual(['SOURCE=http://store/get'])
  expect(fetch?.HostConfig).toEqual({
    Mounts: [{ Type: 'volume', Source: `${base}-data`, Target: '/to' }],
    ExtraHosts: ['host.docker.internal:host-gateway'],
  })
  expect(lines().slice(-4)).toEqual([
    'POST /containers/c2/start',
    'POST /containers/c2/wait',
    'GET /containers/c2/logs',
    'DELETE /containers/c2',
  ])
  // The server's own container is left as the stop left it.
  expect(find(base)?.running).toBe(false)
})

test('servers made at once get host ports of their own, past one another container records', async () => {
  containers.set('old', {
    id: 'old',
    name: 'old',
    config: {},
    labels: {
      'blockly.deployment': DEPLOYMENT,
      'blockly.ports': JSON.stringify({ game: { container: 8080, host: 42000 } }),
    },
    running: false,
    helper: false,
  })
  const withPorts: RuntimeSpec = {
    ...spec,
    ports: [
      { name: 'game', port: 8080, protocol: 'tcp', audience: ['edge', 'control'] },
      { name: 'edge-only', port: 9090, protocol: 'udp', audience: ['edge'] },
    ],
  }
  const docker = runtime()
  const keys = [
    runtimeKey('2b6c6a3e-3f43-4c39-9a52-2a8a1d1b7f10'),
    runtimeKey('3b6c6a3e-3f43-4c39-9a52-2a8a1d1b7f10'),
  ]
  const handles = await Promise.all(
    keys.map((k) => docker.ensureProvisioned(k, { regionKey: 'local' }, withPorts, progress().sink)),
  )
  const hosts = handles.map((h) => decodeHandle(h).ports.game?.host ?? 0)
  expect(new Set(hosts).size).toBe(2)
  for (const host of hosts) expect(host > 42000 && host <= 42999).toBe(true)
  for (const h of handles) expect(decodeHandle(h).ports['edge-only']).toEqual({ container: 9090, host: null })
  // Each container was made before the next listing, under the one lock.
  expect(lines().filter((l) => l === 'GET /containers/json' || l === 'POST /containers/create')).toEqual([
    'GET /containers/json',
    'POST /containers/create',
    'GET /containers/json',
    'POST /containers/create',
  ])
  const made = requests.filter((r) => r.path === '/containers/create').map((r) => r.body)
  expect(made.map((b) => [b.ExposedPorts, (b.HostConfig as { PortBindings: unknown }).PortBindings])).toEqual(
    hosts.map((host) => [
      { '8080/tcp': {}, '9090/udp': {} },
      { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(host) }] },
    ]),
  )
})
