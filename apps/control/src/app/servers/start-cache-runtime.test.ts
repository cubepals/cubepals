// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The script that gives a server its Java startup cache, run in a real shell against a folder
 * standing in for the volume, with stand-ins for Java, for the image's runner and for `df` that
 * say how they were called. The runner's writes the recording as Java does, when it exits; Java's
 * writes the cache it is asked to make.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootMilestone, classifyLine } from '../../minecraft/logs.ts'
import { CACHED_RUNNER_LINES, RECORDING } from '../../minecraft/start-cache.ts'

let root = ''
const data = (name: string) => join(root, 'data', name)
const CACHE = '.blockly-remade/start.aot'
const state = () =>
  readFileSync(data(`${CACHE}.state`), 'utf8')
    .trim()
    .split('\n')[1]
const javaCalls = () =>
  existsSync(join(root, 'java.log')) ? readFileSync(join(root, 'java.log'), 'utf8').trim().split('\n') : []
const tool = (name: string, lines: string[]) => {
  writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${lines.join('\n')}\n`)
  chmodSync(join(root, 'bin', name), 0o755)
}

/** `df`, saying the volume has this many kilobytes free. */
const room = (kilobytes: number) =>
  tool('df', [
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
    `echo "disk 3000000 1 ${kilobytes} 1% /data"`,
  ])

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-cache-'))
  for (const dir of ['data', 'bin']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.4"\n')
  writeFileSync(data('server.jar'), 'jar')
  writeFileSync(
    join(root, 'start-cache'),
    `${CACHED_RUNNER_LINES.join('\n').replaceAll('/data', join(root, 'data'))}\n`,
  )
  // The runner says what it ran. Where the server is said to exit, it leaves the recording it was
  // asked for, as Java does on its way out.
  tool('mc-server-runner', [
    'echo "ran: $*"',
    `for word; do case "$word" in -XX:AOTConfiguration=*) if [ -f ${join(root, 'exits')} ]; then echo recorded > "\${word#-XX:AOTConfiguration=}"; fi;; esac; done`,
  ])
  // Java, asked to make a cache: it says with what, and writes one unless it is said to fail.
  tool('java', [
    `echo "$*" >> ${join(root, 'java.log')}`,
    `if [ -f ${join(root, 'java-fails')} ]; then exit 1; fi`,
    'for word; do case "$word" in -XX:AOTCache=*) echo cache > "$(echo "$word" | cut -d= -f2-)";; esac; done',
  ])
  room(2_999_999)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const COMMAND = '--stop-duration 60s -- java -XX:+AlwaysPreTouch -Xmx1996M -jar ./server.jar nogui'
const ran = (options: string) =>
  `ran: --stop-duration 60s -- java ${options}-XX:+AlwaysPreTouch -Xmx1996M -jar ./server.jar nogui`
const recorded = () =>
  ran(`-XX:AOTMode=record -XX:AOTConfiguration=${data(`${CACHE}.conf`)} `).replaceAll(root, '{root}')
const cached = () => ran(`-XX:AOTCache=${data(CACHE)} `).replaceAll(root, '{root}')

/** One start of the server: the script, given the words the runner would have been. */
function start(command = COMMAND, env: Record<string, string> = {}): string[] {
  const result = Bun.spawnSync(['/bin/sh', join(root, 'start-cache'), ...command.split(' ')], {
    cwd: join(root, 'data'),
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      BLOCKLY_START_KEY: 'a'.repeat(64),
      ...env,
    },
  })
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.replaceAll(root, '{root}'))
}
/** A start whose server later exits, as at a stop or a restart. */
function startThenExit(command = COMMAND): string[] {
  writeFileSync(join(root, 'exits'), '')
  try {
    return start(command)
  } finally {
    rmSync(join(root, 'exits'))
  }
}

describe('a server’s Java startup cache', () => {
  test('a start with none records, and says so in the log', () => {
    expect(start()).toEqual([RECORDING, recorded()])
    expect(state()).toBe('recording')
    expect(javaCalls()).toEqual([])
    // A line of setup, not the server's own, and no step of a start's progress.
    expect(classifyLine(RECORDING)?.level).toBe('setup')
    expect(bootMilestone(RECORDING)).toBeNull()
  })

  test('the start after the server exited makes the cache, and starts with it', () => {
    startThenExit()
    const [said, run] = start()
    expect(said).toBe('[init] Making this server a quicker start from its last one')
    expect(run).toBe(cached())
    // Made with the server's own options but the one that touches the whole heap, from its jar.
    expect(javaCalls()).toEqual([
      `-Xmx1996M -XX:AOTMode=create -XX:AOTConfiguration=${data(`${CACHE}.conf`)} -XX:AOTCache=${data(`${CACHE}.new`)} -cp ./server.jar`,
    ])
    expect(state()).toBe('made')
    expect(existsSync(data(`${CACHE}.conf`))).toBe(false)

    // Every start after only reads it.
    expect(start()).toEqual([cached()])
    expect(javaCalls()).toHaveLength(1)
  })

  test('a server that never exited has nothing recorded, and records again', () => {
    start()
    expect(start()).toEqual([RECORDING, recorded()])
    expect(javaCalls()).toEqual([])
  })

  test('a recording that makes no cache isn’t tried again', () => {
    startThenExit()
    writeFileSync(join(root, 'java-fails'), '')
    expect(start()).toEqual(['[init] Making this server a quicker start from its last one', ran('')])
    expect(state()).toBe('failed')
    rmSync(join(root, 'java-fails'))
    expect(startThenExit()).toEqual([ran('')])
    expect(start()).toEqual([ran('')])
    expect(javaCalls()).toHaveLength(1)
    expect(existsSync(data(CACHE))).toBe(false)
  })

  test('another Java, option or jar starts over: its cache was made for what ran then', () => {
    startThenExit()
    start()
    expect(state()).toBe('made')

    const more = COMMAND.replace('-Xmx1996M', '-Xmx2996M')
    expect(start(more)[0]).toBe(RECORDING)
    expect(existsSync(data(CACHE))).toBe(false)

    startThenExit()
    start()
    expect(state()).toBe('made')
    writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.5"\n')
    expect(start()[0]).toBe(RECORDING)

    startThenExit()
    start()
    writeFileSync(data('server.jar'), 'another jar')
    expect(start()[0]).toBe(RECORDING)
  })

  test('a server on another Java runs as it is: only the one this was measured on knows the cache', () => {
    for (const release of ['21.0.9', '17.0.15', '1.8.0_462', '26.0.2']) {
      writeFileSync(join(root, 'release'), `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${release}"\n`)
      expect(start()).toEqual([ran('')])
    }
    rmSync(join(root, 'release'))
    expect(start()).toEqual([ran('')])
    expect(existsSync(data(`${CACHE}.state`))).toBe(false)
    // Where the image says where its Java is, that is the one read.
    mkdirSync(join(root, 'jdk'))
    writeFileSync(join(root, 'jdk/release'), 'JAVA_VERSION="25.0.4"\n')
    expect(start(COMMAND, { JAVA_HOME: join(root, 'jdk') })[0]).toBe(RECORDING)
  })

  test('a failed one is forgotten with what it was made for', () => {
    startThenExit()
    writeFileSync(join(root, 'java-fails'), '')
    start()
    rmSync(join(root, 'java-fails'))
    expect(start(COMMAND.replace('-Xmx1996M', '-Xmx2996M'))[0]).toBe(RECORDING)
  })

  test('a cache gives way when the volume runs short: it is the world’s first', () => {
    startThenExit()
    start()
    expect(existsSync(data(CACHE))).toBe(true)
    // Room enough to keep one, not to record another.
    room(600_000)
    expect(start()).toEqual([cached()])
    room(100_000)
    expect(start()).toEqual([ran('')])
    expect(existsSync(data(CACHE))).toBe(false)
    expect(existsSync(data(`${CACHE}.state`))).toBe(false)
    room(600_000)
    expect(start()).toEqual([ran('')])
  })

  test('a volume without room for it, a command of another shape and a start with no key run as they are', () => {
    room(600_000)
    expect(start()).toEqual([ran('')])
    expect(existsSync(data(`${CACHE}.state`))).toBe(false)
    // A volume that can't be read is left as it is.
    tool('df', ['exit 1'])
    expect(start()).toEqual([ran('')])

    room(2_999_999)
    const forge = '--stop-duration 60s -- java @libraries/unix_args.txt nogui'
    expect(start(forge)).toEqual([`ran: ${forge}`])
    expect(start(COMMAND, { BLOCKLY_START_KEY: '' })).toEqual([ran('')])
    expect(start(COMMAND.replace('./server.jar', './gone.jar'))).toEqual([
      ran('').replace('./server.jar', './gone.jar'),
    ])
    expect(existsSync(data(`${CACHE}.state`))).toBe(false)
  })
})
