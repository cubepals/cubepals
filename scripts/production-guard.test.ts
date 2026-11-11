// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Main's guard decides what a production run deploys. Its CLI runs here as the workflow runs it:
 * copied, with only the files beside it, into a checkout of its own (a small repository made for
 * each test), with no install. This checkout's own HEAD must meet every requirement, so a change
 * that moves what a requirement looks for fails here and not at the next deploy.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { missing, REQUIREMENTS } from './production-guard.ts'

const WORKFLOW = '.github/workflows/deploy-production.yml'
const SETTINGS = 'infra/terraform/environments/production/config.auto.tfvars.json'
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd: dir, stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** Writes `files` and commits them; returns the commit. */
function commit(dir: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'change')
  return git(dir, 'rev-parse', 'HEAD')
}

/**
 * A repository with main's guard in it: first a nightly from before #445 and #447 and the guard,
 * then one with both and the guard, then main with a newer workflow. Returns it and its commits.
 */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'production-guard-'))
  made.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'tag.gpgsign', 'false')
  const old = commit(dir, {
    [WORKFLOW]: 'old steps\n',
    'infra/terraform/stack/main.tf': 'locals {}\n',
    // The guard runs with this as its HOME, where bun keeps its cache.
    '.gitignore': '.bun/\n',
  })
  git(dir, 'tag', 'v0.1.1-nightly.20261101.1')
  mkdirSync(join(dir, 'scripts'))
  for (const file of [
    'production-guard.ts',
    'production-plan-review.ts',
    'production-route.ts',
    'production-web.ts',
    'versions.ts',
  ])
    copyFileSync(join(import.meta.dir, file), join(dir, 'scripts', file))
  for (const file of ['apps/control/Dockerfile', 'apps/edge/Dockerfile']) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    copyFileSync(join(import.meta.dir, '..', file), join(dir, file))
  }
  const current = commit(dir, {
    'infra/terraform/stack/main.tf': readFileSync(
      join(import.meta.dir, '../infra/terraform/stack/main.tf'),
      'utf8',
    ),
    'apps/control/src/app/edge/play-records.ts': '',
  })
  git(dir, 'tag', 'v0.1.2-nightly.20261102.2')
  const main = commit(dir, { [WORKFLOW]: 'new steps\n' })
  return { dir, old, current, main }
}

/** Runs the guard's CLI from `dir`, as the workflow does; returns its exit code, output and GITHUB_OUTPUT. */
function guard(dir: string, args: string[], env: Record<string, string> = {}) {
  // Inside .git, so that a test's next commit doesn't take it in.
  const output = join(dir, '.git/github-output')
  writeFileSync(output, '')
  const run = Bun.spawnSync([process.execPath, join(dir, 'scripts/production-guard.ts'), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, GITHUB_OUTPUT: output, ...env },
    stderr: 'pipe',
  })
  return {
    code: run.exitCode,
    said: run.stdout.toString() + run.stderr.toString(),
    output: readFileSync(output, 'utf8'),
  }
}

describe('what production’s settings need of a commit', () => {
  test('this checkout meets every requirement', () => {
    const everything = Object.fromEntries(REQUIREMENTS.map((r) => [r.setting, 'set']))
    const head = git(import.meta.dir, 'rev-parse', 'HEAD')
    expect(missing(head, everything, ['terraform', 'control'])).toEqual([])
  })

  test('only a setting that is set needs anything, and only of the parts it concerns', () => {
    const { dir, old } = repository()
    expect(missing(old, {}, ['terraform', 'control'], dir)).toEqual([])
    const both = { PLAY_IPV4: '203.0.113.7', PLAY_IPV4_BY_REGION: 'us:203.0.113.9' }
    expect(missing(old, both, ['terraform', 'control'], dir).map((r) => r.change)).toEqual(['#445', '#447'])
    expect(missing(old, both, ['control'], dir).map((r) => r.change)).toEqual(['#447'])
  })

  test('a commit this checkout doesn’t have, as an image from before deploy labels names, meets none', () => {
    const { dir } = repository()
    expect(missing('', { PLAY_IPV4_BY_REGION: 'us:203.0.113.9' }, ['control'], dir)).toHaveLength(1)
    expect(missing('1'.repeat(40), { PLAY_IPV4_BY_REGION: 'us:203.0.113.9' }, ['control'], dir)).toHaveLength(
      1,
    )
  })
})

describe('run: what a run deploys', () => {
  test('an old run started again is refused, since it runs its old steps', () => {
    const { dir, old } = repository()
    const { code, said } = guard(dir, ['run', 'apply', ''], { WORKFLOW_SHA: old })
    expect(code).toBe(1)
    expect(said).toContain("isn't main's")
  })

  test('apply takes the newest nightly, as a commit, when none is named', () => {
    const { dir, current, main } = repository()
    const { code, output } = guard(dir, ['run', 'apply', ''], { WORKFLOW_SHA: main })
    expect(code).toBe(0)
    expect(output).toBe(`commit=${current}\n`)
  })

  test('apply takes only a nightly, and only one on main', () => {
    const { dir, main } = repository()
    expect(guard(dir, ['run', 'apply', 'v0.1.2'], { WORKFLOW_SHA: main }).said).toContain("isn't a nightly")
    git(dir, 'checkout', '-q', '-b', 'side', 'HEAD~1')
    commit(dir, { 'side.txt': 'x' })
    git(dir, 'tag', 'v0.1.3-nightly.20261103.3')
    git(dir, 'checkout', '-q', 'main')
    const { code, said } = guard(dir, ['run', 'apply', 'v0.1.3-nightly.20261103.3'], { WORKFLOW_SHA: main })
    expect(code).toBe(1)
    expect(said).toContain("isn't a commit on main")
  })

  test("a rollback runs main's own code", () => {
    const { dir, main } = repository()
    expect(guard(dir, ['run', 'rollback fly', ''], { WORKFLOW_SHA: main }).output).toBe(`commit=${main}\n`)
  })
})

describe('route: the road main’s newest commit takes', () => {
  /** Production as running `commit`, as the workflow's fetch names it. */
  const live = (dir: string, commit: string) =>
    git(dir, 'update-ref', 'refs/remotes/origin/production', commit)

  test('an old run started again is refused here too', () => {
    const { dir, old } = repository()
    const { code, said } = guard(dir, ['route'], { WORKFLOW_SHA: old })
    expect(code).toBe(1)
    expect(said).toContain("isn't main's")
  })

  test('without what production runs to compare with, it is the whole road', () => {
    const { dir, main } = repository()
    const { code, said, output } = guard(dir, ['route'], { WORKFLOW_SHA: main })
    expect(code).toBe(0)
    expect(said).toContain('couldn’t be compared')
    expect(output).toBe(`route=full\ncommit=${main}\n`)
  })

  test('a change of prose deploys nothing; one of the website and the control plane takes the whole road', () => {
    const { dir } = repository()
    const before = git(dir, 'rev-parse', 'HEAD')
    live(dir, before)
    const docs = commit(dir, { 'docs/x.md': 'words\n' })
    expect(guard(dir, ['route'], { WORKFLOW_SHA: docs }).output).toBe(`route=none\ncommit=${docs}\n`)
    const web = commit(dir, { 'apps/web/src/page.tsx': 'x\n' })
    expect(guard(dir, ['route'], { WORKFLOW_SHA: web }).output).toBe(`route=website\ncommit=${web}\n`)
    const both = commit(dir, { 'apps/control/src/main.node.ts': 'x\n' })
    const { said, output } = guard(dir, ['route'], { WORKFLOW_SHA: both })
    expect(output).toBe(`route=full\ncommit=${both}\n`)
    expect(said).toContain('  website: apps/web/src/page.tsx')
  })

  test('a file moved out of a package counts as the package’s', () => {
    const { dir } = repository()
    commit(dir, { 'packages/contracts/src/a.ts': 'x\n' })
    live(dir, git(dir, 'rev-parse', 'HEAD'))
    mkdirSync(join(dir, 'docs'))
    git(dir, 'mv', 'packages/contracts/src/a.ts', 'docs/a.md')
    git(dir, 'commit', '-q', '-m', 'move')
    const moved = git(dir, 'rev-parse', 'HEAD')
    expect(guard(dir, ['route'], { WORKFLOW_SHA: moved }).output).toBe(`route=full\ncommit=${moved}\n`)
  })
})

describe('run website: the website alone, once proved', () => {
  /**
   * A fake `gh` on PATH that answers `gh api repos/<repo>/<path>` from `answers`, by path, one
   * answer a line, whatever the jq; any other path answers nothing.
   */
  function fakeGitHub(dir: string, answers: Record<string, string[]>): Record<string, string> {
    const bin = join(dir, '.git/fake-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(dir, '.git/answers.json'), JSON.stringify(answers))
    const answer = join(dir, '.git/fake-gh.js')
    writeFileSync(
      answer,
      `const path = process.argv[2].replace('repos/cubepals/cubepals/', '')
const all = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, '.git/answers.json'))}, 'utf8'))
for (const line of all[path] ?? []) console.log(line)
`,
    )
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(answer)} "$2"\n`,
    )
    chmodSync(join(bin, 'gh'), 0o755)
    return { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'cubepals/cubepals' }
  }

  /** Production on main's commit, then a change to the website alone. */
  function websiteChange() {
    const { dir, main } = repository()
    git(dir, 'update-ref', 'refs/remotes/origin/production', main)
    const web = commit(dir, { 'apps/web/src/page.tsx': 'x\n' })
    git(dir, 'update-ref', 'refs/heads/main', web)
    return { dir, main, web, tree: git(dir, 'rev-parse', `${web}^{tree}`) }
  }

  const proved = (sha: string) => ({
    [`commits/${sha}/check-runs?check_name=check`]: ['success'],
    [`commits/${sha}/statuses`]: ['success'],
  })

  test('a commit that passed CI with its preview answering goes', () => {
    const { dir, main, web } = websiteChange()
    const env = { WORKFLOW_SHA: main, ...fakeGitHub(dir, proved(web)) }
    const { code, said, output } = guard(dir, ['run', 'website', web], env)
    expect({ code, said }).toMatchObject({ code: 0 })
    expect(said).toContain('Deploying the website')
    expect(output).toBe(`commit=${web}\n`)
  })

  test('a squash merge goes on its pull request’s proof when the trees are the same', () => {
    const { dir, main, web, tree } = websiteChange()
    const head = '7'.repeat(40)
    const env = fakeGitHub(dir, {
      [`commits/${web}/pulls`]: [head],
      [`git/commits/${head}`]: [tree],
      ...proved(head),
    })
    expect(guard(dir, ['run', 'website', web], { WORKFLOW_SHA: main, ...env }).code).toBe(0)
    expect(guard(dir, ['proven', web], env).code).toBe(0)
  })

  test('a pull request head with another tree proves nothing, nor CI without the preview', () => {
    const { dir, main, web } = websiteChange()
    const head = '7'.repeat(40)
    const env = fakeGitHub(dir, {
      [`commits/${web}/pulls`]: [head],
      [`git/commits/${head}`]: ['0'.repeat(40)],
      ...proved(head),
      [`commits/${web}/check-runs?check_name=check`]: ['success'],
    })
    const { code, said } = guard(dir, ['run', 'website', web], { WORKFLOW_SHA: main, ...env })
    expect(code).toBe(1)
    expect(said).toContain('passed CI with its preview answering')
    expect(guard(dir, ['proven', web], env).code).toBe(1)
  })

  test('a change beyond the website is refused, proved or not', () => {
    const { dir, main } = websiteChange()
    const both = commit(dir, { 'apps/control/src/main.node.ts': 'x\n' })
    git(dir, 'update-ref', 'refs/heads/main', both)
    const env = { WORKFLOW_SHA: main, ...fakeGitHub(dir, proved(both)) }
    const { code, said } = guard(dir, ['run', 'website', both], env)
    expect(code).toBe(1)
    expect(said).toContain('takes another road')
  })

  test('a commit off main is refused', () => {
    const { dir, main } = websiteChange()
    git(dir, 'checkout', '-q', '-b', 'side', main)
    const side = commit(dir, { 'apps/web/src/other.tsx': 'x\n' })
    git(dir, 'checkout', '-q', 'main')
    const env = { WORKFLOW_SHA: main, ...fakeGitHub(dir, proved(side)) }
    expect(guard(dir, ['run', 'website', side], env).said).toContain("isn't a commit on main")
  })
})

describe('fits: whether a commit may be applied with production’s settings', () => {
  const settings = (values: Record<string, string>) => JSON.stringify({ settings: values })

  test('a nightly older than a set setting needs, or without the plan review, is refused', () => {
    const { dir, old, current } = repository()
    mkdirSync(dirname(join(dir, SETTINGS)), { recursive: true })
    writeFileSync(join(dir, SETTINGS), settings({ PLAY_IPV4: '203.0.113.7', PLAY_IPV4_BY_REGION: '' }))
    const refused = guard(dir, ['fits', old])
    expect(refused.code).toBe(1)
    expect(refused.said).toContain('PLAY_IPV4 is set, and the code is older than #445')
    expect(refused.said).not.toContain('#447')
    expect(refused.said).toContain('doesn’t have its Terraform plan reviewed')
    expect(guard(dir, ['fits', current]).code).toBe(0)
  })
})
