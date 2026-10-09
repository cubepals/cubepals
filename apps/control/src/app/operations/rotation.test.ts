import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ArtifactForbidden } from '../artifacts/service.ts'
import { deriveServerSecret } from '../secrets.ts'
import { loadRuntime } from '../servers/persistence.ts'

const FIRST = 'rotation-test-key-version-one'
const SECOND = 'rotation-test-key-version-two'

// A rotation as an operator runs one (docs/configuration.md, "Rotating the runtime key"): a new
// key and version, the old key still accepted, every running server moved over at its next apply,
// then the old key removed. The test holds the keyring the control plane reads, and changes it in
// place as a new deployment would.
describe.skipIf(!hasDatabase)('runtime key rotation', () => {
  const ring: { current: { version: number; key: string }; previous: { version: number; key: string }[] } = {
    current: { version: 1, key: FIRST },
    previous: [],
  }
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ runtimeSecrets: ring })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a server answers on its old key until drift moves it onto the new one, and the old key can go', async () => {
    const owner = await h.user()
    const admin = { kind: 'admin' as const, userId: (await h.user('Operator')).userId }
    const { id } = await h.create(owner, { name: 'Rotated' })
    await h.until(id, 'running')
    await h.settled(id)
    const keys = async () => (await h.app.platform.view(admin)).runtimeKeys
    expect(await keys()).toEqual({ version: 1, previousVersions: [], behind: 0 })
    const booted = h.runtime.machine(id)?.spec
    expect(booted?.secrets.RCON_PASSWORD).toBe(deriveServerSecret(FIRST, id, 'rcon'))
    expect(booted?.labels['blockly.secrets-version']).toBe('1')

    // The new key goes in; the old one is still accepted.
    ring.current = { version: 2, key: SECOND }
    ring.previous = [{ version: 1, key: FIRST }]
    expect(await keys()).toEqual({ version: 2, previousVersions: [1], behind: 1 })
    // The server still has the old key's password, and its console still answers.
    await h.app.console.run(owner, id, 'list')
    // A jar link signed with the old key is still honored; one signed with neither is not.
    const artifacts = h.app.artifacts
    await expect(
      artifacts.locate(id, 'f'.repeat(128), deriveServerSecret(FIRST, id, 'artifacts')),
    ).rejects.not.toBeInstanceOf(ArtifactForbidden)
    await expect(
      artifacts.locate(id, 'f'.repeat(128), deriveServerSecret('some-other-deployment-key', id, 'artifacts')),
    ).rejects.toBeInstanceOf(ArtifactForbidden)

    // Nobody is playing, so drift applies the change the new key version made to its spec.
    const before = await h.server(id)
    expect(await h.app.schedules.drift()).toBe(1)
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1)
    await h.settled(id)
    const moved = h.runtime.machine(id)?.spec
    expect(moved?.secrets.RCON_PASSWORD).toBe(deriveServerSecret(SECOND, id, 'rcon'))
    expect(moved?.labels['blockly.secrets-version']).toBe('2')
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.secretsVersion).toBe(2)
    expect(await keys()).toEqual({ version: 2, previousVersions: [1], behind: 0 })

    // Nothing runs on the old key: it goes, and the console answers on the new one alone.
    ring.previous = []
    await h.app.console.run(owner, id, 'list')
    await expect(
      artifacts.locate(id, 'f'.repeat(128), deriveServerSecret(FIRST, id, 'artifacts')),
    ).rejects.toBeInstanceOf(ArtifactForbidden)
  }, 60_000)
})
