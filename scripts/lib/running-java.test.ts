// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The verdict on a machine's Java, from this machine's own pgrep reading processes started in the
 * shapes a server's machine has: Java under the runner with its heap, and #559's patch run, Java
 * with no options under the cache script's shell. The runner and Java are this machine's `sh`,
 * copied under their names, so pgrep lists them as it lists the image's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { until } from '@blockly/contracts/waits'
import { javaWrong, runnerIn } from './running-java.ts'

let bin = ''
const started: ReturnType<typeof Bun.spawn>[] = []
const tag = `blockly-java-${process.pid}`

/** pgrep as `fly machine exec` runs it: the command split on spaces, no shell. */
const pgrep = (command: string) =>
  Bun.spawnSync(command.split(' '))
    .stdout.toString()
    .split('\n')
    .filter((line) => line.includes(tag) || /^\d+$/.test(line))
    .join('\n')

/** One start, by the shell that would run it; answers when both processes are up. */
async function start(script: string): Promise<void> {
  const shell = Bun.spawn(['sh', '-c', script], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  started.push(shell)
  await until('its processes', () => pgrep(`pgrep -a -f ${tag}`).split('\n').filter(Boolean).length >= 2)
}

const listing = () => pgrep('pgrep -a -f java|mc-server-runner')
const childrenOf = (text: string) => {
  const runner = runnerIn(text)
  return runner === undefined ? '' : pgrep(`pgrep -P ${runner.pid}`)
}

describe('the Java on a machine', () => {
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'blockly-java-'))
    copyFileSync('/bin/sh', join(bin, 'mc-server-runner'))
    copyFileSync('/bin/sh', join(bin, 'java'))
  })
  afterAll(() => {
    for (const shell of started) shell.kill()
    Bun.spawnSync(['pkill', '-f', tag])
    if (bin) rmSync(bin, { recursive: true, force: true })
  })

  test('under the runner with the spec’s heap is right, and another heap is not', async () => {
    await start(
      `exec mc-server-runner -c 'java -c "read x; :" ${tag} -Xms1024M -Xmx2048M -jar server.jar nogui; :'`,
    )
    const text = listing()
    expect(javaWrong(text, childrenOf(text), '2048M')).toBeNull()
    expect(javaWrong(text, childrenOf(text), '3072M')).toContain('without -Xmx3072M')
    for (const shell of started.splice(0)) shell.kill()
    Bun.spawnSync(['pkill', '-f', tag])
  })

  test('#559’s patch run, Java with no options under the cache script, is wrong', async () => {
    await start(`java -c "read x; :" ${tag} -Dpaperclip.patchonly=true -jar server.jar; :`)
    const text = listing()
    expect(javaWrong(text, childrenOf(text), '2048M')).toContain('no mc-server-runner on the machine')
  })
})
