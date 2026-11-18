// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The causes `diagnosis.ts` learned from Aternos' codex-minecraft (MIT), each read from a whole
 * real log. Those under `crash-fixtures/codex/` are codex's own test logs, as its repository has
 * them (commit 7c0e852), the datapack's cut to its first 120 lines. The JVM's two reports were made
 * by crashing Java 21 on purpose, once in a native library and once in its own code.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { type Diagnosis, diagnose } from './diagnosis.ts'

const FIXTURES = `${import.meta.dir}/crash-fixtures`
const NAMES = [
  'codex/paper-version-downgrade',
  'codex/fabric-corrupt-mod-file',
  'codex/fabric-corrupt-nested-mod-file',
  'codex/fabric-java-version-dependency',
  'codex/fabric-java-version-dependency-exact',
  'codex/vanilla-failed-to-parse-from-pack',
  'codex/paper-configuration-parse-error-26-3',
  'codex/vanilla-malformed-encoding',
  'codex/paper-watchdog-not-responding-26-3',
  'codex/paper-server-icon-invalid-26-3',
  'jvm-fatal-native',
  'jvm-fatal-jvm',
]
const logs = new Map<string, string[]>()
beforeAll(async () => {
  for (const name of NAMES) logs.set(name, (await Bun.file(`${FIXTURES}/${name}.log`).text()).split('\n'))
})
const log = (name: string): string[] => logs.get(name) ?? []

describe('what codex knows', () => {
  test('a world from a newer Minecraft moves the server up, never restores a backup', () => {
    expect(diagnose(log('codex/paper-version-downgrade'))).toEqual({
      summary:
        'Its world was last played on a newer Minecraft than this server runs, and a world can’t go back to an older one. Moving the server up to a newer Minecraft opens it.',
      remedy: 'newer_minecraft',
    })
    // Beside a chunk the world reader also refused, the newer release is still the cause.
    const both = [
      ...log('codex/paper-version-downgrade'),
      'net.minecraft.world.level.chunk.storage.ChunkLoadingException: chunk',
    ]
    expect(diagnose(both)?.remedy).toBe('newer_minecraft')
  })

  test('Java crashing in a mod’s native library names the library', () => {
    expect(diagnose(log('jvm-fatal-native'))).toEqual({
      summary: 'Java crashed inside libjnoise.so, a native library one of its mods or plugins brought.',
      remedy: 'mods',
    })
  })

  test('Java crashing in its own code is ours', () => {
    expect(diagnose(log('jvm-fatal-jvm'))).toEqual({
      summary: 'Java itself crashed while it ran. Nothing about your server is wrong; this one is ours.',
      remedy: 'ours',
    })
    // spark's profiler, which Paper bundles, is ours too.
    const spark = log('jvm-fatal-native').map((line) => line.replace('libjnoise.so', 'libasyncProfiler.so'))
    expect(diagnose(spark)?.remedy).toBe('ours')
  })

  test('a damaged mod file is named, not read as mods that can’t run together', () => {
    const fixed: Diagnosis = {
      summary:
        'html’s file is damaged, so it can’t be loaded. Removing it and adding it again fetches a whole copy.',
      remedy: 'mods',
    }
    expect(diagnose(log('codex/fabric-corrupt-mod-file'))).toEqual(fixed)
    expect(diagnose(log('codex/fabric-corrupt-nested-mod-file'))).toEqual({
      ...fixed,
      summary: fixed.summary.replace('html', 'nested'),
    })
  })

  test('a mod’s Java names the version it wants, and the one there', () => {
    expect(diagnose(log('codex/fabric-java-version-dependency'))).toEqual({
      summary:
        'Foo needs Java 99 or newer, and this Minecraft runs on Java 25. Cubepals picks the Java itself, so this is ours to fix.',
      remedy: 'ours',
    })
    expect(diagnose(log('codex/fabric-java-version-dependency-exact'))?.summary).toBe(
      'Foo needs Java 99, and this Minecraft runs on Java 25. Cubepals picks the Java itself, so this is ours to fix.',
    )
  })

  test('a datapack that doesn’t parse is named', () => {
    expect(diagnose(log('codex/vanilla-failed-to-parse-from-pack'))).toEqual({
      summary:
        'The datapack far-end-ender-expansion-2-0-3-v1-17-1 has files this Minecraft can’t read, so its world couldn’t load. It may be made for another version.',
      remedy: 'mods',
    })
  })

  test('Paper’s settings that don’t parse name the file and the line', () => {
    expect(diagnose(log('codex/paper-configuration-parse-error-26-3'))).toEqual({
      summary:
        'Paper’s config/paper-global.yml has a mistake on line 134, so the server couldn’t read its settings. Cubepals writes that file, so this one is ours.',
      remedy: 'ours',
    })
  })

  test('a server.properties Java can’t read is ours', () => {
    expect(diagnose(log('codex/vanilla-malformed-encoding'))?.summary).toStartWith(
      'Its server.properties has a character Java can’t read',
    )
  })

  test('the watchdog names what held the server up', () => {
    expect(diagnose(log('codex/paper-watchdog-not-responding-26-3'))).toEqual({
      summary:
        'p31 watchdog held the server up until it stopped answering. It may not work with this Minecraft or with the others.',
      remedy: 'mods',
    })
    // A dump that names nothing of a mod's or plugin's is worth a second start.
    const bare = log('codex/paper-watchdog-not-responding-26-3').filter(
      (line) => !line.includes('p31-watchdog'),
    )
    expect(diagnose(bare)?.remedy).toBe('retry')
  })

  test('a bad server icon speaks only where nothing else explains the stop', () => {
    // Paper goes on without it: the real log starts, so nothing is claimed.
    const icon = log('codex/paper-server-icon-invalid-26-3')
    expect(diagnose(icon)).toBeNull()
    // A start that stopped after it, with nothing else to say why, says it.
    const stopped = icon.slice(
      0,
      icon.findIndex((line) => line.includes('Done (')),
    )
    expect(diagnose(stopped)).toEqual({
      summary:
        'Its server-list picture couldn’t be read as a picture. Cubepals places that picture, so this one is ours.',
      remedy: 'ours',
    })
    const withMemory = [...stopped, 'java.lang.OutOfMemoryError: Java heap space']
    expect(diagnose(withMemory)?.remedy).toBe('more_room')
  })
})
