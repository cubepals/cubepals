// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A console opened after startup follows new output from an already running container. */
import { expect, test } from 'bun:test'
import Docker from 'dockerode'
import { DockerLogSource } from './docker-logs.ts'
import { encodeHandle } from './handle.ts'

test('a tail opened on a running container reads new lines until cancelled', async () => {
  const docker = new Docker({ socketPath: '/var/run/docker.sock' })
  const made = await docker.createContainer({
    Image: 'alpine:3.22',
    Cmd: ['sh', '-c', 'while :; do echo following; sleep 0.1; done'],
    Labels: { 'blockly.test': 'docker-logs-running' },
    StopTimeout: 1,
  })
  const controller = new AbortController()
  try {
    await made.start()
    expect((await made.inspect()).State.Running).toBe(true)
    const handle = encodeHandle({
      deployment: 'test',
      serverId: 's-1',
      container: made.id,
      volume: 'v',
      ports: {},
    })
    const lines: string[] = []
    for await (const line of new DockerLogSource('/var/run/docker.sock').tail(handle, controller.signal)) {
      expect(Number.isNaN(line.at.getTime())).toBe(false)
      lines.push(line.text)
      if (lines.length === 2) controller.abort()
    }
    expect(lines).toEqual(['following', 'following'])
  } finally {
    controller.abort()
    await made.remove({ force: true })
  }
}, 60_000)
