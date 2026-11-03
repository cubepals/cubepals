// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A host socket held outside Docker cannot be assigned to a new server. */
import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import type { RuntimeSpec } from '../../../app/ports/runtime.ts'
import { RCON_PORT } from '../../../minecraft/ports.ts'
import { HostPorts } from './host-ports.ts'

const spec: RuntimeSpec = {
  image: 'port-claim-test',
  env: {},
  secrets: {},
  resources: { memoryMb: 64 },
  storage: { mountPath: '/data', sizeGb: 1 },
  ports: [{ name: 'rcon', port: RCON_PORT, protocol: 'tcp', audience: ['control'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 7 },
  labels: {},
}

test('a real occupied host socket is skipped without poisoning later claims', async () => {
  const first = await new HostPorts(async () => []).claim(spec, async (ports) => ports)
  const occupied = first.rcon?.host
  if (occupied === null || occupied === undefined) throw new Error('No control port was allocated')
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(occupied, '127.0.0.1', resolve)
  })
  try {
    const allocator = new HostPorts(async () => [])
    const next = await allocator.claim(spec, async (ports) => ports)
    expect(next.rcon?.host).not.toBe(occupied)
    expect(next.rcon?.host).toBeNumber()
    expect(next.rcon?.container).toBe(RCON_PORT)
    const failure = new Error('Creating the container failed')
    await expect(
      allocator.claim(spec, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    const recovered = await allocator.claim(spec, async (ports) => ports)
    expect(recovered.rcon?.host).not.toBe(occupied)
    expect(recovered.rcon?.container).toBe(RCON_PORT)
    expect(socket.listening).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
  }
})
