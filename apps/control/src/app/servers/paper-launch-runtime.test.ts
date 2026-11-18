// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Paper started from its own class path, through the Java cache's script, run in a real shell
 * with the real Python and unzip against a folder standing in for the volume. A Paperclip made
 * here lists jars by their SHA-256 as Paper's does; stand-ins for Java, for the image's runner and
 * for `df` say how they were called. Java, asked to patch, unpacks what the Paperclip lists, as
 * Paperclip does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bootMilestone, classifyLine } from '../../minecraft/logs.ts'
import { LAUNCH_MAKER_LINES } from '../../minecraft/paper-launch.ts'
import { CACHED_RUNNER_LINES, RECORDING } from '../../minecraft/start-cache.ts'

let root = ''
const data = (name: string) => join(root, 'data', name)
const LAUNCH = '.blockly-remade/launch.jar'
const UNPACKING = '[init] Unpacking Paper before its start'
/** What a server's log says once it takes connections. */
const DONE_LINE = '[10:03:41 INFO]: Done (17.000s)! For help, type "help"'
const tool = (name: string, lines: string[]) => {
  writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${lines.join('\n')}\n`)
  chmodSync(join(root, 'bin', name), 0o755)
}
const javaCalls = () =>
  existsSync(join(root, 'java.log')) ? readFileSync(join(root, 'java.log'), 'utf8').trim().split('\n') : []
const launchState = () =>
  readFileSync(data(`${LAUNCH}.state`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)

/** `df`, saying the volume has this many kilobytes free. */
const room = (kilobytes: number) =>
  tool('df', [
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
    `echo "disk 3000000 1 ${kilobytes} 1% /data"`,
  ])

/** What Paperclip unpacks, by where it puts each jar, and what each holds. */
const UNPACKED: Record<string, string> = {
  'versions/26.2/paper-26.2.jar': 'paper and minecraft',
  'libraries/com/example/first/1.0/first-1.0.jar': 'a library',
  'libraries/org/example/second/2.0/second-2.0.jar': 'another library',
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** A Paperclip: a jar whose lists name each jar it unpacks, by its SHA-256, as Paper's does. */
function paperclip(path: string, unpacked = UNPACKED) {
  const list = (kind: string) =>
    Object.entries(unpacked)
      .filter(([where]) => where.startsWith(`${kind}/`))
      .map(([where, held]) => `${sha(held)}\tid:${where}\t${where.slice(kind.length + 1)}`)
      .join('\n')
  const made = Bun.spawnSync([
    'python3',
    '-c',
    [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1], "w")',
      'z.writestr("META-INF/main-class", "org.bukkit.craftbukkit.Main\\n")',
      'z.writestr("META-INF/versions.list", sys.argv[2])',
      'z.writestr("META-INF/libraries.list", sys.argv[3])',
      'z.writestr("io/papermc/paperclip/Main.class", "paperclip")',
    ].join('\n'),
    path,
    list('versions'),
    list('libraries'),
  ])
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
}

/** What Paperclip, asked to patch, leaves: every jar it lists, as it lists it. */
function unpack() {
  for (const [where, held] of Object.entries(UNPACKED)) {
    mkdirSync(dirname(data(where)), { recursive: true })
    writeFileSync(data(where), held)
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-paper-'))
  for (const dir of ['data', 'bin', 'shim']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.4"\n')
  writeFileSync(join(root, 'meminfo'), 'MemTotal:       16777216 kB\n')
  writeFileSync(join(root, 'shim/paper-launch'), `${LAUNCH_MAKER_LINES.join('\n')}\n`)
  writeFileSync(
    join(root, 'start-cache'),
    `${CACHED_RUNNER_LINES.join('\n')
      .replaceAll('/tmp/blockly-bin', join(root, 'shim'))
      .replaceAll('/data', join(root, 'data'))
      .replaceAll('/proc/meminfo', join(root, 'meminfo'))}\n`,
  )
  paperclip(data('paper.jar'))
  // The runner says what it ran; where the server is said to come up, its log says so, as Minecraft's does.
  tool('mc-server-runner', [
    'echo "ran: $*"',
    `if [ -f ${join(root, 'comes-up')} ]; then mkdir -p logs && echo "${DONE_LINE.replaceAll('"', '\\"')}" > logs/latest.log; fi`,
  ])
  // Java, asked to patch, unpacks what the Paperclip lists; asked to make a cache, writes one.
  tool('java', [
    `echo "$*" >> ${join(root, 'java.log')}`,
    `case "$*" in *paperclip.patchonly=true*) cp -R ${join(root, 'unpacks')}/. ${join(root, 'data')}/;; esac`,
    'for word; do case "$word" in -XX:AOTCache=*) echo cache > "$(echo "$word" | cut -d= -f2-)";; esac; done',
  ])
  // What Java's patching unpacks.
  mkdirSync(join(root, 'unpacks'))
  for (const [where, held] of Object.entries(UNPACKED)) {
    mkdirSync(dirname(join(root, 'unpacks', where)), { recursive: true })
    writeFileSync(join(root, 'unpacks', where), held)
  }
  // Room to keep a cache, not to record one: these starts are about the jar they run.
  room(600_000)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const COMMAND = '--stop-duration 60s -- java -Xmx1996M -jar ./paper.jar nogui'
const ran = (jar: string, options = '') =>
  `ran: --stop-duration 60s -- java ${options}-Xmx1996M -jar ${jar} nogui`
const FROM_CLASS_PATH = ran(`{root}/data/${LAUNCH}`)
const THROUGH_PAPERCLIP = ran('./paper.jar')

/** One start of the server: the script, given the words the runner would have been. */
function start(command = COMMAND): string[] {
  const result = Bun.spawnSync(['/bin/sh', join(root, 'start-cache'), ...command.split(' ')], {
    cwd: join(root, 'data'),
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, BLOCKLY_START_KEY: 'a'.repeat(64) },
  })
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.replaceAll(root, '{root}'))
}

/** The manifest the jar carries, its lines joined where they were continued. */
function manifest(): Record<string, string> {
  const read = Bun.spawnSync(['unzip', '-p', data(LAUNCH), 'META-INF/MANIFEST.MF'])
  const text = read.stdout.toString()
  for (const line of text.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(72)
  return Object.fromEntries(
    text
      .replaceAll('\r\n ', '')
      .split('\r\n')
      .filter((line) => line.includes(': '))
      .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
  )
}

describe('Paper started from its class path', () => {
  test('no line of the maker holds a single quote: the boot step writes each one inside a pair', () => {
    expect(LAUNCH_MAKER_LINES.filter((line) => line.includes("'"))).toEqual([])
  })

  test('a Paperclip whose jars are unpacked starts from a jar that names them, in its order', () => {
    unpack()
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(javaCalls()).toEqual([])
    expect(manifest()).toEqual({
      'Manifest-Version': '1.0',
      'Main-Class': 'org.bukkit.craftbukkit.Main',
      'Enable-Native-Access': 'ALL-UNNAMED',
      'Class-Path': Object.keys(UNPACKED)
        .map((where) => `../${where}`)
        .join(' '),
    })
  })

  test('a Paperclip not yet unpacked is patched first, and starts from its class path', () => {
    const said = start()
    expect(said).toEqual([UNPACKING, FROM_CLASS_PATH])
    expect(javaCalls()).toEqual(['-Dpaperclip.patchonly=true -jar ./paper.jar'])
    // Setup, as the image's own lines are, and no step of a start's progress.
    expect(classifyLine(UNPACKING)?.level).toBe('setup')
    expect(bootMilestone(UNPACKING)).toBeNull()
  })

  test('a jar that isn’t what Paperclip lists is patched again before it is named', () => {
    unpack()
    writeFileSync(data('libraries/org/example/second/2.0/second-2.0.jar'), 'someone else’s library')
    expect(start()).toEqual([UNPACKING, FROM_CLASS_PATH])
    expect(readFileSync(data('libraries/org/example/second/2.0/second-2.0.jar'), 'utf8')).toBe(
      'another library',
    )

    // Changed after it was named: checked again at the next start.
    writeFileSync(data('libraries/com/example/first/1.0/first-1.0.jar'), 'changed')
    expect(start()).toEqual([UNPACKING, FROM_CLASS_PATH])
  })

  test('a Paperclip that can’t be unpacked starts as it is', () => {
    tool('java', [`echo "$*" >> ${join(root, 'java.log')}`])
    expect(start()).toEqual([UNPACKING, THROUGH_PAPERCLIP])
    expect(existsSync(data(LAUNCH))).toBe(false)
  })

  test('a start from it whose server never came up, twice, is followed by Paperclip’s until either changes', () => {
    unpack()
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(start()).toEqual([THROUGH_PAPERCLIP])
    expect(launchState()).toEqual(['bad'])
    expect(start()).toEqual([THROUGH_PAPERCLIP])

    // A new build of Paper is tried again.
    paperclip(data('paper.jar'), { ...UNPACKED })
    utimesSync(data('paper.jar'), new Date(), new Date(Date.now() + 5_000))
    expect(start()).toEqual([FROM_CLASS_PATH])
  })

  test('one whose server came up is used from then on', () => {
    unpack()
    writeFileSync(join(root, 'comes-up'), '')
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(launchState()).toEqual(['trying', '1'])
    // Read in the server's log at the next start, before the server writes another.
    rmSync(join(root, 'comes-up'))
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(launchState()).toEqual(['good'])
    for (const _ of [1, 2, 3]) expect(start()).toEqual([FROM_CLASS_PATH])
    expect(launchState()).toEqual(['good'])
  })

  test('a log from before the start doesn’t say it came up', () => {
    unpack()
    mkdirSync(data('logs'))
    writeFileSync(data('logs/latest.log'), `${DONE_LINE}\n`)
    utimesSync(data('logs/latest.log'), new Date(), new Date(Date.now() - 60_000))
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(start()).toEqual([FROM_CLASS_PATH])
    expect(start()).toEqual([THROUGH_PAPERCLIP])
  })

  test('any other jar, Java or a machine with no Python starts as before', () => {
    unpack()
    writeFileSync(data('server.jar'), 'jar')
    expect(start(COMMAND.replace('./paper.jar', './server.jar'))).toEqual([ran('./server.jar')])
    writeFileSync(join(root, 'release'), 'JAVA_VERSION="21.0.9"\n')
    expect(start()).toEqual([THROUGH_PAPERCLIP])
    writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.4"\n')
    tool('python3', ['exit 127'])
    expect(start()).toEqual([THROUGH_PAPERCLIP])
    expect(existsSync(data(LAUNCH))).toBe(false)
  })
})

describe('the Java cache of a start from the class path', () => {
  const cached = () => ran(`{root}/data/${LAUNCH}`, `-XX:AOTCache={root}/data/.blockly-remade/start.aot `)

  test('is made from the manifest jar, and made again when a jar it names changes', () => {
    unpack()
    // The manifest jar, however often it is written, keeps one time: as when written twice in a second.
    const python = Bun.which('python3')
    tool('python3', [
      `"${python}" "$@"; made=$?; touch -d @1700000000 ${data(LAUNCH)} 2>/dev/null; exit $made`,
    ])
    room(2_999_999)
    writeFileSync(join(root, 'comes-up'), '')
    expect(start()).toEqual([
      RECORDING,
      ran(
        `{root}/data/${LAUNCH}`,
        '-XX:AOTMode=record -XX:AOTConfiguration={root}/data/.blockly-remade/start.aot.conf ',
      ),
    ])
    writeFileSync(data('.blockly-remade/start.aot.conf'), 'recorded')
    const [making, run] = start()
    expect(making).toBe('[init] Making this server a quicker start from its last one')
    expect(run).toBe(cached())
    expect(javaCalls().at(-1)).toEndWith(`-cp ${data(LAUNCH)}`)
    expect(start()).toEqual([cached()])

    // A library of the same bytes, written again: what the cache was made for has changed.
    const library = data('libraries/org/example/second/2.0/second-2.0.jar')
    utimesSync(library, new Date(), new Date(Date.now() + 5_000))
    expect(start()[0]).toBe(RECORDING)
  })
})
