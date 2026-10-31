// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Git fixtures exercise additive eligibility and retain evidence when old test oracles change. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'
import { analyzeTestImpact } from './test-impact.mjs'

const subject = 'apps/a/src/subject.ts'
const originalTest = 'apps/a/src/subject.test.ts'
const addedTest = 'apps/a/src/subject.quality.test.ts'
const other = 'apps/a/src/other.ts'
const strong =
  "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; test('boundary', () => expect(choose(11)).toBe(10))\n"
const weak =
  "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; test('exists', () => expect(choose(11)).toBeDefined())\n"

function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-test-impact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/hooks')
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const save = () => {
    git('add', '-A')
    git('commit', '-q', '--no-gpg-sign', '-m', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  const files = {
    'package.json': '{"name":"quality-fixture","type":"module"}',
    'apps/a/package.json': '{"name":"@blockly/a","type":"module","exports":"./src/subject.ts"}',
    'apps/a/src/main.ts': "import { choose } from './subject.ts'; export const result = choose(2)\n",
    [subject]: 'export const choose = (value: number) => value > 10 ? 10 : value\n',
    [other]: 'export const different = (value: number) => value === 0\n',
    [originalTest]: strong,
    ...extra,
  }
  for (const [path, text] of Object.entries(files)) write(path, text)
  const baseSha = save()
  const changed = () =>
    git('diff', '--name-only', '--no-renames', '-z', baseSha, 'HEAD').split('\0').filter(Boolean)
  const analyze = () => analyzeTestImpact({ root, baseSha, changedFiles: changed() })
  const scope = () => {
    const entries = inventory(root)
    return selectMutationScope({
      root,
      baseSha,
      headSha: git('rev-parse', 'HEAD'),
      changedFiles: changed(),
      productionFiles: sourceFiles(entries),
      testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
    })
  }
  return { root, git, write, save, baseSha, changed, analyze, scope }
}

const dynamicTest = 'apps/a/src/guides.test.ts'
const newSubject = 'apps/a/src/new-subject.ts'
const newTest = 'apps/a/src/new-subject.test.ts'
const assets = {
  'apps/a/src/expected.json': '{"limit":10}',
  'apps/a/src/styles.css': '.contract { color: green }',
}
const guideLoader = `import { test } from 'bun:test'; test('guide', async () => import(\`./guides/\${process.env.GUIDE}/page.ts\`))\n`
const newSource = 'export const advance = (value: number) => value >= 10 ? 10 : value + 1\n'
const newContract =
  "import { expect, test } from 'bun:test'; import { advance } from './new-subject.ts'; test('cap', () => expect(advance(11)).toBe(10))\n"

test('Git-bound new source stays incremental beside unchanged static asset imports', (t) => {
  const f = fixture(t, {
    ...assets,
    [originalTest]: `${strong}import expected from './expected.json'; import './styles.css';\n`,
  })
  f.write(newSubject, newSource)
  f.write(newTest, newContract)
  const head = f.save()
  const scope = f.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, [newSubject])
  assert.deepEqual(scope.testsByFile[newSubject], [newTest])
  assert.deepEqual(scope.testImpact.verifiedAddedTests, [newTest])
  assert.equal(scope.testImpact.base, f.baseSha)
  assert.equal(scope.testImpact.head, head)
  assert.deepEqual(scope.testImpact.verifiedChangedFiles, [newTest, newSubject].sort())
})

test('new source retains full fallback beside an unchanged unknown loader', (t) => {
  const f = fixture(t, {
    ...assets,
    [originalTest]: `${strong}import expected from './expected.json'; import './styles.css';\n`,
    [dynamicTest]: guideLoader,
    'apps/a/src/guides/first/page.ts': 'export const page = () => "first"\n',
  })
  f.write(newSubject, newSource)
  f.write(newTest, newContract)
  f.save()
  const scope = f.scope()
  assert.equal(scope.full, true)
  assert.ok(scope.subjects.includes(newSubject))
  assert.ok(scope.subjects.includes(subject))
  assert.ok(scope.additionalTestsByFile[newSubject].flat().includes(dynamicTest))
  const ambiguities = scope.reasons.filter((reason) => reason.includes('ambiguous'))
  assert.equal(ambiguities.length, 2)
  assert.ok(ambiguities.every((reason) => reason.endsWith(dynamicTest)))
})

test('existing production changes retain full fallback when unknown loaders may also use them as oracles', (t) => {
  const f = fixture(t, { [dynamicTest]: guideLoader })
  f.write(subject, 'export const choose = (value: number) => value >= 10 ? 10 : value\n')
  f.save()
  const scope = f.scope()
  assert.equal(scope.full, true)
  assert.ok(scope.subjects.includes(subject))
  assert.ok(scope.subjects.includes(other))
  assert.ok(scope.additionalTestsByFile[subject].flat().includes(dynamicTest))
})

test('static non-code imports preserve base resolution for an edited test', (t) => {
  const f = fixture(t, {
    ...assets,
    [originalTest]: `${strong}import expected from './expected.json'; import './styles.css';\n`,
  })
  f.write(originalTest, `${weak}import expected from './expected.json'; import './styles.css';\n`)
  f.save()
  const scope = f.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, [subject])
  assert.equal(
    scope.reasons.some((reason) => reason.includes('ambiguous')),
    false,
  )
})

test('an unresolved static resource in a touched test is not invented by the base snapshot', (t) => {
  const f = fixture(t, { [originalTest]: `${strong}import './missing.css';\n` })
  f.write(originalTest, weak)
  f.save()
  assert.equal(f.scope().full, true)
})

for (const change of ['edit', 'delete']) {
  test(`an ambiguous test ${change} retains full obligations beside new source`, (t) => {
    const f = fixture(t, { [dynamicTest]: guideLoader })
    if (change === 'delete') rmSync(join(f.root, dynamicTest))
    else
      f.write(
        dynamicTest,
        "import { test, expect } from 'bun:test'; test('weakened', () => expect(true).toBe(true))\n",
      )
    f.write(newSubject, newSource)
    f.write(newTest, newContract)
    f.save()
    const scope = f.scope()
    assert.equal(scope.full, true)
    assert.ok(scope.subjects.includes(other), 'unknown edited/deleted tests cannot hide old subjects')
  })
}

test('an existing oracle change retains unknown-loader obligations even beside new source', (t) => {
  const helper = 'apps/a/src/assertions.ts'
  const f = fixture(t, {
    [helper]: 'export const matches = (value: number) => value === 10\n',
    [originalTest]:
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; import { matches } from './assertions.ts'; test('boundary', () => expect(matches(choose(11))).toBe(true))\n",
    [dynamicTest]: guideLoader,
  })
  f.write(helper, 'export const matches = (_value: number) => true\n')
  f.write(newSubject, newSource)
  f.write(newTest, newContract)
  f.save()
  const scope = f.scope()
  assert.equal(scope.full, true)
  assert.ok(scope.subjects.includes(subject))
  assert.match(scope.reasons.join('\n'), /ambiguous base test dependencies after executable changes/)
})

for (const shared of [false, true]) {
  test(`a dynamically loaded existing oracle cannot hide subject defects${shared ? ' even with production and direct test imports' : ''}`, (t) => {
    const helper = 'apps/a/src/oracle.ts'
    const direct = 'apps/a/src/oracle.test.ts'
    const oracle = 'export const matches = (value: number) => value === 10\n'
    const dynamic =
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; test('boundary', async () => { const name = ['or', 'acle'].join(''); const { matches } = await import('./' + name + '.ts'); expect(matches(choose(11))).toBe(true) })\n"
    const f = fixture(t, {
      [helper]: oracle,
      [originalTest]: dynamic,
      ...(shared
        ? {
            'apps/a/src/main.ts':
              "import { choose } from './subject.ts'; import { matches } from './oracle.ts'; export const result = matches(choose(2))\n",
            [direct]:
              "import { expect, test } from 'bun:test'; import { matches } from './oracle.ts'; test('exists', () => expect(matches(10)).toBeDefined())\n",
          }
        : {}),
    })
    f.write(helper, 'export const matches = (_value: number) => true\n')
    f.write(newSubject, newSource)
    f.write(newTest, newContract)
    f.save()
    const scope = f.scope()
    assert.equal(scope.full, true)
    assert.ok(scope.subjects.includes(subject))
    assert.ok(scope.subjects.includes(helper))
    assert.match(scope.reasons.join('\n'), /ambiguous base test dependencies after executable changes/)
    const run = () =>
      spawnSync(
        process.env.QUALITY_BUN ?? 'bun',
        ['test', `./${originalTest}`, ...(shared ? [`./${direct}`] : [])],
        {
          cwd: f.root,
          encoding: 'utf8',
          timeout: 30 * SECOND_MS,
        },
      )
    f.write(subject, 'export const choose = (value: number) => value\n')
    f.write(helper, oracle)
    const baseline = run()
    assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr)
    f.write(helper, 'export const matches = (_value: number) => true\n')
    const weakened = run()
    assert.equal(weakened.status, 0, weakened.stdout + weakened.stderr)
    f.write(helper, 'export const matches = (_value: number) => false\n')
    const mutant = run()
    assert.equal(mutant.status, 1, mutant.stdout + mutant.stderr)
  })
}

test('adding a dynamically loaded oracle can weaken an unchanged fallback and retains full scope', (t) => {
  const helper = 'apps/a/src/oracle.ts'
  const f = fixture(t, {
    [originalTest]:
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; test('boundary', async () => { const name = ['or', 'acle'].join(''); const { matches } = await import('./' + name + '.ts').catch(() => ({ matches: (value: number) => value === 10 })); expect(matches(choose(11))).toBe(true) })\n",
  })
  f.write(helper, 'export const matches = (_value: number) => true\n')
  f.save()
  const scope = f.scope()
  assert.equal(scope.full, true)
  assert.ok(scope.subjects.includes(subject))
  assert.ok(scope.subjects.includes(helper))
  const run = () =>
    spawnSync(process.env.QUALITY_BUN ?? 'bun', ['test', `./${originalTest}`], {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 30 * SECOND_MS,
    })
  f.write(subject, 'export const choose = (value: number) => value\n')
  rmSync(join(f.root, helper))
  const baseline = run()
  assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr)
  f.write(helper, 'export const matches = (_value: number) => true\n')
  const weakened = run()
  assert.equal(weakened.status, 0, weakened.stdout + weakened.stderr)
  f.write(helper, 'export const matches = (_value: number) => false\n')
  const mutant = run()
  assert.equal(mutant.status, 1, mutant.stdout + mutant.stderr)
})

test('new source cannot hide changed oracle data or runner configuration', (t) => {
  for (const [path, value] of [
    ['apps/a/src/expected.json', '{"limit":11}'],
    ['bunfig.toml', '[test]\npreload = ["./oracle.ts"]\n'],
  ]) {
    const f = fixture(t, assets)
    f.write(path, value)
    f.write(newSubject, newSource)
    f.write(newTest, newContract)
    f.save()
    assert.equal(f.scope().full, true, path)
  }
})

test('non-code symlinks cannot masquerade as committed regular dependency inputs', (t) => {
  const f = fixture(t, assets)
  rmSync(join(f.root, 'apps/a/src/styles.css'))
  symlinkSync('subject.ts', join(f.root, 'apps/a/src/styles.css'))
  f.write(newSubject, newSource)
  f.write(newTest, newContract)
  f.save()
  assert.throws(() => f.analyze(), /regular file/)
})

test('a true addition preserves original tests and does not certify legacy mutation coverage', (t) => {
  const f = fixture(t)
  f.write(addedTest, weak)
  f.save()
  const impact = f.analyze()
  assert.deepEqual([...impact.verifiedAddedTests], [addedTest])
  assert.deepEqual([...impact.baseRequiredSubjects], [])
  assert.equal(impact.baseFull, false)
  assert.deepEqual(
    impact.unchangedTestManifest.map((entry) => entry.path),
    [originalTest],
  )
  assert.match(impact.unchangedTestManifest[0].sha256, /^[a-f0-9]{64}$/)
  assert.ok(impact.preservedInputs.some((entry) => entry.path === subject))
  assert.deepEqual(impact.evidence.verifiedAddedTests, [addedTest])
})

test('new tests never suppress an independent production change', (t) => {
  const f = fixture(t)
  f.write(addedTest, weak)
  f.write(subject, 'export const choose = (value: number) => value\n')
  f.save()
  const impact = f.analyze()
  assert.ok(impact.verifiedAddedTests.has(addedTest))
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.ok(impact.requiredChangedFiles.includes(subject))
})

test('an edited test retains imports removed from its proposed body', (t) => {
  const f = fixture(t)
  f.write(
    originalTest,
    "import { expect, test } from 'bun:test'; import { different } from './other.ts'; test('other', () => expect(different(0)).toBe(true))\n",
  )
  f.save()
  const impact = f.analyze()
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.ok(impact.baseRequiredSubjects.has(other))
  assert.equal(impact.verifiedAddedTests.size, 0)
  assert.equal(impact.unchangedTestManifest.length, 0)
})

test('replacing an existing test with a superficial assertion is never an addition', (t) => {
  const f = fixture(t)
  f.write(
    originalTest,
    "import { test, expect } from 'bun:test'; test('green', () => expect(true).toBe(true))\n",
  )
  f.save()
  const impact = f.analyze()
  assert.equal(impact.verifiedAddedTests.size, 0)
  assert.ok(impact.baseRequiredSubjects.has(subject))
})

test('a renamed or deleted test cannot be laundered through a new filename', (t) => {
  const f = fixture(t)
  rmSync(join(f.root, originalTest))
  f.write(addedTest, weak)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.verifiedAddedTests.size, 0)
  assert.equal(impact.baseFull, false)
  assert.ok(impact.mappedRemovedTests.has(originalTest))
  assert.deepEqual(impact.evidence.mappedRemovedTests, [originalTest])
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.match(impact.reasons.join('\n'), /removed or renamed/)
})

test('a removed test with no known production subjects retains the full fallback', (t) => {
  const f = fixture(t, {
    [originalTest]: "import { test, expect } from 'bun:test'; test('empty', () => expect(true).toBe(true))\n",
  })
  rmSync(join(f.root, originalTest))
  f.write(addedTest, strong)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.equal(impact.mappedRemovedTests.size, 0)
  assert.equal(impact.verifiedAddedTests.size, 0)
})

test('a removed test with both known and ambiguous imports retains the full fallback', (t) => {
  const f = fixture(t, {
    [originalTest]: `${strong}test('dynamic', async () => import(process.env.TARGET))\n`,
  })
  rmSync(join(f.root, originalTest))
  f.write(addedTest, weak)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.equal(impact.mappedRemovedTests.size, 0)
  assert.ok(impact.baseRequiredSubjects.has(subject))
})

test('one fully mapped deletion cannot waive another deletion with unknown subjects', (t) => {
  const empty = 'apps/a/src/empty.test.ts'
  const f = fixture(t, {
    [empty]: "import { test, expect } from 'bun:test'; test('empty', () => expect(true).toBe(true))\n",
  })
  rmSync(join(f.root, originalTest))
  rmSync(join(f.root, empty))
  f.write(addedTest, strong)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.deepEqual([...impact.mappedRemovedTests], [originalTest])
  assert.equal(impact.verifiedAddedTests.size, 0)
})

test('removing production source cannot leave only a verified test addition', (t) => {
  const f = fixture(t)
  rmSync(join(f.root, other))
  f.write(addedTest, strong)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.ok(impact.removedProductionFiles.has(other))
})

test('a changed assertion helper retains the subject of unchanged tests', (t) => {
  const helper = 'apps/a/src/assertions.ts'
  const f = fixture(t, {
    [helper]: 'export const matches = (value: number) => value === 10\n',
    [originalTest]:
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; import { matches } from './assertions.ts'; test('boundary', () => expect(matches(choose(11))).toBe(true))\n",
  })
  f.write(helper, 'export const matches = (_value: number) => true\n')
  f.write(addedTest, weak)
  f.save()
  const impact = f.analyze()
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.ok(impact.baseRequiredSubjects.has(helper))
  assert.ok(impact.affectedExistingTests.includes(originalTest))
  assert.ok(impact.requiredChangedFiles.includes(helper))
})

test('support imported through another helper also propagates test obligations', (t) => {
  const helper = 'apps/a/src/oracle.ts'
  const f = fixture(t, {
    [helper]: 'export const matches = (value: number) => value === 10\n',
    'apps/a/src/assertions.ts': "export { matches } from './oracle.ts'\n",
    [originalTest]:
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; import { matches } from './assertions.ts'; test('boundary', () => expect(matches(choose(11))).toBe(true))\n",
  })
  f.write(helper, 'export const matches = (_value: number) => true\n')
  f.save()
  assert.ok(f.analyze().baseRequiredSubjects.has(subject))
})

test('a shared assertion-library helper retains its test impact even after dropping that import', (t) => {
  const helper = 'apps/a/src/assertions.ts'
  const f = fixture(t, {
    [helper]:
      "import { strict as assert } from 'node:assert'; export const matches = (value: number) => { assert.equal(value, 10); return true }\n",
    'apps/a/src/main.ts': "import { matches } from './assertions.ts'; export const status = matches(10)\n",
    [originalTest]:
      "import { expect, test } from 'bun:test'; import { choose } from './subject.ts'; import { matches } from './assertions.ts'; test('boundary', () => expect(matches(choose(11))).toBe(true))\n",
  })
  f.write(helper, 'export const matches = (_value: number) => true\n')
  f.save()
  const impact = f.analyze()
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.ok(impact.affectedExistingTests.includes(originalTest))
})

test('ordinary production changes do not automatically expand through every importing test', (t) => {
  const f = fixture(t, {
    [originalTest]: `${strong}import { different } from './other.ts'; test('other', () => expect(different(0)).toBe(true))\n`,
  })
  f.write(subject, 'export const choose = (value: number) => value >= 10 ? 10 : value\n')
  f.save()
  const impact = f.analyze()
  assert.ok(impact.baseRequiredSubjects.has(subject))
  assert.equal(impact.baseRequiredSubjects.has(other), false)
})

test('changing a fixture forces conservative scope even beside an added test', (t) => {
  const path = 'apps/a/fixtures/expected.json'
  const f = fixture(t, { [path]: '{"expected":10}' })
  f.write(path, '{"expected":11}')
  f.write(addedTest, weak)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.ok(impact.requiredChangedFiles.includes(path))
  assert.match(impact.reasons.join('\n'), /fixture or data input/)
})

test('changed dependencies or runner configuration cannot be waived by added tests', (t) => {
  const f = fixture(t)
  f.write('bunfig.toml', '[test]\npreload = ["./disable.ts"]\n')
  f.write(addedTest, weak)
  f.save()
  assert.equal(f.analyze().baseFull, true)
})

test('verified isolated quality dependencies retain their exact comparator exemption', (t) => {
  const manifest = { name: 'quality-fixture', type: 'module', devDependencies: {} }
  const lock = {
    lockfileVersion: 3,
    configVersion: 1,
    workspaces: { '': { name: 'quality-fixture', devDependencies: {} } },
    packages: {},
  }
  const f = fixture(t, { 'package.json': JSON.stringify(manifest), 'bun.lock': JSON.stringify(lock) })
  manifest.devDependencies['fast-check'] = '4.3.0'
  lock.workspaces[''].devDependencies['fast-check'] = '4.3.0'
  lock.packages['fast-check'] = ['fast-check@4.3.0', '', {}, 'sha512-quality']
  f.write('package.json', JSON.stringify(manifest))
  f.write('bun.lock', JSON.stringify(lock))
  f.write(addedTest, strong)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, false)
  assert.deepEqual(impact.verifiedQualityOnlyConfigs, ['bun.lock', 'package.json'])
})

test('ambiguous old imports remain full scope after they disappear from the new test', (t) => {
  const f = fixture(t, {
    [originalTest]:
      "import { test } from 'bun:test'; test('dynamic', async () => import(process.env.TARGET))\n",
  })
  f.write(originalTest, strong)
  f.save()
  const impact = f.analyze()
  assert.equal(impact.baseFull, true)
  assert.match(impact.reasons.join('\n'), /ambiguous base/)
})

test('symlink tests and declaration-only files cannot receive addition evidence', (t) => {
  const f = fixture(t)
  symlinkSync('subject.test.ts', join(f.root, addedTest))
  f.save()
  assert.throws(() => f.analyze(), /regular file/)
  rmSync(join(f.root, addedTest))
  f.write(addedTest, 'export type OnlyAType = string\n')
  f.save()
  assert.throws(() => f.analyze(), /no executable test code/)
})

test('production cannot hide executable source in a new test file', (t) => {
  const f = fixture(t)
  f.write(addedTest, 'export const hidden = () => true\n')
  f.write(subject, "export { hidden as choose } from './subject.quality.test.ts'\n")
  f.save()
  assert.throws(() => f.analyze(), /imports excluded test/)
})

test('a caller cannot omit a changed input from the Git comparison', (t) => {
  const f = fixture(t)
  f.write(addedTest, strong)
  f.write(subject, 'export const choose = (_value: number) => 10\n')
  f.save()
  assert.throws(
    () => analyzeTestImpact({ root: f.root, baseSha: f.baseSha, changedFiles: [addedTest] }),
    /complete base-to-head Git diff/,
  )
})

test('head-as-base and unrelated history cannot fabricate an empty change comparison', (t) => {
  const f = fixture(t)
  f.write(addedTest, strong)
  const head = f.save()
  assert.throws(
    () => analyzeTestImpact({ root: f.root, baseSha: head, changedFiles: [] }),
    /proposed head as its base/,
  )
  f.git('checkout', '-q', '--orphan', 'unrelated')
  f.save()
  assert.throws(() => f.analyze(), /must be an ancestor/)
})

test('dirty or untracked inputs cannot borrow evidence from a clean commit', (t) => {
  const f = fixture(t)
  f.write(addedTest, strong)
  f.save()
  f.write(subject, 'export const choose = (_value: number) => 10\n')
  assert.throws(() => f.analyze(), /Working tree differs/)
  f.git('checkout', '--', subject)
  f.write('unexpected.json', '{}')
  assert.throws(() => f.analyze(), /Untracked inputs/)
})

test('base and proposed modules are only parsed, never executed for eligibility', (t) => {
  const f = fixture(t)
  const marker = join(tmpdir(), `quality-impact-never-execute-${process.pid}`)
  t.after(() => rmSync(marker, { force: true }))
  f.write(
    addedTest,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); ${strong}`,
  )
  f.save()
  assert.ok(f.analyze().verifiedAddedTests.has(addedTest))
  assert.equal(existsSync(marker), false)
})
