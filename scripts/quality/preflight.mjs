// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Reject missing tooling or unavailable test services before running an expensive test census. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { requireQuality } from './toolchain.mjs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const expected = manifest.packageManager?.replace(/^bun@/, '')
const actual = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()
if (actual !== expected) throw new Error('The test runner does not match the pinned Bun version')
requireQuality.resolve('happy-dom')
const services =
  process.env.QUALITY_SERVICES === 'false'
    ? []
    : [
        ['DATABASE_URL', 5432],
        ['NATS_TEST_URL', 4222],
        ['S3_TEST_ENDPOINT', 9000],
        ['PEBBLE_TEST_URL', 14000],
        ['CHALLTESTSRV_TEST_URL', 8055],
      ]
const reachable = (host, port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (ready) => {
      socket.destroy()
      resolve(ready)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(SECOND_MS, () => finish(false))
  })
await Promise.all(
  services.map(async ([name, fallback]) => {
    if (!process.env[name]) throw new Error(`Required test service is not configured: ${name}`)
    const url = new URL(process.env[name])
    const began = Date.now()
    while (!(await reachable(url.hostname, Number(url.port || fallback)))) {
      if (Date.now() - began >= 30 * SECOND_MS) throw new Error(`Test service did not become ready: ${name}`)
      await setTimeout(100)
    }
    console.warn(`${name}: ready`)
  }),
)
console.warn(
  `Preflight passed: Node ${process.versions.node}, Bun ${actual}, isolated quality tools and all test services`,
)
