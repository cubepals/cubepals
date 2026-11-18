// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { RuntimeSpec } from '../../../app/ports/runtime.ts'
import { gameContainer } from './game-container.ts'

describe('a game container', () => {
  const spec: RuntimeSpec = {
    image: 'itzg/minecraft-server:2026.9.1-java25',
    env: { EULA: 'TRUE' },
    secrets: {},
    resources: { memoryMb: 3072 },
    storage: { mountPath: '/data', sizeGb: 3 },
    ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge', 'control'] }],
    stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
    labels: {},
  }
  const ref = {
    deployment: 'test',
    serverId: 'server',
    container: 'blockly-server',
    volume: 'blockly-server-data',
    ports: { game: { container: 25565, host: 30000 } },
  }

  // The image's mc-health runs as root and sources /data/.mc-health.env, which a mod can write.
  test('never runs the image’s own health check', () => {
    expect(gameContainer(ref, spec, 'test', 'blockly').Healthcheck).toEqual({ Test: ['NONE'] })
  })
})
