// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A green Bun process cannot stand in for executed live-fleet scenarios. These proofs exercise
 * real JUnit output, the strict fleet CLI and the ordinary shard's narrow optional-skip policy.
 * Missing daemon prerequisites are reproduced against the repository's actual fleet test files.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkJUnit } from './coverage-junit.mjs'
import { liveFleet } from './evidence-policy.mjs'
import { XMLParser } from './toolchain.mjs'

const files = [...liveFleet]
const here = dirname(fileURLToPath(import.meta.url))
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const bun = process.env.QUALITY_BUN ?? 'bun'
const strict = { allowLiveFleetSkips: false }

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'quality-fleet-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, contents) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
  return target
}

function xml(file, body = '<testcase name="live contract"/>', { suite = '', root = '' } = {}) {
  return `<testsuites ${root}><testsuite file="${file}" ${suite}>${body}</testsuite></testsuites>`
}

function runGate(reports) {
  return spawnSync(process.execPath, [join(here, 'fleet-evidence.mjs'), ...reports], {
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function reports(t, first = xml(files[0]), second = xml(files[1])) {
  const root = temporary(t)
  return [write(root, 'one.xml', first), write(root, 'two.xml', second)]
}

function reject(result) {
  assert.equal(result.status, 1, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  assert.notEqual(result.stderr.trim(), '')
  assert.equal(result.stdout.trim(), '', 'rejected evidence must not emit a success attestation')
}

function bunReport(root, file, output, env = process.env) {
  const result = spawnSync(bun, ['test', '--reporter=junit', `--reporter-outfile=${output}`, `./${file}`], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  return readFileSync(output, 'utf8')
}

test('real Bun passing fleet reports produce a digest-bound attestation for both exact files', (t) => {
  const root = temporary(t)
  const output = files.map((file, index) => {
    write(
      root,
      file,
      `import { describe, expect, test } from 'bun:test'
describe('live contract fixture', () => {
  test('state transition preserves its value', () => {
    const state = new Map([['node', ${index + 1}]])
    expect(state.get('node')).toBe(${index + 1})
  })
})`,
    )
    const path = join(root, `${index}.xml`)
    bunReport(root, file, path)
    return path
  })
  const result = runGate(output)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.passed, true)
  assert.deepEqual(
    evidence.reports,
    output.map((reportPath, index) => ({
      testFile: files[index],
      reportPath,
      sha256: createHash('sha256').update(readFileSync(reportPath)).digest('hex'),
      executed: 1,
    })),
  )
})

test('real Bun exits successfully for a skipped fleet case but the strict CLI rejects it', (t) => {
  const root = temporary(t)
  const output = files.map((file, index) => {
    write(
      root,
      file,
      `import { expect, test } from 'bun:test'
test${index === 0 ? '.skip' : ''}('live contract', () => {
  expect(new Set(['node']).has('node')).toBe(true)
})`,
    )
    const path = join(root, `${index}.xml`)
    bunReport(root, file, path)
    return path
  })
  const result = runGate(output)
  reject(result)
  assert.match(result.stderr, /skip/i)
})

test('strict mode rejects live-fleet skips while ordinary shards retain their exact allowlist', () => {
  const mixed = xml(files[0], '<testcase name="executed"/><testcase name="optional"><skipped/></testcase>')
  assert.equal(checkJUnit(mixed, [files[0]]), 1)
  assert.throws(() => checkJUnit(mixed, [files[0]], strict), /skip/i)
  const optional = xml(files[0], '<testcase name="optional"><skipped/></testcase>')
  assert.equal(checkJUnit(optional, [files[0]], { allowOptionalOnly: true }), 0)
  assert.throws(() => checkJUnit(optional, [files[0]], { ...strict, allowOptionalOnly: true }), /skip/i)
  assert.throws(
    () =>
      checkJUnit(xml('other.test.ts', '<testcase name="optional"><skipped/></testcase>'), ['other.test.ts'], {
        allowOptionalOnly: true,
      }),
    /skip/i,
  )
})

test('nested live-fleet suites inherit file identity and retain strict status enforcement', () => {
  const nested = (body) =>
    xml(files[0], `<testsuite name="outer"><testsuite name="inner">${body}</testsuite></testsuite>`)
  assert.equal(checkJUnit(nested('<testcase name="contract"/>'), [files[0]], strict), 1)
  for (const status of ['failure', 'error', 'skipped']) {
    assert.throws(
      () => checkJUnit(nested(`<testcase name="contract"><${status}/></testcase>`), [files[0]], strict),
      /Failed|skip/i,
    )
  }
})

const invalidReports = {
  malformed: () => '<testsuites>',
  'missing suite': () => '<testsuites/>',
  'missing file identity': () =>
    '<testsuites><testsuite><testcase name="contract"/></testsuite></testsuites>',
  'wrong file identity': () => xml('apps/control/src/infra/fleet/wrong.test.ts'),
  'wrong testcase identity': () => xml(files[0], `<testcase name="contract" file="${files[1]}"/>`),
  'zero executed cases': () => xml(files[0], ''),
  'failure element': () => xml(files[0], '<testcase name="contract"><failure/></testcase>'),
  'error element': () => xml(files[0], '<testcase name="contract"><error/></testcase>'),
  'skipped element': () => xml(files[0], '<testcase name="contract"><skipped/></testcase>'),
}

for (const [name, invalid] of Object.entries(invalidReports)) {
  test(`fleet CLI rejects ${name}`, (t) => {
    reject(runGate(reports(t, invalid())))
  })
}

for (const level of ['root', 'suite']) {
  for (const status of ['failures', 'errors', 'skipped']) {
    test(`strict evidence rejects ${level} attribute-only ${status}`, (t) => {
      const document = xml(files[0], '<testcase name="apparently passing"/>', { [level]: `${status}="1"` })
      assert.throws(() => checkJUnit(document, [files[0]], strict))
      reject(runGate(reports(t, document)))
    })
  }
}

test('strict evidence rejects malformed or negative summary counts', (t) => {
  for (const value of ['-1', 'NaN', 'false', '']) {
    const document = xml(files[0], '<testcase name="contract"/>', { root: `skipped="${value}"` })
    assert.throws(() => checkJUnit(document, [files[0]], strict))
    reject(runGate(reports(t, document)))
  }
})

test('strict evidence rejects suite-level errors outside test cases', (t) => {
  for (const status of ['error', 'failure']) {
    const document = xml(files[0], `<${status}/><testcase name="contract"/>`)
    assert.throws(() => checkJUnit(document, [files[0]], strict), /Failed/)
    reject(runGate(reports(t, document)))
  }
})

test('fleet CLI rejects missing, extra, duplicate and reversed report arguments', (t) => {
  const output = reports(t)
  for (const supplied of [
    [],
    [output[0]],
    [...output, output[1]],
    [output[0], output[0]],
    [...output].reverse(),
  ])
    reject(runGate(supplied))
  reject(runGate([join(dirname(output[0]), 'absent.xml'), output[1]]))
  writeFileSync(output[1], readFileSync(output[0]))
  reject(runGate(output))
})

test('actual fleet suites without daemon prerequisites stay green in Bun and fail the evidence gate', (t) => {
  const root = temporary(t)
  const env = {
    ...process.env,
    BLOCKLYD_BIN: '',
    BLOCKLYD_STATIC_BIN: '',
    DATABASE_URL: '',
    S3_TEST_ENDPOINT: '',
  }
  let skipped = 0
  const output = files.map((file, index) => {
    const path = join(root, `${index}.xml`)
    const document = bunReport(checkout, file, path, env)
    const summary = new XMLParser({ ignoreAttributes: false }).parse(document).testsuites
    const count = Number(summary['@_skipped'])
    assert.ok(count > 0, `${file} must reproduce an actually skipped live suite`)
    assert.equal(Number(summary['@_tests']), count)
    assert.equal(checkJUnit(document, [file], { allowOptionalOnly: true }), 0)
    skipped += count
    return path
  })
  reject(runGate(output))
  t.diagnostic(`Actual Bun execution reported ${skipped} skipped live-fleet cases and zero executed cases`)
})
