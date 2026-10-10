// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A sandbox still bringing its workload back after a resume answers "wait", and is asked again;
 * one Boat never saved is told it has nothing to wait for. Boat here answers each command with
 * the next line given, and keeps the commands it was sent.
 */
import { describe, expect, test } from 'bun:test'
import { boatClient, type Sandbox } from '../client.ts'
import { neverSaved, SandboxCommands } from './commands.ts'

function boatSaying(...lines: string[]) {
  const sent: string[] = []
  const fetch = async (request: Request) => {
    const body = (await request.json()) as { command: string }
    sent.push(body.command)
    return Response.json({ exitCode: 0, stdout: lines.shift() ?? 'ok', stderr: '' })
  }
  const commands = new SandboxCommands(
    boatClient('boat_p_test', { baseUrl: 'https://boat.test/api/v1', fetch }),
    async () => {},
  )
  return { commands, sent }
}

const WAIT = 'wait the sandbox is still bringing its workload back'

describe('a verb on a sandbox still bringing its workload back', () => {
  test('is asked again at once while it answers "wait", until it is back', async () => {
    const { commands, sent } = boatSaying(WAIT, WAIT, 'ok running')
    expect(await commands.run('bx_1', 'up', ['25565'])).toBe('running')
    expect(sent).toHaveLength(3)
  })

  test('fails with what it said once it has waited longer than the program ever does', async () => {
    const { commands, sent } = boatSaying(...Array.from({ length: 20 }, () => WAIT))
    await expect(commands.run('bx_1', 'up', ['25565'])).rejects.toThrow(
      "The sandbox couldn't up: the sandbox is still bringing its workload back",
    )
    expect(sent).toHaveLength(7)
  })

  test('is told the sandbox is new only when asked to, and then never waits', async () => {
    const { commands, sent } = boatSaying('ok stopped', 'ok stopped')
    await commands.run('bx_1', 'stop', [], 180, true)
    await commands.run('bx_1', 'stop')
    expect(sent[0]).toStartWith("bash -c 'BLOCKLY_NEW=1")
    expect(sent[1]).not.toContain('BLOCKLY_NEW=1')
  })
})

describe('a sandbox Boat never saved', () => {
  const sandbox = (snapshotCompletedAt: string | null) =>
    // A fresh sandbox has a snapshot attempted within a minute of going idle, none completed.
    ({ snapshotCompletedAt, lastSnapshotAttemptAt: '2026-10-04T05:52:30Z' }) as Sandbox

  test('is one with no completed snapshot, whatever it attempted', () => {
    expect(neverSaved(sandbox(null))).toBe(true)
    expect(neverSaved(sandbox('2026-10-04T05:52:50Z'))).toBe(false)
  })
})
