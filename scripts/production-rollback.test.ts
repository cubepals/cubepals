// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `production.ts rollback` undoes the last deploy: only the Fly apps it changed go back, each to
 * the image it ran before that deploy, and a second rollback goes further back rather than
 * forward to the image just undone. Run against a fake `fly` on PATH, with fetch and sleeps
 * stubbed: nothing reaches a provider or the network.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPTS, '..')
const ENVIRONMENT_DIR = 'infra/terraform/environments/production'

/** An image as a deploy from a checkout tags it: the deploy's time, then its commit. */
const image = (app: string, deploy: number) =>
  `registry.fly.io/bly-prod-${app}:deploy-20261017T12000${deploy}-${String(deploy).repeat(40)}`

/**
 * Release histories, newest first, as `fly releases --image --json` lists them, after a hotfix
 * that deployed the control app alone: control went 1 → 2; realtime and edge stayed on 1, which an
 * earlier deploy put in place of 0.
 */
const AFTER_HOTFIX: Record<string, string[]> = {
  'bly-prod-control': [image('control', 2), image('control', 1), image('control', 0)],
  'bly-prod-realtime': [image('realtime', 1), image('realtime', 0)],
  'bly-prod-edge': [image('edge', 1), image('edge', 0)],
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Runs `production.ts rollback fly …` against these histories; returns each deploy as `app ← image`. */
function rollback(
  releases: Record<string, string[]>,
  ...args: string[]
): { deployed: string[]; said: string } {
  const dir = mkdtempSync(join(tmpdir(), 'production-rollback-'))
  dirs.push(dir)
  mkdirSync(join(dir, ENVIRONMENT_DIR), { recursive: true })
  copyFileSync(
    join(ROOT, ENVIRONMENT_DIR, 'config.auto.tfvars.example.json'),
    join(dir, ENVIRONMENT_DIR, 'config.auto.tfvars.json'),
  )
  mkdirSync(join(dir, 'local/production'), { recursive: true })
  writeFileSync(join(dir, 'local/production/production.env'), '')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases))
  const log = join(dir, 'fly.log')
  writeFileSync(log, '')
  // The fake fly: records each call; answers releases and machine listings; nothing else.
  writeFileSync(
    join(bin, 'fly'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'fly.js'))} "$@"\n`,
  )
  writeFileSync(
    join(dir, 'fly.js'),
    `const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'releases') {
  const app = args[args.indexOf('-a') + 1]
  const all = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'releases.json'))}, 'utf8'))
  console.log(JSON.stringify((all[app] ?? []).map((ImageRef) => ({ Status: 'complete', ImageRef }))))
} else if (args[0] === 'machines') console.log('[]')
`,
  )
  chmodSync(join(bin, 'fly'), 0o755)
  const preload = join(dir, 'offline.ts')
  writeFileSync(
    preload,
    `globalThis.fetch = (() => Promise.reject(new Error('offline in this test'))) as typeof fetch
Bun.sleep = (async () => {}) as typeof Bun.sleep
`,
  )
  const result = spawnSync(
    process.execPath,
    ['--preload', preload, join(SCRIPTS, 'production.ts'), 'rollback', 'fly', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
      // No provider token at all, and no real fly on PATH: only the fake, bun and the system's tools.
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir },
      timeout: 60_000,
    },
  )
  const deployed = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
    .filter((call) => call[0] === 'deploy')
    .map((call) => `${call[call.indexOf('--app') + 1]} ← ${call[call.indexOf('--image') + 1]}`)
  return { deployed, said: result.stdout }
}

describe('rollback after a deploy that touched only some apps', () => {
  test('leaves the apps that deploy did not touch where they are', () => {
    const { deployed, said } = rollback(AFTER_HOTFIX)
    // Undoing the hotfix: control back to 1. Realtime and edge were not part of it.
    expect(deployed).toEqual([`bly-prod-control ← ${image('control', 1)}`])
    expect(said).toContain('realtime: left as it is')
    expect(said).toContain('edge: left as it is')
  }, 90_000)

  test('a second rollback goes further back, not forward to the image just undone', () => {
    // After the first rollback, control's newest release runs 1 again.
    const rolledBack = {
      ...AFTER_HOTFIX,
      'bly-prod-control': [image('control', 1), ...AFTER_HOTFIX['bly-prod-control']],
    }
    const { deployed } = rollback(rolledBack)
    expect(deployed).toEqual([
      `bly-prod-control ← ${image('control', 0)}`,
      `bly-prod-realtime ← ${image('realtime', 0)}`,
      `bly-prod-edge ← ${image('edge', 0)}`,
    ])
  }, 90_000)

  test('images that do not say which deploy made them are left alone unless named', () => {
    const unlabelled = {
      'bly-prod-control': ['registry.fly.io/c:2', 'registry.fly.io/c:1'],
      'bly-prod-realtime': ['registry.fly.io/r:1', 'registry.fly.io/r:0'],
      'bly-prod-edge': ['registry.fly.io/e:1', 'registry.fly.io/e:0'],
    }
    expect(rollback(unlabelled).deployed).toEqual([])
    expect(rollback(unlabelled, 'control').deployed).toEqual(['bly-prod-control ← registry.fly.io/c:1'])
  }, 90_000)
})
