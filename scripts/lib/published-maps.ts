// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fetching a published map and converting it to the Java release a build wants: its folder, from
 * its repository at a pinned commit, without the rest of its history, and Chunker
 * (HiveGamesOSS/Chunker, MIT, at a pinned commit) to convert it, built once. Used by the builds
 * that place published maps: the Arcade's world (`arcade-world.ts`) and the Duels lobby's
 * structures (`duels-lobby.ts`). Not where any map goes.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CHUNKER = {
  repo: 'https://github.com/HiveGamesOSS/Chunker',
  commit: '50aaf6d82e8b68929279161b790d95fdddfe0a40',
}

/** Runs a command in a folder, and stops the build if it fails. */
export function run(command: string, args: string[], cwd: string): void {
  const done = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
  })
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${done.status}`)
}

/** A repository's folders at one commit, under `work`, without the rest of its history or files. */
export function fetchFolders(work: string, repo: string, commit: string, paths: string[]): string {
  const dir = join(work, 'sources', createHash('sha256').update(repo).digest('hex').slice(0, 12))
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], dir)
    run('git', ['config', 'gc.auto', '0'], dir)
    run('git', ['remote', 'add', 'origin', repo], dir)
  }
  run('git', ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit], dir)
  run('git', ['checkout', '-q', commit, '--', ...paths], dir)
  return dir
}

/** Chunker's command-line jar, built under `work` the first time. */
export function chunker(work: string): string {
  const dir = join(work, 'chunker')
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], dir)
    run('git', ['fetch', '-q', '--depth', '1', CHUNKER.repo, CHUNKER.commit], dir)
    run('git', ['checkout', '-q', 'FETCH_HEAD'], dir)
  }
  const jar = join(dir, 'build/libs')
  if (!existsSync(jar)) run('./gradlew', ['-q', ':cli:shadowJar', '--no-daemon'], dir)
  const built = readdirSync(jar).find((name) => name.startsWith('chunker-cli-') && name.endsWith('.jar'))
  if (built === undefined) throw new Error('Chunker built no CLI jar')
  return join(jar, built)
}

/**
 * A world converted by Chunker to a Java release (`JAVA_26_2`, `JAVA_1_21_11`), into `out`; once,
 * since a world already there is the same conversion.
 */
export function convert(java: string, jar: string, from: string, format: string, out: string): string {
  if (!existsSync(join(out, 'level.dat'))) run(java, ['-jar', jar, '-i', from, '-f', format, '-o', out], '.')
  return out
}
