// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Boat probe against Boat's own answers to its command, recorded on staging: a Paper server's
 * status ping says "Paper 1.21.11", with a space, and a workload not running yet answers nothing.
 */

import { describe, expect, test } from 'bun:test'
import { BoatProbe } from './boat-minecraft.ts'
import { BoatRuntime } from './boat-runtime.ts'
import { boatClient } from './client.ts'
import { BoatStarts } from './starts.ts'

/** Boat's own answers to the probe's command, recorded on staging (fixtures/). */
const recorded = (name: string) => Bun.file(new URL(`./fixtures/${name}.json`, import.meta.url)).text()

/** A runtime whose every command Boat answers with `answer`; what it was asked is kept. */
function answering(answer: string) {
  const asked: string[] = []
  const client = boatClient('boat_p_test', {
    baseUrl: 'https://boat.test/api/v1',
    fetch: async (request) => {
      asked.push(((await request.json()) as { command: string }).command)
      return new Response(answer, { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const pause = async () => {}
  const runtime = new BoatRuntime({
    client,
    deploymentId: 'test',
    starts: new BoatStarts(client, { pause }),
    runTtlSeconds: null,
    pause,
  })
  return { probe: new BoatProbe(runtime), asked }
}

const endpoint = { host: 'bx_q7w2k9xz', port: 25565 }

describe('BoatProbe', () => {
  test('hears a Paper server, whose version has a space in it', async () => {
    const { probe, asked } = answering(await recorded('command-status-paper'))
    expect(await probe.ping(endpoint, AbortSignal.timeout(1000))).toEqual({
      version: 'Paper 1.21.11',
      online: 0,
      max: 5,
    })
    expect(asked).toEqual([
      "docker exec blockly-workload 'mc-monitor' 'status' '--host' 'localhost' '--port' '25565'",
    ])
  })

  test('a workload that isn’t running has not answered', async () => {
    const { probe } = answering(await recorded('command-status-not-running'))
    await expect(probe.ping(endpoint, AbortSignal.timeout(1000))).rejects.toThrow(
      /^No answer to a status ping/,
    )
  })

  test('an answer it can’t read says so, rather than that nothing answered', async () => {
    const { probe } = answering(
      JSON.stringify({
        success: true,
        exitCode: 0,
        stdout: 'localhost:25565 : online',
        stderr: '',
        timedOut: false,
      }),
    )
    await expect(probe.ping(endpoint, AbortSignal.timeout(1000))).rejects.toThrow(/couldn't be read/)
  })
})
