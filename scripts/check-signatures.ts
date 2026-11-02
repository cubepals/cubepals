// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reject unsigned commits before push and in the required change-detection job. Local signatures
 * must verify cryptographically; GitHub-created signatures can be checked through GitHub when
 * its public signing key is absent locally. API failures never count as verified signatures.
 * Historical commits already on main are outside a pull request's signing boundary.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function requireVerified(
  commits: { sha: string; commit: { verification?: { verified?: boolean } } }[],
): void {
  for (const commit of commits) {
    if (commit.commit.verification?.verified !== true) {
      throw new Error(`Commit ${commit.sha} has no verified signature. Sign it before pushing.`)
    }
  }
}

function api(path: string): unknown {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
}

function beforePush(): void {
  const commits = new Set<string>()
  for (const line of readFileSync(0, 'utf8').trim().split('\n')) {
    if (!line) continue
    const [, local, , remote] = line.split(/\s+/)
    if (/^0+$/.test(local)) continue
    const base = /^0+$/.test(remote) ? 'refs/remotes/origin/main' : remote
    for (const sha of git('rev-list', local, `^${base}`).split('\n').filter(Boolean)) commits.add(sha)
  }
  for (const sha of commits) {
    const status = git('show', '-s', '--format=%G?', sha)
    if (['G', 'U'].includes(status)) continue
    if (status !== 'E') throw new Error(`Commit ${sha} has no valid signature. Sign it before pushing.`)
    // Missing keys are not evidence of an invalid signature. Ask the signing authority instead.
    requireVerified([
      api(`repos/cubepals/cubepals/commits/${sha}`) as Parameters<typeof requireVerified>[0][number],
    ])
  }
}

if (import.meta.main) {
  try {
    const [mode, number] = process.argv.slice(2)
    if (mode === '--pre-push') beforePush()
    else if (mode === '--config') {
      if (git('config', '--bool', '--get', 'commit.gpgsign') !== 'true') {
        throw new Error('Signing must be enabled: git config --local commit.gpgsign true')
      }
    } else if (mode === '--pr' && /^\d+$/.test(number)) {
      const pages = JSON.parse(
        execFileSync(
          'gh',
          ['api', '--paginate', '--slurp', `repos/cubepals/cubepals/pulls/${number}/commits`],
          { encoding: 'utf8' },
        ),
      )
      requireVerified(pages.flat())
    } else throw new Error('Usage: check-signatures.ts --pre-push | --config | --pr NUMBER')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
