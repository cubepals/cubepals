// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Java cache's script telling Paperclip from Mojang's jar, run inside both images a server
 * runs: the Ubuntu build that Paper and every server with mods or plugins runs, and the Alpine build
 * that plain Minecraft runs, whose unzip, awk, sed and grep are BusyBox's (`imageFor`). Stand-ins
 * for Java and the image's runner, on the PATH, say how they were called. The script's other lines
 * are tested on this machine's own tools (`app/servers/paper-launch-runtime.test.ts`, `app/servers/start-cache-runtime.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { LAUNCH_MAKER, LAUNCH_MAKER_LINES } from '../../minecraft/paper-launch.ts'
import { imageFor } from '../../minecraft/runtime-spec.ts'
import { CACHED_RUNNER_LINES } from '../../minecraft/start-cache.ts'

const SOCKET = '/var/run/docker.sock'
const docker = new Docker({ socketPath: SOCKET })
const UNPACKING = '[init] Unpacking Paper before its start'

/**
 * Both images, as the product picks them: one for a Paper server, one for a plain one. CI pulls
 * them before the tests ("Pull the server images"); no test pulls an image itself.
 */
const IMAGES = {
  ubuntu: imageFor({ gameVersion: '26.3', loader: 'paper', modpack: null }),
  alpine: imageFor({ gameVersion: '26.3', loader: 'vanilla', modpack: null }),
}

let root = ''

/**
 * A server jar, written with this machine's Python: its main class and lists naming one jar it
 * unpacks, which isn't there yet, as Paperclip's and Mojang's do, and Paperclip's own class where it
 * is one.
 */
function serverJar(isPaperclip: boolean): void {
  const listed = `${'0'.repeat(64)}\tid:versions/26.3/server.jar\t26.3/server.jar`
  const made = Bun.spawnSync([
    'python3',
    '-c',
    [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1], "w")',
      'z.writestr("META-INF/main-class", "org.bukkit.craftbukkit.Main\\n")',
      'z.writestr("META-INF/versions.list", sys.argv[2])',
      'z.writestr("META-INF/libraries.list", "")',
      'z.writestr("io/papermc/paperclip/Main.class" if sys.argv[3] == "1" else "net/minecraft/bundler/Main.class", "x")',
      'z.close()',
    ].join('\n'),
    join(root, 'data', 'server.jar'),
    listed,
    isPaperclip ? '1' : '0',
  ])
  expect(made.exitCode).toBe(0)
}

/**
 * One start of `server.jar` through the script, in the image, as the server's user would; returns
 * what it printed and the calls the stand-ins saw.
 */
async function start(image: string): Promise<{ said: string; java: string[] }> {
  rmSync(join(root, 'java.log'), { force: true })
  const container = await docker.createContainer({
    Image: image,
    // As whoever runs the test, not the image's root, so what the script writes is the test's own
    // to remove, and the script runs as no server's does: without root.
    User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [
      'export PATH=/t/bin:$PATH JAVA_HOME=/t BLOCKLY_START_KEY=key; cd /t/data && sh /t/start-cache --stop-duration 60s -- java -Xmx1024M -jar server.jar nogui',
    ],
    HostConfig: { Binds: [`${root}:/t`], AutoRemove: false },
  })
  try {
    await container.start()
    await container.wait()
    const logs = (await container.logs({ stdout: true, stderr: true })).toString('utf8')
    const java = existsSync(join(root, 'java.log'))
      ? readFileSync(join(root, 'java.log'), 'utf8').trim().split('\n').filter(Boolean)
      : []
    return { said: logs, java }
  } finally {
    await container.remove({ force: true })
  }
}

describe.skipIf(!existsSync(SOCKET))('the cache script in the images a server runs', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'blockly-images-'))
    chmodSync(root, 0o777)
    for (const dir of ['data', 'bin']) mkdirSync(join(root, dir), { recursive: true })
    chmodSync(join(root, 'data'), 0o777)
    writeFileSync(join(root, 'release'), 'JAVA_VERSION="25.0.4"\n')
    const moved = (lines: readonly string[]) =>
      `${lines.join('\n').replaceAll(LAUNCH_MAKER, '/t/paper-launch').replaceAll('/data', '/t/data')}\n`
    writeFileSync(join(root, 'start-cache'), moved(CACHED_RUNNER_LINES))
    writeFileSync(join(root, 'paper-launch'), moved(LAUNCH_MAKER_LINES))
    const tool = (name: string, lines: string[]) => {
      writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${lines.join('\n')}\n`)
      chmodSync(join(root, 'bin', name), 0o755)
    }
    tool('java', ['echo "$*" >> /t/java.log'])
    tool('mc-server-runner', ['echo "ran: $*"'])
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  for (const [name, image] of Object.entries(IMAGES)) {
    test(`${name}: Mojang's jar, which lists its jars as Paperclip does, is not taken for Paperclip`, async () => {
      rmSync(join(root, 'data'), { recursive: true, force: true })
      mkdirSync(join(root, 'data'))
      chmodSync(join(root, 'data'), 0o777)
      serverJar(false)
      const { said, java } = await start(image)
      expect(said).not.toContain(UNPACKING)
      expect(java.some((call) => call.includes('-Dpaperclip.patchonly=true'))).toBe(false)
      expect(said).toContain('ran: --stop-duration 60s -- java')
      expect(said).toContain('-jar server.jar nogui')
    }, 120_000)

    test(`${name}: Paperclip is, and is unpacked before its start`, async () => {
      rmSync(join(root, 'data'), { recursive: true, force: true })
      mkdirSync(join(root, 'data'))
      chmodSync(join(root, 'data'), 0o777)
      serverJar(true)
      const { said, java } = await start(image)
      expect(said).toContain(UNPACKING)
      expect(java.some((call) => call.includes('-Dpaperclip.patchonly=true -jar server.jar'))).toBe(true)
    }, 120_000)
  }
})
