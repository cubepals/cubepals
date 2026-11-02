// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Main-run artifacts provide provenance; a PR's own cache namespace is never an authority. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { packBaseline, validateBaseline } from './baseline-evidence.mjs'
import { baselineIdentity, cacheAllowed, trustedProducer } from './baseline-identity.mjs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
const notice = (message) => {
  console.warn(message)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`)
}
const api = (repository, path) =>
  JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/${path}`], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * SECOND_MS,
    }),
  )

export function normalizeProducer(run) {
  return {
    id: run.id,
    head: run.head_sha,
    branch: run.head_branch,
    event: run.event,
    workflow: run.path?.split('@')[0],
    repository: run.head_repository?.full_name,
    repositoryId: run.head_repository?.id,
    conclusion: run.conclusion,
  }
}

export function restoreBaseline({ root, checkout, comparison, directory, full = false }) {
  output('hit', 'false')
  rmSync(directory, { recursive: true, force: true })
  const at = new Date(),
    repository = process.env.GITHUB_REPOSITORY,
    repositoryId = process.env.GITHUB_REPOSITORY_ID
  if (full || !cacheAllowed(at) || !repository || !repositoryId) {
    notice('Baseline cache bypassed; all baseline tests will run fresh.')
    return false
  }
  const identity = baselineIdentity(root, comparison.base, at)
  try {
    const response = api(repository, 'actions/workflows/ci.yml/runs?branch=main&status=success&per_page=20')
    for (const run of response.workflow_runs) {
      const producer = normalizeProducer(run)
      if (!trustedProducer(producer, repository, repositoryId)) continue
      const artifacts = api(repository, `actions/runs/${run.id}/artifacts?per_page=100`).artifacts
      const artifact = artifacts.find((entry) => entry.name === identity.key && !entry.expired)
      if (!artifact) continue
      try {
        rmSync(directory, { recursive: true, force: true })
        execFileSync(
          'gh',
          [
            'run',
            'download',
            String(run.id),
            '--repo',
            repository,
            '--name',
            identity.key,
            '--dir',
            directory,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: MINUTE_MS },
        )
        validateBaseline({ root, checkout, directory, identity, producer, repository, repositoryId, at })
        writeFileSync(
          join(directory, 'origin.json'),
          `${JSON.stringify({ identity, producer, repository, repositoryId })}\n`,
        )
        output('hit', 'true')
        output('key', identity.key)
        notice(
          `Verified baseline cache hit: ${identity.source}, successful main CI run ${producer.id}. Head tests and mutation proofs still run fresh.`,
        )
        return true
      } catch {
        notice('::warning::A cached baseline failed validation; it will not replace a fresh measurement.')
      }
    }
  } catch {
    notice('::warning::Baseline lookup unavailable; all baseline tests will run fresh.')
  }
  rmSync(directory, { recursive: true, force: true })
  notice('No eligible baseline cache found; all baseline tests will run fresh.')
  return false
}

export function revalidateBaseline({ root, checkout, directory }) {
  const origin = read(join(directory, 'origin.json'))
  const expected = baselineIdentity(root, origin.identity.source)
  return validateBaseline({ root, checkout, directory, ...origin, identity: expected, at: new Date() })
}

export function publishBaselines({ root, baseRoot, directory, outputDirectory, comparison }) {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) ||
    !cacheAllowed()
  ) {
    notice('Baseline publication bypassed outside an eligible main run.')
    return []
  }
  const producer = {
    id: Number(process.env.GITHUB_RUN_ID),
    head: process.env.GITHUB_SHA,
    branch: 'main',
    event: process.env.GITHUB_EVENT_NAME,
    workflow: '.github/workflows/ci.yml',
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
  }
  const result = []
  for (const [side, checkout, source] of [
    ['base', baseRoot, comparison.base],
    ['head', root, comparison.head],
  ]) {
    try {
      const packed = packBaseline({
        root,
        checkout,
        directory: join(directory, side),
        output: join(outputDirectory, side),
        producer,
      })
      if (packed.source !== source) throw new Error('Publication comparison differs')
      output(`${side}_key`, packed.key)
      result.push(packed)
      notice(
        `Validated ${side} baseline publication: ${source}. This artifact is eligible only after the entire main CI run succeeds.`,
      )
    } catch {
      notice(
        `::warning::The ${side} measurement was not eligible for baseline reuse; future runs will measure it fresh.`,
      )
    }
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, checkout, comparisonPath, directory, argument] = process.argv.slice(2)
  if (command === 'restore')
    restoreBaseline({
      root,
      checkout,
      comparison: read(comparisonPath),
      directory,
      full: argument === 'true',
    })
  else if (command === 'check') revalidateBaseline({ root, checkout, directory: comparisonPath })
  else if (command === 'publish')
    publishBaselines({
      root,
      baseRoot: checkout,
      comparison: read(comparisonPath),
      directory,
      outputDirectory: argument,
    })
  else
    throw new Error(
      'Usage: baseline-cache.mjs restore|check|publish ROOT BASE_ROOT COMPARISON DIRECTORY [ARGUMENT]',
    )
}
