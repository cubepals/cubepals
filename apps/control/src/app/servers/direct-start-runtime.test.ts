// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The step that starts the server without the image's scripts, run in a real shell against
 * folders standing in for the volume, the machine's disk and the image, with stand-ins for the
 * image's runner and for `gosu` that say how they were called. Run as root, the volume is given
 * to another user, as a server's is, and the step has to go through `gosu`; run as anyone else,
 * the volume is the runner's own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIRECT_START_STEP } from '../../minecraft/direct-start.ts'
import { bootMilestone } from '../../minecraft/logs.ts'

const AS_ROOT = process.getuid?.() === 0
/** The user a server's volume belongs to, where this runs as root. */
const SERVER_USER = 1000

let root = ''
const record = () => join(root, 'data/.blockly-start')
const tool = (name: string, lines: string[]) => {
  writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${lines.join('\n')}\n`)
  chmodSync(join(root, 'bin', name), 0o755)
}
const handedOver = () =>
  existsSync(join(root, 'gosu.log')) ? readFileSync(join(root, 'gosu.log'), 'utf8').trim().split('\n') : []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-direct-'))
  chmodSync(root, 0o755)
  for (const dir of ['data', 'shim', 'bin', 'image']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'image/start-finalExec'), 'the scripts of one image\n')
  writeFileSync(join(root, 'data/server.jar'), 'jar')
  if (AS_ROOT) chownSync(join(root, 'data'), SERVER_USER, SERVER_USER)
  // The runner says where it ran, with which words, and the password it would stop the server
  // with. How long the server stays up is read from a file: a variable would be a changed boot.
  tool('mc-server-runner', [
    'password=$RCON_PASSWORD; [ -n "$password" ] || password=none',
    'echo "ran in $(pwd): $* (password $password)"',
    'sleep "$(cat "$STAYS_UP_FILE" 2>/dev/null || echo 0)"',
  ])
  // gosu, which only writes down whom it was asked to run what as.
  tool('gosu', [`echo "$1 $(basename "$2") $3" >> ${join(root, 'gosu.log')}`, 'shift', 'exec "$@"'])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The server's command as the image's scripts end on it. */
const COMMAND = '--stop-duration 60s -- java -Xmx1996M -jar ./server.jar'
const DIRECT = '[init] Starting the Minecraft server at once: nothing changed since the last start'
const RAN = `ran in {data}: ${COMMAND} (password made-by-the-scripts)`
const SCRIPTED = ['scripts with 0 words', RAN]

/**
 * One boot: the step, then what stands for the image's scripts, which say they ran, export what
 * the real ones would (`exported`), and call the runner they were told to from the server's
 * directory.
 */
function boot(
  env: Record<string, string> = {},
  exported = 'export RCON_PASSWORD=made-by-the-scripts;',
): string[] {
  const step = DIRECT_START_STEP.replaceAll('/tmp/blockly-bin', join(root, 'shim'))
    .replaceAll('/data', join(root, 'data'))
    .replaceAll('/image/scripts/start', join(root, 'image/start'))
    .replaceAll('/etc/nsswitch.conf', join(root, 'nsswitch'))
    .replaceAll('sleep 90', 'sleep 0.3')
  const scripts = [
    'password=$RCON_PASSWORD; [ -n "$password" ] || password=none;',
    'echo "scripts with $# words (password $password)";',
    exported,
    `cd ${join(root, 'data')} && exec "$SERVER_RUNNER" ${COMMAND}`,
  ].join(' ')
  const result = Bun.spawnSync(['/bin/sh', '-c', `${step} ${scripts}`], {
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      DIFFICULTY: 'hard',
      STAYS_UP_FILE: join(root, 'stays-up'),
      ...env,
    },
  })
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.replace(join(root, 'data'), '{data}').replace(' (password none)', ''))
}

describe('a boot that changed nothing', () => {
  test('goes through the scripts the first time, which leaves what they ran written down', () => {
    expect(boot()).toEqual(SCRIPTED)
    const [key, dir, added, variable, ...words] = readFileSync(record(), 'utf8').trimEnd().split('\n')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(dir).toBe(join(root, 'data'))
    // What the scripts added to the environment, and nothing the entrypoint was given.
    expect([added, variable]).toEqual(['1', 'RCON_PASSWORD=made-by-the-scripts'])
    expect(words.join(' ')).toBe(COMMAND)
  })

  test('then starts the server at once: the same words, directory and variables', () => {
    boot()
    writeFileSync(join(root, 'stays-up'), '1')
    expect(boot()).toEqual([DIRECT, RAN])
    // It stayed up, so the record is there for the boot after.
    expect(existsSync(record())).toBe(true)
    // Said as the image says its hand-over to Java, which a start's progress reads.
    expect(bootMilestone(DIRECT)).toBe('starting')
  })

  test('uses a record once: a server that fell over is started by the scripts the next time', () => {
    boot()
    expect(boot()[0]).toBe(DIRECT)
    expect(existsSync(record())).toBe(false)
    expect(boot()).toEqual(SCRIPTED)
  })

  test('is told by what the scripts decide by, not by what a machine changes from boot to boot', () => {
    boot({ FLY_MACHINE_VERSION: '01A', HOSTNAME: 'one' })
    expect(boot({ FLY_MACHINE_VERSION: '01B', HOSTNAME: 'two' })[0]).toBe(DIRECT)
  })
})

describe('a boot that changed something', () => {
  test('goes through the scripts: a setting, or another image’s scripts', () => {
    boot()
    expect(boot({ DIFFICULTY: 'peaceful' })).toEqual(SCRIPTED)
    // That boot wrote down its own; the first setting is no longer what the record is for.
    expect(boot()).toEqual(SCRIPTED)
    writeFileSync(join(root, 'image/start-finalExec'), 'the scripts of the next image\n')
    expect(boot()).toEqual(SCRIPTED)
  })

  test('goes through the scripts where a jar the command names is gone, finding nothing set for it', () => {
    boot()
    rmSync(join(root, 'data/server.jar'))
    // No words left over from the record, and none of its variables: the scripts start clean.
    expect(boot()).toEqual(SCRIPTED)
  })

  test('leaves no older record behind, whatever its scripts then write down or don’t', () => {
    boot()
    const older = readFileSync(record(), 'utf8')
    // A boot the scripts take, whose scripts add a value that can't be written down: the record
    // from before them is gone, not kept for a later boot to start from.
    const exported = 'export RCON_PASSWORD=another-password; export NOTE="one\ntwo";'
    boot({ DIFFICULTY: 'peaceful' }, exported)
    expect(existsSync(record())).toBe(false)
    expect(older).toContain('RCON_PASSWORD=made-by-the-scripts')
    // So the first setting again goes through the scripts, not from what was written before.
    expect(boot()).toEqual(SCRIPTED)
  })

  test('is not written down where the scripts added a value over several lines', () => {
    const exported = 'export RCON_PASSWORD=made-by-the-scripts; export NOTE="one\ntwo";'
    expect(boot({}, exported)).toEqual(SCRIPTED)
    expect(existsSync(record())).toBe(false)
  })
})

describe('a record on a volume the server can write', () => {
  test('is read and run as the volume’s user, never as root', () => {
    boot()
    rmSync(join(root, 'gosu.log'), { force: true })
    expect(boot()[0]).toBe(DIRECT)
    // Root asked that user whether it holds, and handed the start over to them.
    const as = `${SERVER_USER}:${SERVER_USER}`
    expect(handedOver()).toEqual(AS_ROOT ? [`${as} direct-start check`, `${as} direct-start run`] : [])
  })

  test('that doesn’t read as it was written is left to the scripts, and can’t stop a boot', () => {
    boot()
    const [key, dir, , , ...words] = readFileSync(record(), 'utf8').trimEnd().split('\n')
    // A line that isn't a variable where one was counted.
    writeFileSync(record(), [key, dir, '1', 'not a variable', ...words, ''].join('\n'))
    expect(boot()).toEqual(SCRIPTED)
    // No words at all.
    writeFileSync(record(), [key, dir, '0', ''].join('\n'))
    expect(boot()).toEqual(SCRIPTED)
  })

  test('is left alone where the volume is root’s: nothing starts at once as root', () => {
    if (!AS_ROOT) return
    boot()
    rmSync(join(root, 'gosu.log'), { force: true })
    chownSync(join(root, 'data'), 0, 0)
    expect(boot()).toEqual(SCRIPTED)
    expect(handedOver()).toEqual([])
  })
})
