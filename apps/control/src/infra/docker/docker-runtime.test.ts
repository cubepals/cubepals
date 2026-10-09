import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Docker from 'dockerode'
import { type RuntimeSpec, runtimeKey } from '../../app/ports/runtime.ts'
import { S3ArchiveStore } from '../s3/s3-archive-store.ts'
import { DockerRuntime } from './docker-runtime.ts'
import { decodeHandle, encodeHandle } from './handle.ts'

// Snapshots, archive exports and archive restores on real Docker volumes, through a real S3
// store that the helper containers reach the way game runtimes do (§8, §16).
const SOCKET = '/var/run/docker.sock'
const MIB = 1024 ** 2
const IMAGE = 'alpine:3.22'
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

const spec: RuntimeSpec = {
  image: IMAGE,
  env: {},
  secrets: {},
  resources: { memoryMb: 64 },
  storage: { mountPath: '/data', sizeGb: 1 },
  ports: [],
  stop: { signal: 'SIGTERM', timeoutSeconds: 1 },
  labels: {},
}
const progress = { step: async () => {}, handle: async () => {} }

/**
 * Each step against Docker and the store gets its own deadline, so a stall fails the test at the
 * step that stalled, by name, rather than at the test's own timeout with nothing said.
 */
async function step<T>(label: string, work: Promise<T>, ms = 45_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

test('a Docker runtime given a region map places only the regions it names', async () => {
  const options = { socketPath: '/nonexistent.sock', deploymentId: 'test', gameNetwork: 'test' }
  const mapped = new DockerRuntime({ ...options, regionMap: { local: 'local' } })
  expect(await mapped.hasRoom({ regionKey: 'local' })).toBe(true)
  expect(await mapped.hasRoom({ regionKey: 'far' })).toBe(false)
  // Without one, it is the only machine there is: every region is its.
  expect(await new DockerRuntime(options).hasRoom({ regionKey: 'far' })).toBe(true)
})
describe.skipIf(!existsSync(SOCKET) || !s3.endpoint || !s3.bucket)('Docker volumes and archives', () => {
  const docker = new Docker({ socketPath: SOCKET })
  const deployment = `test-${randomUUID().slice(0, 8)}`
  const runtime = new DockerRuntime({ socketPath: SOCKET, deploymentId: deployment, gameNetwork: 'bridge' })
  // The control plane reaches the store on the host; helper containers through the host gateway.
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    runtimeEndpoint: (s3.endpoint ?? '').replace(/127\.0\.0\.1|localhost/, 'host.docker.internal'),
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })
  const key = runtimeKey(randomUUID())
  const archiveKey = `archives/test/${randomUUID()}.tar.gz`

  /** Runs a shell command in a throwaway container with the volume at /data; returns its output. */
  async function inVolume(volume: string, script: string): Promise<string> {
    const container = await docker.createContainer({
      Image: IMAGE,
      Cmd: ['sh', '-c', script],
      HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }] },
    })
    try {
      await container.start()
      await container.wait()
      const logs = (await container.logs({ stdout: true, stderr: true })) as Buffer
      // Framed output: skip each 8-byte header.
      let out = ''
      for (let at = 0; at + 8 <= logs.length; ) {
        const length = logs.readUInt32BE(at + 4)
        out += logs.subarray(at + 8, at + 8 + length).toString('utf8')
        at += 8 + length
      }
      return out
    } finally {
      await container.remove({ force: true })
    }
  }

  // Both images the runtime uses here, pulled before any test so a slow registry isn't counted
  // against a test's time.
  beforeAll(async () => {
    for (const image of [IMAGE, 'curlimages/curl:8.22.0']) {
      const present = await docker
        .getImage(image)
        .inspect()
        .then(
          () => true,
          () => false,
        )
      if (present) continue
      const stream = await docker.pull(image)
      await new Promise((resolve, reject) =>
        docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))),
      )
    }
  }, 240_000)

  afterAll(async () => {
    await runtime.destroy(key).catch(() => undefined)
    await store.delete(archiveKey).catch(() => undefined)
    const { Volumes } = await docker.listVolumes({ filters: { label: [`blockly.deployment=${deployment}`] } })
    for (const volume of Volumes ?? [])
      await docker
        .getVolume(volume.Name)
        .remove()
        .catch(() => undefined)
  })

  test('a forced stop kills at once what a graceful stop would wait out', async () => {
    // `sleep` as PID 1 ignores SIGTERM: a graceful stop would wait out its whole timeout.
    const name = `blockly-${deployment}-kill`
    const container = await docker.createContainer({ Image: IMAGE, name, Cmd: ['sleep', '600'] })
    await container.start()
    const handle = encodeHandle({
      deployment,
      serverId: randomUUID(),
      container: name,
      volume: 'unused',
      ports: {},
    })
    try {
      const started = Date.now()
      await runtime.forceStop(handle)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect((await container.inspect()).State.Running).toBe(false)
      // Already stopped: nothing to do, and no error.
      await runtime.forceStop(handle)
    } finally {
      await container.remove({ force: true })
    }
  }, 30_000)

  test('changes list what started or stopped since, and a server whose container went as absent', async () => {
    const server = runtimeKey(randomUUID())
    const handle = await step(
      'provisioning',
      runtime.ensureProvisioned(server, { regionKey: 'local' }, spec, progress),
    )
    const listed = async (since: Date) => {
      const found = []
      for await (const item of runtime.observeChanged(since)) if (item.key === server) found.push(item)
      return found
    }
    try {
      // Alpine's shell exits at once: the container changed just now. On a busy machine it can
      // still be running for a moment, so the listing waits for the exit.
      const container = docker.getContainer(decodeHandle(handle).container)
      for (let i = 0; i < 50 && (await container.inspect()).State.Running; i++) await Bun.sleep(100)
      const now = await step('listing changes', listed(new Date()))
      expect(now.map((c) => c.observation.state)).toEqual(['stopped'])
      expect(now.map((c) => runtime.sameCompute(c.handle, handle))).toEqual([true])
      // Nothing about it changed since a moment more than a minute from now.
      expect(await step('listing later', listed(new Date(Date.now() + 120_000)))).toEqual([])
      // Its container removed behind the runtime's back: the volume is left, and the server absent.
      await docker.getContainer(decodeHandle(handle).container).remove({ force: true })
      const gone = await step('listing the gone', listed(new Date(Date.now() + 120_000)))
      expect(gone.map((c) => c.observation.state)).toEqual(['absent'])
      expect(gone.map((c) => runtime.sameCompute(c.handle, handle))).toEqual([true])
    } finally {
      await runtime.destroy(server).catch(() => undefined)
    }
  }, 60_000)

  test('one host means every server is placed, and a rebuild from a snapshot is a restore of it', async () => {
    const server = runtimeKey(randomUUID())
    const handle = await step(
      'provisioning',
      runtime.ensureProvisioned(server, { regionKey: 'local' }, spec, progress),
    )
    try {
      expect(runtime.isPlaced(handle, { regionKey: 'anywhere' })).toBe(true)
      const { volume } = decodeHandle(handle)
      await step('writing the world', inVolume(volume, 'echo kept > /data/kept.txt'))
      const { snapshot } = await step('the snapshot', runtime.snapshot(handle))
      await step('writing after it', inVolume(volume, 'echo lost > /data/lost.txt'))
      const rebuilt = await step(
        'the rebuild',
        runtime.relocate(handle, { regionKey: 'local' }, spec, progress, snapshot),
      )
      expect(await step('reading back', inVolume(decodeHandle(rebuilt).volume, 'ls /data'))).toBe(
        'kept.txt\n',
      )
    } finally {
      await runtime.destroy(server).catch(() => undefined)
    }
  }, 90_000)

  test('servers made at once, or beside stopped ones, each get a host port of their own', async () => {
    const withPort: RuntimeSpec = {
      ...spec,
      ports: [{ name: 'game', port: 8080, protocol: 'tcp', audience: ['edge', 'control'] }],
    }
    const keys = [runtimeKey(randomUUID()), runtimeKey(randomUUID()), runtimeKey(randomUUID())]
    const make = (key: (typeof keys)[number]) =>
      step('provisioning', runtime.ensureProvisioned(key, { regionKey: 'local' }, withPort, progress))
    try {
      const together = await Promise.all([make(keys[0] as never), make(keys[1] as never)])
      // Alpine's shell has exited: both are stopped, and hold their ports only on record.
      const beside = await make(keys[2] as never)
      const hosts = [...together, beside].map((handle) => decodeHandle(handle).ports.game?.host)
      expect(hosts.every((port) => typeof port === 'number')).toBe(true)
      expect(new Set(hosts).size).toBe(3)
    } finally {
      for (const key of keys) await runtime.destroy(key).catch(() => undefined)
    }
  }, 60_000)

  test("destroy refuses another deployment's container and volume, whatever the handle says", async () => {
    const name = `blockly-elsewhere-${randomUUID().slice(0, 8)}`
    const labels = { 'blockly.deployment': 'someone-else' }
    await docker.createVolume({ Name: `${name}-data`, Labels: labels })
    const container = await docker.createContainer({
      Image: IMAGE,
      name,
      Cmd: ['sleep', '600'],
      Labels: labels,
    })
    const handle = (from: string) =>
      encodeHandle({
        deployment: from,
        serverId: randomUUID(),
        container: name,
        volume: `${name}-data`,
        ports: {},
      })
    try {
      await expect(runtime.destroy(handle('someone-else'))).rejects.toThrow('does not belong')
      // A handle that claims this deployment, naming their container: the labels decide.
      await expect(runtime.destroy(handle(deployment))).rejects.toThrow('does not belong')
      expect((await container.inspect()).Name).toBe(`/${name}`)
      expect((await docker.getVolume(`${name}-data`).inspect()).Name).toBe(`${name}-data`)
    } finally {
      await container.remove({ force: true })
      await docker.getVolume(`${name}-data`).remove()
    }
  }, 30_000)

  test('a snapshot exports as a tarball in the store, and an archive restore brings it back', async () => {
    const handle = await step(
      'provisioning',
      runtime.ensureProvisioned(key, { regionKey: 'local' }, spec, progress),
    )
    const { volume } = decodeHandle(handle)
    // Files as a game server leaves them: owned by its user, in a world directory.
    await step(
      'writing the world',
      inVolume(
        volume,
        'mkdir -p /data/world && echo before > /data/world/built.txt && chown -R 1000:1000 /data',
      ),
    )

    const taken = await step('the snapshot', runtime.snapshot(handle))
    expect(taken.sizeBytes).toBeGreaterThan(0)
    expect((await step('asking after the snapshot', runtime.goneSnapshots([taken.snapshot]))).size).toBe(0)

    const upload = await store.archiveTarget(archiveKey, 600, 'runtime')
    const exported = await step('the export', runtime.exportSnapshot(taken.snapshot, upload))
    expect(exported.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await step('reading the archive back', store.head(archiveKey)))?.sizeBytes).toBe(
      exported.sizeBytes,
    )

    await step(
      'changing the world',
      inVolume(volume, 'echo griefed > /data/world/built.txt && echo later > /data/extra.txt'),
    )
    const download = await store.presignGet(archiveKey, 600, 'runtime')
    const restored = await step(
      'the archive restore',
      runtime.restore(handle, { kind: 'archive', download }, spec, progress),
    )
    expect(restored).toBe(handle)
    // The volume holds exactly what the archive held, with the owners it had.
    const listing = await step(
      'reading the restored world',
      inVolume(volume, 'cat /data/world/built.txt; stat -c %u /data/world/built.txt; ls /data'),
    )
    expect(listing.trim().split('\n')).toEqual(['before', '1000', 'world'])

    // A snapshot restore works the same way, from the volume copy.
    await step('changing it again', inVolume(volume, 'echo griefed > /data/world/built.txt'))
    await step(
      'the snapshot restore',
      runtime.restore(handle, { kind: 'snapshot', snapshot: taken.snapshot }, spec, progress),
    )
    expect((await step('reading it', inVolume(volume, 'cat /data/world/built.txt'))).trim()).toBe('before')

    await step('deleting the snapshot', runtime.deleteSnapshot(taken.snapshot))
    expect(await step('asking after it again', runtime.goneSnapshots([taken.snapshot]))).toEqual(
      new Set([taken.snapshot]),
    )
  }, 120_000)

  test('release lets the container and volume go, and a restore from the archive brings them back', async () => {
    const server = runtimeKey(randomUUID())
    const withPort: RuntimeSpec = {
      ...spec,
      ports: [{ name: 'game', port: 8080, protocol: 'tcp', audience: ['edge', 'control'] }],
    }
    const copy = `archives/test/${randomUUID()}.tar.gz`
    try {
      const handle = await step(
        'provisioning',
        runtime.ensureProvisioned(server, { regionKey: 'local' }, withPort, progress),
      )
      const { volume, container } = decodeHandle(handle)
      await step(
        'writing the world',
        inVolume(volume, 'mkdir -p /data/world && echo rested > /data/world/built.txt'),
      )
      const { snapshot } = await step('the snapshot', runtime.snapshot(handle))
      await step(
        'the export',
        runtime.exportSnapshot(snapshot, await store.archiveTarget(copy, 600, 'runtime')),
      )

      const released = await step('the release', runtime.release(handle))
      // Nothing is left: no container, no volume, no snapshot volume.
      expect(
        await docker
          .getContainer(container)
          .inspect()
          .catch(() => null),
      ).toBeNull()
      expect(
        await docker
          .getVolume(volume)
          .inspect()
          .catch(() => null),
      ).toBeNull()
      // Its snapshots went with it.
      expect((await runtime.goneSnapshots([snapshot])).has(snapshot)).toBe(true)
      // A resting server keeps its route, since a join is what wakes it: the edge still has
      // somewhere to dial.
      expect(runtime.endpoint(released, 'game', 'edge')).toEqual(runtime.endpoint(handle, 'game', 'edge'))
      // Asked again, it has nothing more to do.
      await step('releasing again', runtime.release(released))

      const back = await step(
        'the wake',
        runtime.restore(
          released,
          { kind: 'archive', download: await store.presignGet(copy, 600, 'runtime') },
          withPort,
          progress,
        ),
      )
      expect(
        await step('reading back', inVolume(decodeHandle(back).volume, 'cat /data/world/built.txt')),
      ).toBe('rested\n')
      // Its volume is the server's again, labelled so, and its container has a host port.
      const labels = (await docker.getVolume(decodeHandle(back).volume).inspect()).Labels
      expect(labels?.['blockly.server']).toBe(server)
      expect(typeof decodeHandle(back).ports.game?.host).toBe('number')
    } finally {
      await runtime.destroy(server).catch(() => undefined)
      await store.delete(copy).catch(() => undefined)
    }
  }, 120_000)

  test('a snapshot larger than one PUT carries goes to the store in parts, and restores whole', async () => {
    const server = runtimeKey(randomUUID())
    const copy = `archives/test/${randomUUID()}.tar.gz`
    try {
      const handle = await step(
        'provisioning',
        runtime.ensureProvisioned(server, { regionKey: 'local' }, spec, progress),
      )
      const { volume } = decodeHandle(handle)
      // 20 MiB that doesn't compress: an archive of three parts of 8 MiB, the last shorter.
      const written = await step(
        'writing the world',
        inVolume(
          volume,
          'mkdir -p /data/world && head -c 20971520 /dev/urandom > /data/world/region.mca && sha256sum /data/world/region.mca',
        ),
      )
      const { snapshot } = await step('the snapshot', runtime.snapshot(handle))
      // A store that takes no more than 4 MiB in one PUT, as R2 takes no more than 5 GiB.
      const target = { ...(await store.archiveTarget(copy, 600, 'runtime')), maxPutBytes: 4 * MIB }
      const exported = await step('the export in parts', runtime.exportSnapshot(snapshot, target), 90_000)
      expect(exported.sizeBytes).toBeGreaterThan(20 * MIB)
      expect(await store.head(copy)).toEqual({ sizeBytes: exported.sizeBytes })
      const read = await fetch((await store.presignGet(copy, 600, 'browser')).url)
      expect(
        createHash('sha256')
          .update(Buffer.from(await read.arrayBuffer()))
          .digest('hex'),
      ).toBe(exported.sha256)
      // The volume the archive waited in is gone.
      const { Volumes } = await docker.listVolumes({
        filters: { label: [`blockly.deployment=${deployment}`] },
      })
      expect((Volumes ?? []).filter((v) => v.Name.includes('-export-'))).toEqual([])

      await step('changing the world', inVolume(volume, 'echo griefed > /data/world/region.mca'))
      const download = await store.presignGet(copy, 600, 'runtime')
      await step(
        'the restore',
        runtime.restore(handle, { kind: 'archive', download }, spec, progress),
        90_000,
      )
      expect(await step('reading it back', inVolume(volume, 'sha256sum /data/world/region.mca'))).toBe(
        written,
      )
    } finally {
      await runtime.destroy(server).catch(() => undefined)
      await store.delete(copy).catch(() => undefined)
    }
  }, 240_000)

  test('a restore from an archive that is missing or broken fails, and leaves the world alone', async () => {
    const handle = await runtime.ensureProvisioned(key, { regionKey: 'local' }, spec, progress)
    const { volume } = decodeHandle(handle)
    await inVolume(volume, 'mkdir -p /data/world && echo still here > /data/world/built.txt')

    const missing = await store.presignGet(`archives/test/${randomUUID()}.tar.gz`, 600, 'runtime')
    const failed = await runtime
      .restore(handle, { kind: 'archive', download: missing }, spec, progress)
      .catch((e) => e)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain('A helper container failed')

    const broken = `archives/test/${randomUUID()}.tar.gz`
    const put = await store.presignPut(broken, 600, 'browser')
    await fetch(put.url, { method: 'PUT', body: 'not a tarball', headers: put.headers })
    const download = await store.presignGet(broken, 600, 'runtime')
    const refused = await runtime
      .restore(handle, { kind: 'archive', download }, spec, progress)
      .catch((e) => e)
    await store.delete(broken)
    expect(refused).toBeInstanceOf(Error)
    expect((await inVolume(volume, 'cat /data/world/built.txt')).trim()).toBe('still here')
  }, 60_000)
})

// A new server's install, copied from the one made for its release instead of downloaded again.
describe.skipIf(!existsSync(SOCKET))('Docker installs', () => {
  const docker = new Docker({ socketPath: SOCKET })
  const deployment = `test-${randomUUID().slice(0, 8)}`
  const runtime = new DockerRuntime({ socketPath: SOCKET, deploymentId: deployment, gameNetwork: 'bridge' })
  const key = runtimeKey(randomUUID())
  const install = { key: `alpine test ${deployment}`, env: {}, paths: ['server.jar', '.manifest.json'] }
  const made = `bly-${deployment}-install-${createHash('sha256').update(install.key).digest('hex').slice(0, 16)}`

  async function inVolume(volume: string, script: string): Promise<string> {
    const container = await docker.createContainer({
      Image: IMAGE,
      Cmd: ['sh', '-c', script],
      HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }] },
    })
    try {
      await container.start()
      await container.wait()
      const logs = (await container.logs({ stdout: true })) as Buffer
      // Framed output: skip each 8-byte header.
      let out = ''
      for (let at = 0; at + 8 <= logs.length; ) {
        const length = logs.readUInt32BE(at + 4)
        out += logs.subarray(at + 8, at + 8 + length).toString('utf8')
        at += 8 + length
      }
      return out
    } finally {
      await container.remove({ force: true })
    }
  }

  afterAll(async () => {
    await runtime.destroy(key).catch(() => undefined)
    const { Volumes } = await docker.listVolumes({ filters: { label: [`blockly.deployment=${deployment}`] } })
    for (const volume of Volumes ?? [])
      await docker
        .getVolume(volume.Name)
        .remove()
        .catch(() => undefined)
  })

  test('a new server gets the install made for its release, and nothing else of that run', async () => {
    // What a setup-only run leaves: the install, and the console password it made on the way.
    await docker.createVolume({
      Name: made,
      Labels: { 'blockly.deployment': deployment, 'blockly.install': install.key },
    })
    await inVolume(
      made,
      'echo jar > /data/server.jar && echo {} > /data/.manifest.json && echo p > /data/.rcon-cli.env && touch /data/.blockly-install-done',
    )
    const handle = await step(
      'provisioning with the install',
      runtime.ensureProvisioned(key, { regionKey: 'local' }, spec, progress, install),
    )
    const { volume } = decodeHandle(handle)
    expect(await inVolume(volume, 'ls -A /data | sort')).toBe('.manifest.json\nserver.jar\n')
    expect((await inVolume(volume, 'cat /data/server.jar')).trim()).toBe('jar')
  }, 60_000)
})
