// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Framework entries stay production when a new integration test imports them. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'

const other = 'apps/control/src/other.ts'
const originalTest = 'apps/control/src/other.test.ts'
const addedTest = 'apps/control/src/framework.test.ts'
const pageSource = (n) => `export default function Page() { return ${n} }\n`
const routeSource = (n) => `export function GET() { return Response.json({ value: ${n} }) }\n`

function fixture(t, entry, source, named = false) {
  const root = mkdtempSync(join(tmpdir(), 'framework-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const save = () => {
    git('add', '-A')
    git('commit', '-q', '--no-gpg-sign', '-m', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/hooks')
  write('package.json', '{"private":true,"type":"module","workspaces":["apps/*"]}')
  write('apps/control/package.json', '{"name":"control-fixture","type":"module"}')
  write('apps/web/package.json', '{"name":"web-fixture","type":"module","dependencies":{"next":"16.4.2"}}')
  write(other, 'export const unrelated = () => 2\n')
  write(
    'apps/control/src/main.ts',
    "import {unrelated} from './other.ts'; export const result = unrelated()\n",
  )
  write(
    originalTest,
    "import {expect,test} from 'bun:test'; import {unrelated} from './other.ts'; test('original',()=>expect(unrelated()).toBe(2))\n",
  )
  write(entry, source(1))
  const baseSha = save()
  write(entry, source(2))
  let imported = relative(dirname(addedTest), entry)
  if (!imported.startsWith('.')) imported = `./${imported}`
  write(
    addedTest,
    `import {expect,test} from 'bun:test'; import ${named ? '{GET as entry}' : 'entry'} from '${imported}'; import {unrelated} from './other.ts'; test('integration',()=>{expect(entry()).toBeDefined();expect(unrelated()).toBe(2)})\n`,
  )
  return {
    write,
    scope() {
      const headSha = save()
      const entries = inventory(root)
      return selectMutationScope({
        root,
        baseSha,
        headSha,
        changedFiles: git('diff', '--name-only', baseSha, headSha).split('\n'),
        productionFiles: sourceFiles(entries),
        testFiles: entries.filter((item) => item.kind === 'test').map((item) => item.path),
      })
    },
  }
}

for (const [entry, source, named] of [
  ['apps/web/src/app/(app)/servers/[id]/mods/page.tsx', pageSource, false],
  ['apps/web/src/app/api/game/route.ts', routeSource, true],
])
  test(`a public entry retains its own obligations: ${entry}`, (t) => {
    const scope = fixture(t, entry, source, named).scope()
    assert.equal(scope.full, false)
    assert.deepEqual(scope.subjects, [entry])
    assert.deepEqual(scope.testsByFile[entry], [addedTest])
    assert.ok(!scope.reasons.some((reason) => reason.includes('potential test support')))
  })

for (const entry of ['apps/web/src/app/_fixtures/page.tsx', 'apps/control/src/page.tsx'])
  test(`a private or non-framework lookalike remains support: ${entry}`, (t) => {
    const scope = fixture(t, entry, pageSource).scope()
    assert.ok(scope.subjects.includes(entry))
    assert.ok(scope.subjects.includes(other))
    assert.ok(scope.reasons.some((reason) => reason.includes('potential test support')))
  })

test('a framework filename cannot hide an assertion helper', (t) => {
  const source = (n) =>
    `import {equal} from 'node:assert/strict'; export default function Page(){equal(1,1);return ${n}}\n`
  const scope = fixture(t, 'apps/web/src/app/claims/page.tsx', source).scope()
  assert.ok(scope.subjects.includes(other))
})

test('editing an old oracle retains its old dependencies', (t) => {
  const entry = 'apps/web/src/app/game/page.tsx'
  const f = fixture(t, entry, pageSource)
  f.write(
    originalTest,
    "import {expect,test} from 'bun:test'; import {unrelated} from './other.ts'; test('original',()=>expect(unrelated()).toBeDefined())\n",
  )
  const scope = f.scope()
  assert.ok(scope.subjects.includes(entry))
  assert.ok(scope.subjects.includes(other))
  assert.ok(scope.reasons.some((reason) => reason.includes('existing test edited')))
})
