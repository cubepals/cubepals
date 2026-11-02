// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A runtime check fails closed on missing proof and expires even when a provider answers late. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { type ModValidationPlanJson, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { defaultSettings } from '../../domain/revision/revision.ts'
import { diskName } from '../../minecraft/jars.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { Cdn, jar, sha512 } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { savePackContents } from '../packs/persistence.ts'
import { runtimeKey } from '../ports/runtime.ts'
import { RuntimeRouter } from '../runtimes/router.ts'
import { IncompatibleMods, type ValidationRuntimePorts, verifyModRuntime } from './validation-runtime.ts'

let h: Harness
let ports: ValidationRuntimePorts
const cdn = new Cdn()
const plan: ModValidationPlanJson = {
  gameVersion: '26.3',
  loader: 'fabric',
  loaderVersion: '0.19.5',
  settings: defaultSettings({ name: 'Check', gameMode: 'survival', maxPlayers: 1 }),
  mods: [],
  compat: [],
  files: [],
  modpack: null,
  memoryTier: '3g',
  storageGb: 5,
  provider: 'fake',
  regionKey: 'local',
}
const check = async (candidate = plan, selected = ports) => {
  const id = randomUUID()
  try {
    return await verifyModRuntime(selected, candidate, id, async () => {})
  } finally {
    await h.runtime.destroy(runtimeKey(id))
  }
}

describe.skipIf(!hasDatabase)('isolated runtime proof', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    ports = {
      db: h.db,
      runtime: new RuntimeRouter([h.runtime]),
      logs: h.minecraft,
      probe: h.minecraft,
      links: {
        forServer: () => (artifact) => {
          if (artifact.ref.kind !== 'remote') throw new Error('The fixture is a published file')
          return artifact.ref.url
        },
      },
      timeouts: { runningMs: 1000, readyMs: 1000 },
    }
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('successful proof identifies the exact installed bytes and retains the isolated handle', exactProof)
  test(
    'native loader refusals are incompatibilities while provider startup errors remain retryable',
    startupRefusal,
  )
  test('pack proof requires its retained manifest and exact installed hashes', packProof)

  test('the whole check deadline covers a provider that never returns', provisionDeadline)
  test('a late provider return without a handle callback is still cleaned', lateReturn)
  test('an unfinished game waits for readiness and rejects stopped provider states', pendingReadiness)
  test('successful checks remove their abort listener', listenerCleanup)
  test('intact plugin bytes rejected by the loader establish incompatibility', refusedPlugin)

  test('a ready game is accepted before reading a stale provider observation', readyFirst)

  test(
    'a provider booting the wrong release or an unidentified loader cannot establish a mod conflict',
    wrongIdentity,
  )

  test('every mod loader needs its own identity in the provider’s boot output', unidentifiedLoaders)

  test('a ready message without a game identity cannot verify a configuration', missingIdentity)

  test('a jar installed under an unexpected filename is an installation failure', wrongInstallation)
  test(
    'a plugin download with the wrong bytes cannot become a permanent incompatibility verdict',
    corruptPlugin,
  )

  test('resource failures and a stopped check never establish a mod conflict', resourceFailures)

  test('an unresponsive game expires while waiting for readiness', readinessDeadline)

  test('a provider handle delivered after expiry is destroyed before it can be retained', lateProvision)
})

async function readyFirst() {
  const observation = spyOn(h.runtime, 'observe').mockRejectedValue(new Error('Provider unavailable'))
  try {
    const pending = check()
    await expect(pending).resolves.toHaveProperty('log')
    expect((await pending).log.some((line) => line.includes('Done'))).toBe(true)
  } finally {
    observation.mockRestore()
  }
}

async function wrongIdentity() {
  const provision = h.runtime.ensureProvisioned.bind(h.runtime)
  const replacements: Array<Record<string, string>> = [{ VERSION: '26.2' }, { TYPE: 'VANILLA' }]
  for (const replacement of replacements) {
    const wrong = spyOn(h.runtime, 'ensureProvisioned').mockImplementation((id, placement, spec, progress) =>
      provision(id, placement, { ...spec, env: { ...spec.env, ...replacement } }, progress),
    )
    try {
      const error = await check().catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(IncompatibleMods)
      expect((error as Error).message).toContain(
        'VERSION' in replacement ? '26.2' : 'could not identify the mod loader',
      )
    } finally {
      wrong.mockRestore()
    }
  }
}

async function missingIdentity() {
  const recent = h.minecraft.recent.bind(h.minecraft)
  const hidden = spyOn(h.minecraft, 'recent').mockImplementation(async (handle, limit) =>
    (await recent(handle, limit)).filter((line) => line.text.includes('Done')),
  )
  try {
    await expect(check()).rejects.toThrow('could not identify the Minecraft version')
  } finally {
    hidden.mockRestore()
  }
}

async function wrongInstallation() {
  // This adapter deliberately returns the original CDN basename, rather than the signed route's
  // content-addressed disk name. The actual installed files must expose that mismatch.
  await expect(check({ ...plan, mods: [cdn.publish('wrong-install-name')] })).rejects.toThrow(
    'did not install the expected files',
  )
}

async function resourceFailures() {
  for (const reason of [
    'java.lang.OutOfMemoryError: Java heap space',
    'Failed to load world data',
    'An unrecognized startup failure',
  ]) {
    h.minecraft.breakOn(() => reason)
    try {
      const result = await check().catch((error: unknown) => error)
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(IncompatibleMods)
    } finally {
      h.minecraft.breakOn(() => null)
    }
  }
}

async function readinessDeadline() {
  h.minecraft.stallOn(() => true)
  try {
    await expect(check(plan, { ...ports, timeouts: { runningMs: 30, readyMs: 30 } })).rejects.toThrow()
  } finally {
    h.minecraft.stallOn(() => false)
  }
}

async function lateProvision() {
  const provision = h.runtime.ensureProvisioned.bind(h.runtime)
  let late: Promise<unknown> | undefined
  let id: string | undefined
  const delayed = spyOn(h.runtime, 'ensureProvisioned').mockImplementation(
    (key, placement, spec, progress) => {
      id = key
      late = new Promise((resolve) => setTimeout(resolve, 80)).then(() =>
        provision(key, placement, spec, progress),
      )
      return late as ReturnType<typeof provision>
    },
  )
  try {
    await expect(check(plan, { ...ports, timeouts: { runningMs: 10, readyMs: 10 } })).rejects.toThrow()
    await expect(late).rejects.toThrow()
    expect(h.runtime.machine(id ?? '')).toBeNull()
  } finally {
    delayed.mockRestore()
  }
}

async function corruptPlugin() {
  const bytes = Buffer.from('a truncated plugin download')
  const mod = cdn.publish('corrupt-plugin', bytes)
  const artifact = { ...mod.artifact, sha512: 'b'.repeat(128) }
  const path = `/checked/${diskName(artifact)}`
  cdn.files.set(path, bytes)
  const wrong = {
    ...mod,
    artifact: { ...artifact, ref: { kind: 'remote' as const, url: `${cdn.url}${path}` } },
  }
  const result = await check({ ...plan, loader: 'paper', loaderVersion: null, mods: [wrong] }).catch(
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(Error)
  expect(result).not.toBeInstanceOf(IncompatibleMods)
  expect((result as Error).message).toContain('did not install the expected files')
}

async function exactProof() {
  const mod = cdn.publish('exact-proof')
  const bytes = cdn.files.get(
    new URL(mod.artifact.ref.kind === 'remote' ? mod.artifact.ref.url : '').pathname,
  )
  if (bytes === undefined) throw new Error('Missing fixture bytes')
  const path = `/proof/${diskName(mod.artifact)}`
  cdn.files.set(path, bytes)
  mod.artifact.ref = { kind: 'remote', url: `${cdn.url}${path}` }
  const id = randomUUID()
  const handles: string[] = []
  try {
    const pending = verifyModRuntime(ports, { ...plan, mods: [mod] }, id, async (handle) => {
      handles.push(handle)
    })
    await expect(pending).resolves.toHaveProperty('installed')
    const proof = await pending
    const machine = h.runtime.machine(id)
    expect(machine).not.toBeNull()
    expect(proof.image).toBe(machine?.spec.image ?? '')
    expect(proof.log.some((line) => line.startsWith('[init]'))).toBe(false)
    expect(proof.installed).toEqual([mod.artifact.sha512])
    expect(proof.log.some((line) => line.includes('Done'))).toBe(true)
    expect(handles.length).toBeGreaterThan(0)
    expect(new Set(handles).size).toBe(1)
    expect(machine?.spec.labels['blockly.purpose']).toBe('mod-validation')
    expect(machine?.spec.secrets.RCON_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(
      machine?.spec.ports.every((port) => port.audience.every((audience) => audience === 'control')),
    ).toBe(true)
  } finally {
    await h.runtime.destroy(runtimeKey(id))
  }
}

async function startupRefusal() {
  h.minecraft.breakOn(
    () => "Mod 'Waystones' (waystones) 21.1.25 requires any version of balm, which is missing!",
  )
  try {
    await expect(check()).rejects.toBeInstanceOf(IncompatibleMods)
  } finally {
    h.minecraft.breakOn(() => null)
  }
  const running = spyOn(ports.runtime, 'waitRunning').mockRejectedValue(new Error('Provider start failed'))
  try {
    await expect(check()).rejects.toThrow('Provider start failed')
  } finally {
    running.mockRestore()
  }
}

async function packProof() {
  const body = jar('pack-library')
  const contents = zipBytes({
    'modrinth.index.json': utf8(
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        versionId: '1',
        name: 'Proof pack',
        files: [],
        dependencies: { minecraft: plan.gameVersion, 'fabric-loader': plan.loaderVersion },
      }),
    ),
    'overrides/mods/library.jar': body,
  })
  const published = cdn.publish('proof-pack', Buffer.from(contents))
  const pack = {
    catalog: 'modrinth',
    projectId: 'proof-pack',
    versionId: '1',
    name: 'Proof pack',
    versionLabel: '1',
    artifact: published.artifact,
    page: null,
  }
  const candidate = { ...plan, loaderVersion: '0.19.4', modpack: pack }
  await savePackContents(h.db, {
    sha512: pack.artifact.sha512,
    name: pack.name,
    versionLabel: '1',
    gameVersion: plan.gameVersion,
    loader: plan.loader,
    loaderVersion: plan.loaderVersion,
    playersNeedIt: true,
    jars: [{ path: 'mods/library.jar', sha512: sha512(body), sizeBytes: body.length }],
    otherJars: [],
    leftOut: [],
    memoryMb: null,
  })
  await expect(check(candidate)).resolves.toMatchObject({ installed: [pack.artifact.sha512] })
  await h.db
    .update(schema.packContents)
    .set({ jars: [{ path: 'mods/library.jar', sha512: 'a'.repeat(128), sizeBytes: body.length }] })
    .where(eq(schema.packContents.sha512, pack.artifact.sha512))
  await expect(check(candidate)).rejects.toThrow('did not install the expected files')
  await h.db
    .update(schema.packContents)
    .set({ jars: [{ path: 'mods/absent.jar', sha512: sha512(body), sizeBytes: body.length }] })
    .where(eq(schema.packContents.sha512, pack.artifact.sha512))
  await expect(check(candidate)).rejects.toThrow('mods/absent.jar')
  await h.db
    .update(schema.packContents)
    .set({ jars: [] })
    .where(eq(schema.packContents.sha512, pack.artifact.sha512))
  await expect(check(candidate)).resolves.toHaveProperty('installed')
  await h.db.delete(schema.packContents).where(eq(schema.packContents.sha512, pack.artifact.sha512))
  await expect(check(candidate)).rejects.toThrow('manifest is unavailable')
}

async function provisionDeadline() {
  const provision = spyOn(ports.runtime, 'ensureProvisioned').mockImplementation(() => new Promise(() => {}))
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = check(plan, { ...ports, timeouts: { runningMs: 10, readyMs: 10 } }).then(
      () => 'completed',
      () => 'expired',
    )
    const limit = new Promise<string>((resolve) => {
      guard = setTimeout(() => resolve('missing deadline'), 300)
    })
    expect(await Promise.race([outcome, limit])).toBe('expired')
  } finally {
    clearTimeout(guard)
    provision.mockRestore()
  }
}

async function lateReturn() {
  const provision = h.runtime.ensureProvisioned.bind(h.runtime)
  let returned: Promise<unknown> | undefined
  let id = ''
  const delayed = spyOn(h.runtime, 'ensureProvisioned').mockImplementation((key, placement, spec) => {
    id = key
    returned = new Promise((resolve) => setTimeout(resolve, 80)).then(() =>
      provision(key, placement, spec, { handle: async () => {}, step: async () => {} }),
    )
    return returned as ReturnType<typeof provision>
  })
  try {
    await expect(check(plan, { ...ports, timeouts: { runningMs: 10, readyMs: 10 } })).rejects.toThrow()
    await returned
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.runtime.machine(id)).toBeNull()
  } finally {
    delayed.mockRestore()
    await h.runtime.destroy(runtimeKey(id))
  }
}

async function pendingReadiness() {
  const observe = ports.runtime.observe.bind(ports.runtime)
  h.minecraft.stallOn(() => true)
  for (const state of ['crashed', 'stopped', 'absent'] as const) {
    const stopped = spyOn(ports.runtime, 'observe').mockImplementation(async (handle) => ({
      ...(await observe(handle)),
      state,
    }))
    try {
      await expect(check()).rejects.toThrow('stopped before its result could be read')
    } finally {
      stopped.mockRestore()
    }
  }
  h.minecraft.stallOn(() => false)
  h.minecraft.bootTakes(20)
  const endpoint = spyOn(ports.runtime, 'endpoint')
  const ping = spyOn(ports.probe, 'ping')
  try {
    await expect(
      check(plan, { ...ports, timeouts: { runningMs: 2000, readyMs: 2000 } }),
    ).resolves.toHaveProperty('installed')
    expect(endpoint.mock.calls[0]?.slice(1)).toEqual([PORT_NAMES.game, 'control'])
    expect(ping.mock.calls[0]?.[0]).toMatchObject({ proxyProtocol: false })
  } finally {
    h.minecraft.bootTakes(0)
    h.minecraft.stallOn(() => false)
    endpoint.mockRestore()
    ping.mockRestore()
  }
}

async function listenerCleanup() {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const signals: AbortSignal[] = []
  const observed = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const signal = timeout(ms)
    signals.push(signal)
    return signal
  })
  try {
    await expect(check()).resolves.toHaveProperty('installed')
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => getEventListeners(signal, 'abort').length === 0)).toBe(true)
  } finally {
    observed.mockRestore()
  }
}

async function refusedPlugin() {
  const body = Buffer.from('intact but invalid plugin')
  const mod = cdn.publish('refused-plugin', body)
  const path = `/proof/${diskName(mod.artifact)}`
  cdn.files.set(path, body)
  mod.artifact.ref = { kind: 'remote', url: `${cdn.url}${path}` }
  const result = await check({ ...plan, loader: 'paper', loaderVersion: null, mods: [mod] }).catch(
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(IncompatibleMods)
  expect((result as Error).message).toContain('refused-plugin')
}

async function unidentifiedLoaders() {
  const provision = h.runtime.ensureProvisioned.bind(h.runtime)
  const wrong = spyOn(h.runtime, 'ensureProvisioned').mockImplementation((id, placement, spec, progress) =>
    provision(id, placement, { ...spec, env: { ...spec.env, TYPE: 'VANILLA' } }, progress),
  )
  try {
    for (const loader of ['fabric', 'quilt', 'forge', 'neoforge'] as const) {
      const result = await check({ ...plan, loader }).catch((error: unknown) => error)
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(IncompatibleMods)
      expect((result as Error).message).toContain('could not identify the mod loader')
    }
  } finally {
    wrong.mockRestore()
  }
}
