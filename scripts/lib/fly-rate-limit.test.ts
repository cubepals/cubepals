// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The flyctl runner's retries (`fly-rate-limit.ts`), against a `fly` of the test's own that answers
 * as Fly's API did when it turned staging's start away.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FLY_RATE_LIMITED,
  FLY_STREAM_DROPPED,
  flyAsync,
  flySync,
  RATE_LIMIT_WAITS_MS,
} from './fly-rate-limit.ts'

/** flyctl's answer when Fly's API turned a machine start away, as staging's start was told. */
const REFUSED =
  'Error: could not get machine 28655e32c92e48: failed to get VM 28655e32c92e48: resource_exhausted: rate limit exceeded (Request ID: 01M6K5MZBYC5KGSX12M2TCW54Z-ord)'

let dir = ''
const path = process.env.PATH
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fly-rate-limit-'))
})
afterEach(() => {
  process.env.PATH = path
  rmSync(dir, { recursive: true, force: true })
})

/** flyctl's answer when Fly's API dropped the connection as a nightly listed staging's addresses. */
const DROPPED =
  'Error: failed to list app ip assignments: Get "https://api.machines.dev/v1/apps/an-app/ip_assignments": stream error: stream ID 1; INTERNAL_ERROR; received from peer'

/** A `fly` first on PATH, answering `refused` `refusals` times; then it fails with `other`, or echoes its arguments. */
function fakeFly(refusals: number, other?: string, refused = REFUSED): void {
  writeFileSync(join(dir, 'tries'), '0')
  writeFileSync(
    join(dir, 'fly'),
    [
      '#!/bin/sh',
      `n=$(cat "${dir}/tries"); echo $((n + 1)) > "${dir}/tries"`,
      `if [ "$n" -lt ${refusals} ]; then echo '${refused}' >&2; exit 1; fi`,
      other === undefined ? 'echo "ok $*"' : `echo '${other}' >&2; exit 1`,
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'fly'), 0o755)
  process.env.PATH = `${dir}:${path}`
}
const tries = () => Number(readFileSync(join(dir, 'tries'), 'utf8'))

test("the answer staging's start was given is a rate limit", () => {
  expect(FLY_RATE_LIMITED.test(REFUSED)).toBe(true)
})

test('a request turned away for the rate limit is tried again until it goes through', () => {
  fakeFly(2)
  const waited: number[] = []
  const run = flySync(['machine', 'start', 'm1'], undefined, (ms) => waited.push(ms))
  expect(run).toEqual({ exitCode: 0, stdout: 'ok machine start m1\n', stderr: '' })
  expect(tries()).toBe(3)
  expect(waited).toEqual(RATE_LIMIT_WAITS_MS.slice(0, 2))
})

test('one still turned away after every wait gives back the refusal', () => {
  fakeFly(99)
  const waited: number[] = []
  const run = flySync(['machine', 'start', 'm1'], undefined, (ms) => waited.push(ms))
  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain('rate limit exceeded')
  expect(tries()).toBe(RATE_LIMIT_WAITS_MS.length + 1)
  expect(waited).toEqual(RATE_LIMIT_WAITS_MS)
})

test('any other failure comes back at once', () => {
  fakeFly(0, 'Error: app not found')
  const waited: number[] = []
  const run = flySync(['status', '-a', 'nope'], undefined, (ms) => waited.push(ms))
  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain('app not found')
  expect(tries()).toBe(1)
  expect(waited).toEqual([])
})

test('the async runner tries again after the rate limit too', async () => {
  fakeFly(1)
  const waited: number[] = []
  const run = await flyAsync(['ips', 'list'], async (ms) => {
    waited.push(ms)
  })
  expect(run).toEqual({ exitCode: 0, stdout: 'ok ips list\n', stderr: '' })
  expect(tries()).toBe(2)
  expect(waited).toEqual(RATE_LIMIT_WAITS_MS.slice(0, 1))
})

test("the answer a nightly's list was given is a dropped connection", () => {
  expect(FLY_STREAM_DROPPED.test(DROPPED)).toBe(true)
  expect(FLY_RATE_LIMITED.test(DROPPED)).toBe(false)
})

test('a read whose answer was dropped is asked again until it comes', async () => {
  fakeFly(2, undefined, DROPPED)
  const waited: number[] = []
  const run = flySync(['ips', 'list', '-a', 'an-app', '--json'], undefined, (ms) => waited.push(ms))
  expect(run).toEqual({ exitCode: 0, stdout: 'ok ips list -a an-app --json\n', stderr: '' })
  expect(tries()).toBe(3)
  expect(waited).toEqual(RATE_LIMIT_WAITS_MS.slice(0, 2))
  fakeFly(1, undefined, DROPPED)
  expect((await flyAsync(['status', '-a', 'an-app'], async () => {})).exitCode).toBe(0)
  expect(tries()).toBe(2)
})

test('a change whose answer was dropped is not made twice', async () => {
  for (const args of [
    ['machine', 'start', 'm1'],
    ['ips', 'allocate-v6', '-a', 'an-app'],
    ['deploy', '-a', 'list'],
  ]) {
    fakeFly(1, undefined, DROPPED)
    const run = flySync(args, undefined, () => {})
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('INTERNAL_ERROR')
    expect(tries()).toBe(1)
    fakeFly(1, undefined, DROPPED)
    expect((await flyAsync(args, async () => {})).exitCode).toBe(1)
    expect(tries()).toBe(1)
  }
})
