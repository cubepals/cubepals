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
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIRECT_START_STEP, KEEP_ASLEEP, TAKE_BACK } from '../../minecraft/direct-start.ts'
import { bootMilestone } from '../../minecraft/logs.ts'
import { RECORDING } from '../../minecraft/start-cache.ts'
import { NOT_ARCHIVED } from '../ports/runtime.ts'

const AS_ROOT = process.getuid?.() === 0
/** The user a server's volume belongs to, where this runs as root. */
const SERVER_USER = 1000

let root = ''
const record = () => join(root, 'data/.blockly-remade/start')
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
  // with. How it ends is read from files, a variable being a changed boot: a copy of the volume
  // taken while it runs, and its exit code, 0 for a clean stop.
  tool('mc-server-runner', [
    'password=$RCON_PASSWORD; [ -n "$password" ] || password=none',
    'echo "ran in $(pwd): $* (password $password)"',
    `[ -f ${join(root, 'copy-while-running')} ] && cp -a ${join(root, 'data')} ${join(root, 'copy')}`,
    // What the control plane runs on the machine while the server runs (a sleep, a resume), then
    // the provider dropping the memory it kept: everything stops where it is, its keeper included.
    `[ -f ${join(root, 'while-running')} ] && sh ${join(root, 'while-running')}`,
    `[ -f ${join(root, 'memory-lost')} ] && kill -9 $PPID`,
    `exit "$(cat ${join(root, 'ends-with')} 2>/dev/null || echo 0)"`,
  ])
  // No room on the volume for a Java startup cache, which has tests of its own
  // (`start-cache-runtime.test.ts`): the command is run as it was written down.
  tool('df', [
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
    'echo "disk 1 1 0 100% /data"',
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
    expect(boot()).toEqual([DIRECT, RAN])
    // It stopped cleanly, so the record is there for the boot after.
    expect(existsSync(record())).toBe(true)
    // Said as the image says its hand-over to Java, which a start's progress reads.
    expect(bootMilestone(DIRECT)).toBe('starting')
  })

  test('runs the command through the Java cache’s script either way, and writes it down without it', () => {
    tool('df', [
      'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
      'echo "disk 9 1 2999999 1% /data"',
    ])
    // On the Java the cache is for, which the image says by where its Java is.
    writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.4"\n')
    const java = { JAVA_HOME: root }
    const recording = `-- java -XX:AOTMode=record -XX:AOTConfiguration=${join(root, 'data/.blockly-remade/start.aot.conf')} -Xmx1996M`
    const scripted = boot(java)
    expect(scripted[1]).toBe(RECORDING)
    expect(scripted[2]).toContain(recording)
    expect(
      readFileSync(record(), 'utf8').trimEnd().split('\n').slice(-COMMAND.split(' ').length).join(' '),
    ).toBe(COMMAND)

    const direct = boot(java)
    expect(direct.slice(0, 2)).toEqual([DIRECT, RECORDING])
    expect(direct[2]).toContain(recording)
  })

  test('uses a record once: a server that fell over is started by the scripts the next time', () => {
    boot()
    writeFileSync(join(root, 'ends-with'), '1')
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

/**
 * The volume filled again from an archive of it, as a restore, a rest's wake, an import of the
 * server's own download and a move by archive fill a new one: written without what no archive
 * holds (the export job's `NOT_ARCHIVED`), unpacked as the restore job does, and root's.
 */
function refilledFromArchive(): void {
  const data = join(root, 'data')
  const archive = join(root, 'archive.tgz')
  const excluded = NOT_ARCHIVED.map((name) => `--exclude=./${name}`)
  const packed = Bun.spawnSync(['tar', '-czf', archive, ...excluded, '-C', data, '.'])
  expect(packed.exitCode).toBe(0)
  rmSync(data, { recursive: true })
  mkdirSync(data)
  const unpacked = Bun.spawnSync([
    'tar',
    '-xzf',
    archive,
    '-C',
    data,
    '--no-same-owner',
    '--no-same-permissions',
  ])
  expect(unpacked.exitCode).toBe(0)
  if (AS_ROOT) chownSync(data, 0, 0)
}

describe('a boot after the world was replaced', () => {
  test('restored from a backup, or woken from rest: the volume comes without a record, and the scripts run', () => {
    boot()
    expect(existsSync(record())).toBe(true)
    refilledFromArchive()
    expect(boot().slice(-2)).toEqual(SCRIPTED)
    // Those scripts' record holds for the volume as it is now.
    expect(boot()).toEqual([DIRECT, RAN])
  })

  test('brought in as an import of the server’s own download: the scripts run', () => {
    boot()
    // A download is the same archive of the volume; the world it holds is then restored.
    refilledFromArchive()
    writeFileSync(join(root, 'data/level.dat'), 'the world brought in')
    expect(boot().slice(-2)).toEqual(SCRIPTED)
  })

  test('moved from a copy taken while it ran, as a lost host is rebuilt from its snapshot: the scripts run', () => {
    writeFileSync(join(root, 'copy-while-running'), '')
    boot()
    rmSync(join(root, 'copy-while-running'))
    // The record of a server still running is only pending, and a copy taken then keeps none.
    expect(existsSync(join(root, 'copy/.blockly-remade/start'))).toBe(false)
    rmSync(join(root, 'data'), { recursive: true })
    Bun.spawnSync(['mv', join(root, 'copy'), join(root, 'data')])
    expect(boot().slice(-2)).toEqual(SCRIPTED)
  })

  test('crashed or killed under it: it left no record, and the next boot is the scripts’', () => {
    writeFileSync(join(root, 'ends-with'), '137')
    expect(boot()).toEqual(SCRIPTED)
    expect(existsSync(record())).toBe(false)
    rmSync(join(root, 'ends-with'))
    expect(boot()).toEqual(SCRIPTED)
    // That one stopped cleanly: the boot after starts at once.
    expect(boot()).toEqual([DIRECT, RAN])
  })

  test('leaves no record where the record used to be kept, which every archive holds', () => {
    writeFileSync(join(root, 'data/.blockly-start'), 'a record from before it moved\n')
    boot()
    expect(existsSync(join(root, 'data/.blockly-start'))).toBe(false)
  })
})

/** What the control plane runs on the machine, there while the server runs, in order. */
function whileRunning(...commands: (readonly string[])[]): void {
  writeFileSync(
    join(root, 'while-running'),
    `${commands.map((command) => command[2]?.replaceAll('/data', join(root, 'data'))).join('\n')}\n`,
  )
}

/** The server put to sleep with its world saved, its memory then dropped by the provider. */
function sleptThenMemoryLost(): void {
  whileRunning(KEEP_ASLEEP)
  writeFileSync(join(root, 'memory-lost'), '')
  boot()
  rmSync(join(root, 'memory-lost'))
  rmSync(join(root, 'while-running'))
}

describe('a boot after a sleep whose memory the provider dropped', () => {
  test('starts at once: the sleep kept the record, as a clean stop does', () => {
    expect(boot()).toEqual(SCRIPTED)
    sleptThenMemoryLost()
    expect(existsSync(record())).toBe(true)
    expect(boot()).toEqual([DIRECT, RAN])
  })

  test('from a sleep after a start the scripts ran too', () => {
    whileRunning(KEEP_ASLEEP)
    writeFileSync(join(root, 'memory-lost'), '')
    expect(boot()).toEqual(SCRIPTED)
    rmSync(join(root, 'memory-lost'))
    rmSync(join(root, 'while-running'))
    expect(boot()).toEqual([DIRECT, RAN])
  })

  test('goes through the scripts where the world was restored while it slept', () => {
    boot()
    sleptThenMemoryLost()
    refilledFromArchive()
    expect(boot().slice(-2)).toEqual(SCRIPTED)
  })

  test('goes through the scripts where a setting changed while it slept', () => {
    boot()
    sleptThenMemoryLost()
    expect(boot({ DIFFICULTY: 'easy' })).toEqual(SCRIPTED)
  })
})

describe('a sleep whose memory came back', () => {
  test('runs on with its record pending again: a crash after it leaves none', () => {
    boot()
    whileRunning(KEEP_ASLEEP, TAKE_BACK)
    writeFileSync(join(root, 'ends-with'), '137')
    expect(boot()).toEqual([DIRECT, RAN])
    expect(existsSync(record())).toBe(false)
    rmSync(join(root, 'ends-with'))
    rmSync(join(root, 'while-running'))
    expect(boot()).toEqual(SCRIPTED)
  })

  test('where the record never went back to pending, a crash still leaves none', () => {
    boot()
    whileRunning(KEEP_ASLEEP)
    writeFileSync(join(root, 'ends-with'), '137')
    boot()
    expect(existsSync(record())).toBe(false)
    rmSync(join(root, 'ends-with'))
    rmSync(join(root, 'while-running'))
    expect(boot()).toEqual(SCRIPTED)
  })

  test('and a clean stop after it keeps the record, as ever', () => {
    boot()
    whileRunning(KEEP_ASLEEP, TAKE_BACK)
    boot()
    rmSync(join(root, 'while-running'))
    expect(boot()).toEqual([DIRECT, RAN])
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

  test('on a volume mounted as root’s, as Fly mounts it at every boot, is run once the volume is the server user’s, as the image makes it', () => {
    if (!AS_ROOT) return
    boot()
    rmSync(join(root, 'gosu.log'), { force: true })
    chownSync(join(root, 'data'), 0, 0)
    chownSync(record(), 0, 0)
    expect(boot()).toEqual([`[init] Changing ownership of {data} to ${SERVER_USER} ...`, DIRECT, RAN])
    // Everything on it is the server user's again, as after the image's own `chown -R`.
    expect(statSync(join(root, 'data')).uid).toBe(SERVER_USER)
    expect(statSync(record()).uid).toBe(SERVER_USER)
    const as = `${SERVER_USER}:${SERVER_USER}`
    expect(handedOver()).toEqual([`${as} direct-start check`, `${as} direct-start run`])
  })

  test('is left alone where the image runs the server as root, or keeps the volume’s owner: nothing starts at once as root', () => {
    if (!AS_ROOT) return
    const kept: Record<string, string>[] = [{ UID: '0', GID: '0' }, { SKIP_CHOWN_DATA: 'true' }]
    for (const env of kept) {
      chownSync(join(root, 'data'), 0, 0)
      boot(env)
      rmSync(join(root, 'gosu.log'), { force: true })
      chownSync(join(root, 'data'), 0, 0)
      expect(boot(env)).toEqual(SCRIPTED)
      expect(handedOver()).toEqual([])
      expect(statSync(join(root, 'data')).uid).toBe(0)
    }
  })
})
