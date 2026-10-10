// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import Docker from 'dockerode'
import { DockerLogSource } from './docker-logs.ts'
import { encodeHandle } from './handle.ts'

// Real containers, wherever a Docker socket is: every laptop running the local stack, and CI.
const SOCKET = '/var/run/docker.sock'
const IMAGE = 'alpine:3.22'
// Each run names itself, prints three lines, then idles.
const SCRIPT =
  'run=$(cut -c1-8 /proc/sys/kernel/random/uuid); for i in 1 2 3; do echo "$run $i"; done; exec sleep 300'

describe.skipIf(!existsSync(SOCKET))('Docker logs', () => {
  const docker = new Docker({ socketPath: SOCKET })
  const logs = new DockerLogSource(SOCKET)
  const created: Docker.Container[] = []

  beforeAll(async () => {
    const present = await docker
      .getImage(IMAGE)
      .inspect()
      .then(
        () => true,
        () => false,
      )
    if (present) return
    const stream = await docker.pull(IMAGE)
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))),
    )
  }, 120_000)

  afterAll(async () => {
    for (const container of created) await container.remove({ force: true }).catch(() => {})
  })

  async function container() {
    const made = await docker.createContainer({
      Image: IMAGE,
      Cmd: ['sh', '-c', SCRIPT],
      Labels: { 'blockly.test': 'docker-logs' },
      StopTimeout: 1,
    })
    created.push(made)
    const handle = encodeHandle({
      deployment: 'test',
      serverId: 's-1',
      container: made.id,
      volume: 'v',
      ports: {},
    })
    return { made, handle }
  }

  // Well inside each test's own budget: a busy machine running the whole suite takes its time
  // to start a container and attach to its log stream.
  async function until(done: () => boolean, what: string) {
    for (let i = 0; i < 600 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    if (!done()) throw new Error(`Timed out waiting for ${what}`)
  }

  test('a tail follows its container through a restart, from the first line of each run', async () => {
    const { made, handle } = await container()
    const controller = new AbortController()
    const seen: string[] = []
    const reading = (async () => {
      for await (const line of logs.tail(handle, controller.signal)) seen.push(line.text)
      return 'ended'
    })()

    // Watched before it ever started, as a console opened on a stopped server is.
    await made.start()
    await until(() => seen.length >= 3, 'the first run')
    await made.restart({ t: 1 })
    await until(() => seen.length >= 6, 'the second run')

    const [first, second] = [...new Set(seen.map((text) => text.split(' ')[0]))]
    expect(first).not.toBe(second)
    expect(seen).toEqual([
      `${first} 1`,
      `${first} 2`,
      `${first} 3`,
      `${second} 1`,
      `${second} 2`,
      `${second} 3`,
    ])

    controller.abort()
    expect(await reading).toBe('ended')
  }, 60_000)

  test('a tail ends when its container is gone', async () => {
    const { made, handle } = await container()
    await made.start()
    const seen: string[] = []
    const reading = (async () => {
      for await (const line of logs.tail(handle, new AbortController().signal)) seen.push(line.text)
      return 'ended'
    })()
    await until(() => seen.length >= 3, 'the run')
    await made.remove({ force: true })
    expect(await reading).toBe('ended')
  }, 60_000)

  test('recent reads the last lines', async () => {
    const { made, handle } = await container()
    await made.start()
    let lines: string[] = []
    for (let i = 0; i < 100 && lines.length < 3; i++) {
      lines = (await logs.recent(handle, 3)).map((line) => line.text.split(' ')[1] ?? '')
      if (lines.length < 3) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(lines).toEqual(['1', '2', '3'])
    expect((await logs.recent(handle, 2)).map((line) => line.text.split(' ')[1])).toEqual(['2', '3'])
  }, 60_000)
})
