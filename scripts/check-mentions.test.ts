// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** check-mentions.ts: what GitHub would link, what it wouldn't, and the script as hook and CI run it. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mentionsIn } from './check-mentions.ts'

const SCRIPT = resolve(import.meta.dir, 'check-mentions.ts')

function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-mentions-'))
  try {
    const result = Bun.spawnSync(['bun', SCRIPT, ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    })
    return { code: result.exitCode, stderr: result.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mentionsIn', () => {
  test('finds a selector even inside backticks, since commits do not render markdown', () => {
    expect(mentionsIn('One `execute as <player> at @s unless block` check')).toEqual(['@s'])
    expect(mentionsIn('@p joined')).toEqual(['@p'])
    expect(mentionsIn('ask (@octocat) or @cubepals/devs')).toEqual(['@octocat', '@cubepals/devs'])
  })

  test('leaves addresses, trailers and git comments alone', () => {
    expect(mentionsIn('Write to hello@cubepals.com')).toEqual([])
    expect(
      mentionsIn('Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'),
    ).toEqual([])
    expect(mentionsIn('# Please enter the commit message @ignored')).toEqual([])
    expect(mentionsIn('import from `@blockly/db`')).toEqual(['@blockly/db'])
  })

  test('passes text without any', () => {
    expect(mentionsIn('Keep take them back off magma, cactus and snow')).toEqual([])
    expect(mentionsIn('costs 5 @ 3 each')).toEqual([])
  })
})

describe('the script', () => {
  test('refuses a commit message that mentions someone, and passes one that does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-mentions-msg-'))
    try {
      const bad = join(dir, 'bad')
      const good = join(dir, 'good')
      writeFileSync(bad, 'Check the block under the player\n\nRuns `execute at @s` each time.\n')
      writeFileSync(good, 'Check the block under the player\n\nRuns the s selector each time.\n')
      const refused = run([bad])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('@s')
      expect(run([good]).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('checks a pull request title and body from the environment', () => {
    expect(run(['--pr'], { PR_TITLE: 'Fix spawn', PR_BODY: 'thanks @someone' }).code).toBe(1)
    expect(run(['--pr'], { PR_TITLE: 'Fix spawn', PR_BODY: 'mail hello@cubepals.com' }).code).toBe(0)
  })
})
