// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs Stryker's established JavaScript/TypeScript mutators against the existing Bun suite.
 * Per-file scores count test-case failures only: inconclusive outcomes stay in the denominator
 * as undetected; missing evidence fails closed. Each subject uses its dependent tests inside a copy with local workspace
 * links. Stryker's default node_modules symlink would otherwise test unmutated workspace code.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireQuality } from './toolchain.mjs'

const command = fileURLToPath(new URL('./mutation-command.mjs', import.meta.url))
const candidatesCommand = fileURLToPath(new URL('./mutation-candidates.mjs', import.meta.url))

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

/** No ignored files (including local credentials) are copied into executable test workspaces. */
export function mutationSnapshot(root) {
  const snapshot = mkdtempSync(join(tmpdir(), 'blockly-mutation-'))
  try {
    const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean)
    const copied = []
    for (const path of new Set(paths)) {
      const source = resolve(root, path)
      if (!inside(root, source) || !existsSync(source)) continue
      if (!lstatSync(source).isFile()) throw new Error(`Mutation input must be a regular file: ${path}`)
      const target = join(snapshot, path)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target, constants.COPYFILE_FICLONE)
      copied.push(path)
    }
    const installations = new Set([
      '.',
      ...paths.filter((path) => basename(path) === 'package.json').map(dirname),
    ])
    for (const directory of installations) {
      const modules = join(root, directory, 'node_modules')
      if (!existsSync(modules)) continue
      const destination = join(snapshot, directory, 'node_modules')
      mkdirSync(destination, { recursive: true })
      for (const entry of readdirSync(modules)) {
        if (entry.startsWith('@')) {
          mkdirSync(join(destination, entry))
          for (const name of readdirSync(join(modules, entry)))
            link(join(modules, entry, name), join(destination, entry, name))
        } else link(join(modules, entry), join(destination, entry))
      }
    }
    // Script tests inspect tracked files and HEAD. Use fresh local metadata, never the source
    // checkout's credentials, hooks, remotes or worktree pointers.
    execFileSync('git', ['init', '--quiet', '--template=', '-b', 'quality-snapshot'], { cwd: snapshot })
    execFileSync(
      'git',
      ['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
      {
        cwd: snapshot,
        input: `${copied.join('\0')}\0`,
      },
    )
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Quality gate',
        '-c',
        'user.email=quality@example.invalid',
        'commit',
        '--quiet',
        '--no-gpg-sign',
        '-m',
        'Quality gate snapshot',
      ],
      { cwd: snapshot },
    )
    return snapshot
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true })
    throw error
  }
  function link(source, destination) {
    const original = realpathSync(source)
    const target =
      inside(root, original) && !/(?:^|\/)node_modules\//.test(relative(root, original))
        ? join(snapshot, relative(root, original))
        : original
    symlinkSync(target, destination, lstatSync(original).isDirectory() ? 'dir' : 'file')
  }
}

/** Child tests receive local service settings, never deployment credentials from the executor. */
export function mutationEnvironment(env = process.env) {
  const allowed =
    /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|CI|TERM|NO_COLOR|FORCE_COLOR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|DATABASE_URL|NATS_TEST_URL|S3_TEST_[A-Z_]+|PEBBLE_TEST_URL|CHALLTESTSRV_TEST_URL|MC_ROUTER_BIN|PROPERTY_[A-Z_]+)$/
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => allowed.test(key) && value !== undefined),
  )
}

export function mutationVerdict(
  report,
  subjects,
  { threshold = 80, evidence, expectedSources, candidates } = {},
) {
  if (!report || typeof report.files !== 'object' || report.files === null)
    throw new Error('Missing mutation report files')
  if (Object.keys(report.files).some((file) => !subjects.includes(file)))
    throw new Error('Mutation report contains an unexpected source file')
  const rows = []
  for (const subject of subjects) {
    if (
      expectedSources &&
      candidates &&
      candidates[subject]?.sha256 !== createHash('sha256').update(expectedSources[subject]).digest('hex')
    ) {
      throw new Error(`${subject}: source changed after mutation candidate enumeration`)
    }
    const entry = report.files[subject]
    if (candidates?.[subject]?.count === 0 && (!entry || entry.mutants?.length === 0)) {
      rows.push({
        file: subject,
        killed: 0,
        survived: 0,
        inconclusive: 0,
        total: 0,
        score: null,
        threshold,
        passed: true,
        notApplicable: 'Pinned Stryker found no mutable expressions',
        sha256: candidates[subject].sha256,
      })
      continue
    }
    if (!entry || !Array.isArray(entry.mutants) || entry.mutants.length === 0) {
      throw new Error(`No mutation evidence for ${subject}`)
    }
    if (expectedSources && entry.source !== expectedSources[subject]) {
      throw new Error(`${subject}: mutation evidence does not match the tested source`)
    }
    if (candidates && entry.mutants.length !== candidates[subject]?.count) {
      throw new Error(`${subject}: mutation report omitted candidates`)
    }
    let killed = 0
    let survived = 0
    let inconclusive = 0
    const ids = new Set()
    for (const mutant of entry.mutants) {
      if (typeof mutant.id !== 'string' || !mutant.id || ids.has(mutant.id))
        throw new Error(`${subject}: missing or duplicate mutant identity`)
      ids.add(mutant.id)
      if (
        !['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError'].includes(
          mutant.status,
        )
      ) {
        throw new Error(`${subject}: untested mutant ${mutant.id} (${mutant.status})`)
      }
      let detected = mutant.status === 'Killed'
      let uncertain = ['Timeout', 'CompileError', 'RuntimeError'].includes(mutant.status)
      if (evidence) {
        const outcome = evidence[String(mutant.id)]
        if (!outcome) throw new Error(`${subject}: mutant ${mutant.id} lacks valid test evidence`)
        if (['runner-error', 'timeout', 'inconclusive'].includes(outcome.status)) {
          detected = false
          uncertain = true
        } else {
          const expected = mutant.status === 'Killed' ? 'test-failure' : 'passed'
          if (
            outcome.status !== expected ||
            JSON.stringify(outcome.skippedTests ?? []) !==
              JSON.stringify(evidence.baseline?.skippedTests ?? []) ||
            outcome.passed + outcome.failed === 0
          ) {
            throw new Error(`${subject}: mutant ${mutant.id} lacks valid test evidence`)
          }
        }
      }
      if (uncertain) inconclusive++
      else if (detected) killed++
      else survived++
    }
    const total = killed + survived + inconclusive
    const score = (killed / total) * 100
    rows.push({
      file: subject,
      killed,
      survived,
      inconclusive,
      total,
      score,
      threshold,
      passed: score >= threshold,
    })
  }
  return { passed: rows.every((row) => row.passed), files: rows }
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

export function runMutation({
  root,
  subjects,
  testsByFile,
  additionalTestsByFile = {},
  reportDir,
  threshold = 80,
  bun = 'bun',
  node = 'node',
  timeoutMs = 300_000,
  subjectTimeoutMs = 1_200_000,
  collectAll = false,
}) {
  if (subjects.length === 0) throw new Error('No mutation subjects; caller must prove a non-code-only change')
  for (const subject of subjects) {
    if (!collectAll && !testsByFile[subject]?.length)
      throw new Error(`No tests depend on mutation subject ${subject}`)
  }
  mkdirSync(reportDir, { recursive: true })
  rmSync(join(reportDir, 'summary.json'), { force: true })
  const candidateInput = join(reportDir, 'candidate-input.json')
  const candidateOutput = join(reportDir, 'candidates.json')
  writeFileSync(candidateInput, JSON.stringify({ root, subjects, output: candidateOutput }))
  execFileSync(node, [candidatesCommand, candidateInput], { env: mutationEnvironment(), timeout: 300_000 })
  const candidates = JSON.parse(readFileSync(candidateOutput, 'utf8'))
  const snapshot = mutationSnapshot(root)
  const result = { passed: true, complete: false, files: [], failures: [] }
  try {
    const cli = join(dirname(requireQuality.resolve('@stryker-mutator/core/package.json')), 'bin/stryker.js')
    for (const [index, subject] of subjects.entries()) {
      try {
        if (!testsByFile[subject]?.length) throw new Error(`No tests depend on mutation subject ${subject}`)
        const outputRoot = join(reportDir, String(index))
        const batches = additionalTestsByFile[subject] ?? []
        if (
          !Array.isArray(batches) ||
          batches.some(
            (batch) =>
              !Array.isArray(batch) || batch.length === 0 || batch.some((test) => typeof test !== 'string'),
          )
        )
          throw new Error(`${subject}: invalid dependent-test expansion plan`)
        const selectedTests = [...new Set(testsByFile[subject])]
        const planned = new Set(selectedTests)
        for (const batch of batches) {
          if (!batch.some((test) => !planned.has(test)))
            throw new Error(
              `${subject}: mutation expansion must add dependent tests, not retry the same suite`,
            )
          for (const test of batch) planned.add(test)
        }
        const attempts = []
        const started = Date.now()
        let verdict
        let runStatus
        for (let attempt = 0; attempt <= batches.length; attempt++) {
          if (attempt > 0) {
            for (const test of batches[attempt - 1]) {
              if (!selectedTests.includes(test)) selectedTests.push(test)
            }
          }
          // Every expansion starts from the same source and runs the complete independent
          // candidate census again. Scores and kills are never spliced across different suites.
          copyFileSync(join(root, subject), join(snapshot, subject), constants.COPYFILE_FICLONE)
          const output = attempt === 0 ? outputRoot : join(outputRoot, `expanded-${attempt}`)
          rmSync(output, { recursive: true, force: true })
          mkdirSync(output, { recursive: true })
          const evidenceDir = join(output, 'evidence')
          const manifestPath = join(output, 'tests.json')
          writeFileSync(
            manifestPath,
            JSON.stringify({ tests: selectedTests, evidence: evidenceDir, bun, timeoutMs }),
          )
          const reportPath = join(output, 'mutation.json')
          const configPath = join(output, 'stryker.config.json')
          writeFileSync(
            configPath,
            JSON.stringify({
              testRunner: 'command',
              commandRunner: { command: `${quote(node)} ${quote(command)} ${quote(manifestPath)}` },
              // Backslashes are normalized as separators by Stryker. Character classes preserve
              // literal Next route brackets without allowing the filename to become a glob.
              mutate: [subject.replace(/[?*[\]{}()!+@]/g, (character) => `[${character}]`)],
              coverageAnalysis: 'off',
              concurrency: 1,
              inPlace: true,
              symlinkNodeModules: false,
              incremental: false,
              ignoreStatic: false,
              disableTypeChecks: false,
              reporters: ['json', 'clear-text'],
              jsonReporter: { fileName: reportPath },
              thresholds: { high: threshold, low: threshold, break: threshold },
              timeoutMS: 5000,
              timeoutFactor: 1.5,
              dryRunTimeoutMinutes: Math.ceil(timeoutMs / 60_000),
              tempDirName: join(snapshot, '.stryker-tmp'),
              cleanTempDir: 'always',
            }),
          )
          const remainingMs = subjectTimeoutMs - (Date.now() - started)
          if (remainingMs <= 0) throw new Error(`${subject}: mutation expansion exhausted its time budget`)
          const run = spawnSync(node, [cli, 'run', configPath], {
            cwd: snapshot,
            env: mutationEnvironment(),
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: remainingMs,
            detached: process.platform !== 'win32',
          })
          writeFileSync(join(output, 'stryker.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
          if (run.error || run.signal) {
            if (process.platform !== 'win32' && run.pid) {
              try {
                process.kill(-run.pid, 'SIGKILL')
              } catch (error) {
                if (error.code !== 'ESRCH') throw error
              }
            }
            throw new Error(`${subject}: Stryker failed to finish (${run.error ?? run.signal})`)
          }
          if (!existsSync(reportPath))
            throw new Error(`${subject}: Stryker produced no report; see ${join(output, 'stryker.log')}`)
          const evidence = Object.fromEntries(
            readdirSync(evidenceDir)
              .filter((file) => file.endsWith('.json'))
              .map((file) => [
                basename(file, '.json'),
                JSON.parse(readFileSync(join(evidenceDir, file), 'utf8')),
              ]),
          )
          if (evidence.baseline?.status !== 'passed')
            throw new Error(`${subject}: clean mutation baseline did not pass`)
          const report = JSON.parse(readFileSync(reportPath, 'utf8'))
          for (const mutant of report.files[subject]?.mutants ?? []) {
            if (!evidence[mutant.id] && ['Timeout', 'CompileError', 'RuntimeError'].includes(mutant.status)) {
              const outcome = {
                status: 'inconclusive',
                reportedBy: 'Stryker',
                reportedStatus: mutant.status,
                reason: mutant.statusReason ?? 'The test runner did not produce a conclusive outcome',
                passed: 0,
                failed: 0,
                skipped: 0,
              }
              evidence[mutant.id] = outcome
              writeFileSync(join(evidenceDir, `${mutant.id}.json`), JSON.stringify(outcome))
            }
          }
          verdict = mutationVerdict(report, [subject], {
            threshold,
            evidence,
            expectedSources: { [subject]: readFileSync(join(root, subject), 'utf8') },
            candidates,
          })
          const row = verdict.files[0]
          attempts.push({
            tests: [...selectedTests],
            report: relative(reportDir, reportPath),
            score: row.score,
            killed: row.killed,
            total: row.total,
            exitCode: run.status,
          })
          writeFileSync(join(outputRoot, 'attempts.json'), JSON.stringify(attempts, null, 2))
          runStatus = run.status
          if (verdict.passed || attempt === batches.length) break
          if (run.status !== 0 && run.status !== 1)
            throw new Error(`${subject}: Stryker failed before mutation expansion (exit ${run.status})`)
          process.stdout.write(
            `${subject}: ${row.score?.toFixed(1) ?? 'N/A'}% with ${selectedTests.length} tests; expanding existing dependent tests\n`,
          )
        }
        result.files.push(
          ...verdict.files.map((row) => ({
            ...row,
            attempts: attempts.length,
            testCount: selectedTests.length,
          })),
        )
        result.passed &&= verdict.passed && runStatus === 0
        writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(result, null, 2))
        const row = verdict.files[0]
        process.stdout.write(
          row.score === null
            ? `${subject}: ${row.notApplicable}; baseline passed\n`
            : `${subject}: ${row.killed}/${row.total} killed (${row.score.toFixed(1)}%, required ${threshold}%; ${row.inconclusive} inconclusive)\n`,
        )
        if (!verdict.passed || runStatus !== 0)
          throw new Error(
            `${subject}: mutation score ${row.score?.toFixed(1) ?? 'N/A'}% is below ${threshold}% or Stryker failed`,
          )
      } catch (error) {
        result.passed = false
        result.failures.push({ file: subject, error: String(error) })
        writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(result, null, 2))
        if (!collectAll) throw error
        process.stderr.write(`${error}\n`)
      } finally {
        // A timed-out Stryker cannot perform its normal in-place restoration.
        copyFileSync(join(root, subject), join(snapshot, subject), constants.COPYFILE_FICLONE)
      }
    }
    result.complete = true
    writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(result, null, 2))
    if (!result.passed)
      throw new Error(
        `Mutation quality failed for ${result.failures.length} files; see ${join(reportDir, 'summary.json')}`,
      )
    return result
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
}
