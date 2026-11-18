// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The step that spares the image work, run in a real shell against folders standing in for the
 * volume, the machine's disk and the JDK, with a stand-in for the image's own helper that says it
 * was called.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PACK_FILES_SCRIPT } from '../../minecraft/pack-files.ts'
import { WAKE_STEP } from '../../minecraft/wake-step.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-wake-'))
  for (const dir of ['data/config', 'jdk', 'bin']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'jdk/release'), 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="25.0.4"\n')
  writeFileSync(join(root, 'bin/mc-image-helper'), '#!/bin/sh\necho "helper $*"\n')
  chmodSync(join(root, 'bin/mc-image-helper'), 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Runs the step, then `then` with what it exported, the way the image's scripts would see it. */
function run(then: string, env: Record<string, string> = {}): string {
  const step = WAKE_STEP.replaceAll('/tmp/blockly-bin', join(root, 'shim'))
    .replaceAll('/data', join(root, 'data'))
    .replaceAll('/usr/bin/mc-image-helper', join(root, 'bin/mc-image-helper'))
  // The image's scripts run in the volume, where the helper keeps its manifests.
  const result = Bun.spawnSync(['/bin/sh', '-c', `${step} ${then}`], {
    cwd: join(root, 'data'),
    env: { PATH: process.env.PATH ?? '', JAVA_HOME: join(root, 'jdk'), ...env },
  })
  return result.stdout.toString().trim()
}

describe('the helper’s stand-in', () => {
  test('says which Java runs from the JDK’s own file', () => {
    expect(run('mc-image-helper java-release')).toBe('25')
  })

  test('leaves a Java 8, which its file says as 1.8, to the helper', () => {
    writeFileSync(join(root, 'jdk/release'), 'JAVA_VERSION="1.8.0_462"\n')
    expect(run('mc-image-helper java-release')).toBe('helper java-release')
  })

  test('copies from a folder nobody mounted without the helper, and from one that is there with it', () => {
    const sync = (source: string) =>
      run(
        `mc-image-helper sync-and-interpolate --skip-newer-in-destination --replace-env-prefix=CFG_ ${source} /out`,
      )
    expect(sync(join(root, 'nowhere'))).toBe('')
    expect(sync(join(root, 'data'))).toStartWith('helper sync-and-interpolate')
  })

  // Only where the image installs a pack: a server without one, a direct start and a resume
  // never ask for it, and pay nothing for it (`pack-files.ts`).
  test('hands a pack’s install to the script that keeps the owner’s files, and nothing else', () => {
    const script = join(root, 'shim', 'pack-files')
    // The step writes the script as it is; then the stand-in tells each call apart.
    expect(run(`cat ${script}`)).toBe(PACK_FILES_SCRIPT.trim())
    const routed = (call: string) =>
      run(`printf '#!/bin/sh\\necho "pack-files $*"\\n' > ${script} && mc-image-helper ${call}`)
        .split('\n')
        .at(-1)
    expect(routed('install-modrinth-modpack --project=x')).toBe(
      'pack-files install-modrinth-modpack --project=x',
    )
    expect(routed('set-properties --x=1 server.properties')).toBe(
      'helper set-properties --x=1 server.properties',
    )
  })

  test('hands everything else to the helper, with a JVM for a short life', () => {
    expect(run('mc-image-helper set-properties --x=1 server.properties')).toBe(
      'helper set-properties --x=1 server.properties',
    )
    expect(run('echo "$MC_IMAGE_HELPER_OPTS"')).toBe('-XX:TieredStopAtLevel=1 -XX:+UseSerialGC')
  })
})

describe('CurseForge’s files', () => {
  const placing = (files: string) =>
    run(
      `mc-image-helper curseforge-files --use-http2=true --default-category mc-mods --mod-loader FABRIC "${files}"`,
    )

  test('are left alone without a JVM where none are listed and none were placed', () => {
    expect(placing('')).toBe('')
  })

  test('go to the helper where some are listed, or some were placed before, which it takes away', () => {
    expect(placing('jei:1234')).toStartWith('helper curseforge-files')
    writeFileSync(join(root, 'data/.curseforge-files-manifest.json'), '{}')
    expect(placing('')).toStartWith('helper curseforge-files')
  })
})

describe('Paper’s default configs', () => {
  const skipped = (type: string) => run('echo "$SKIP_DOWNLOAD_DEFAULTS"', { TYPE: type })

  // They came from a third party's repository; Paper writes its own for any it doesn't find.
  test('are never fetched on Paper, even onto a new server', () => {
    expect(skipped('PAPER')).toBe('true')
    expect(skipped('VANILLA')).toBe('')
  })
})

describe('Fabric’s installer', () => {
  const installer = (type: string) => run('echo "$FABRIC_LAUNCHER_VERSION"', { TYPE: type })

  test('is pinned, so a start never asks Fabric for the newest', () => {
    expect(installer('FABRIC')).toMatch(/^\d+\.\d+\.\d+$/)
    expect(installer('PAPER')).toBe('')
  })
})

describe('spark’s background profiler', () => {
  const profiler = (type: string) => run('echo "$SPARK_BACKGROUNDPROFILER"', { TYPE: type })

  // It samples for as long as the server runs, whether or not anyone looks; `/spark` stays.
  test('is off on Paper, where spark comes bundled, and left alone elsewhere', () => {
    expect(profiler('PAPER')).toBe('false')
    expect(profiler('FABRIC')).toBe('')
  })
})
