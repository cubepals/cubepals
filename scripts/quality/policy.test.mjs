// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercises the real policy CLI against committed adversarial trees, never the working tree. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkJUnit } from './coverage-junit.mjs'
import { escapeHatches, inspectChanges, qualityLock } from './policy.mjs'

const controller = fileURLToPath(new URL('./policy.mjs', import.meta.url))
const packageJson = {
  scripts: { test: 'bun test', quality: 'node scripts/quality/run.mjs', prepare: 'lefthook install' },
  devDependencies: { typescript: '7.0.2', lefthook: '2.2.2' },
  trustedDependencies: ['native-install'],
}
const lock = {
  lockfileVersion: 3,
  configVersion: 1,
  workspaces: {
    '': {
      devDependencies: { '@stryker-mutator/core': '10.1.1', lefthook: '2.2.2' },
      dependencies: { ordinary: '1.0.0', 'native-install': '1.0.0' },
    },
  },
  trustedDependencies: ['native-install'],
  packages: {
    '@stryker-mutator/core': [
      '@stryker-mutator/core@10.1.1',
      '',
      { dependencies: { engine: '^1.0.0' } },
      'sha512-core',
    ],
    engine: ['engine@1.0.0', '', { dependencies: { leaf: '^1.0.0' } }, 'sha512-engine'],
    leaf: ['leaf@1.0.0', '', {}, 'sha512-leaf'],
    ordinary: ['ordinary@1.0.0', '', {}, 'sha512-ordinary'],
    lefthook: [
      'lefthook@2.2.2',
      '',
      {
        optionalDependencies: { 'lefthook-linux-x64': '2.2.2' },
        bin: { lefthook: 'bin/index.js' },
      },
      'sha512-lefthook',
    ],
    'lefthook-linux-x64': ['lefthook-linux-x64@2.2.2', '', {}, 'sha512-native-hook'],
    'native-install': [
      'native-install@1.0.0',
      '',
      { dependencies: { 'install-helper': '1.0.0' } },
      'sha512-install',
    ],
    'install-helper': ['install-helper@1.0.0', '', {}, 'sha512-install-helper'],
  },
}

function repository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'quality-policy-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Quality verification',
      '-c',
      'user.email=quality@example.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Quality fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '--quiet')
    put('scripts/quality/policy.json', '{"branches":85,"functions":90,"lines":90}')
    put('scripts/quality/coverage.mjs', 'process.exitCode = 1\n')
    put('.github/workflows/ci.yml', 'jobs:\n  check:\n    steps:\n      - run: bun test\n')
    put('bunfig.toml', '[install]\nlinker = "hoisted"\n')
    put(
      'lefthook.yml',
      'commit-msg:\n  commands:\n    subject:\n      run: bun scripts/check-subject.ts {1}\n',
    )
    put('scripts/check-subject.ts', 'process.exitCode = 1\n')
    put('package.json', JSON.stringify(packageJson))
    put('bun.lock', JSON.stringify(lock))
    put('apps/example.test.ts', "test.skipIf(!database)('service', () => expect(read()).toBe(1))\n")
    put('apps/example.ts', 'export const read = () => 1\n')
    run({ cwd, put, commit, base: commit() })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function rejected(path, contents, reason) {
  repository(({ cwd, put, commit, base }) => {
    put(path, contents)
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stderr, reason)
  })
}

function rejectedHiddenFailure(source, executed = 0) {
  repository(({ cwd, put, commit, base }) => {
    const path = 'apps/control/src/infra/fleet/fleet-runtime.e2e.test.ts'
    put(path, source)
    const junit = join(cwd, 'observed.xml')
    const run = spawnSync(
      process.env.QUALITY_BUN ?? 'bun',
      ['test', '--reporter=junit', `--reporter-outfile=${junit}`, `./${path}`],
      { cwd, encoding: 'utf8' },
    )
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.equal(checkJUnit(readFileSync(junit, 'utf8'), [path], { allowOptionalOnly: true }), executed)
    const policy = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(policy.status, 1, policy.stdout + policy.stderr)
    assert.match(policy.stderr, /added test modifier/)
  })
}

test('the pinned Bun runner exports and declared API are completely classified', () => {
  const typesManifest = createRequire(import.meta.url).resolve('@types/bun/package.json')
  const typesPackage = JSON.parse(readFileSync(typesManifest, 'utf8'))
  const entry = readFileSync(join(dirname(typesManifest), typesPackage.types), 'utf8')
  const references = [...entry.matchAll(/<reference types="([^"]+)"\s*\/>/g)].map((match) => match[1])
  assert.equal(references.length, 1, 'the Bun declaration facade must identify one provider')
  assert.ok(typesPackage.dependencies[references[0]], 'the type provider must be a declared dependency')
  const declarations = readFileSync(
    createRequire(typesManifest).resolve(`${references[0]}/test.d.ts`),
    'utf8',
  )
  const members = (name) => {
    const body = declarations.match(new RegExp(`export interface ${name}<[\\s\\S]*?\\n  }`))?.[0]
    assert.ok(body, `${name} declaration must exist`)
    return [...new Set([...body.matchAll(/^ {4}([A-Za-z]\w*)(?:[<(:])/gm)].map((match) => match[1]))].sort()
  }
  const describe = ['only', 'skip', 'todo', 'concurrent', 'serial', 'if', 'skipIf', 'todoIf', 'each'].sort()
  const testApi = [...describe, 'failing', 'failingIf', 'concurrentIf', 'serialIf'].sort()
  assert.deepEqual(members('Describe'), describe)
  assert.deepEqual(members('Test'), testApi)
  const options = declarations.match(/export interface TestOptions \{[\s\S]*?\n {2}}/)?.[0]
  assert.ok(options)
  assert.deepEqual([...options.matchAll(/^ {4}(\w+)\?:/gm)].map((match) => match[1]).sort(), [
    'repeats',
    'retry',
    'timeout',
  ])
  repository(({ cwd, put }) => {
    put(
      'audit.test.ts',
      `import * as runner from 'bun:test'
runner.test('audit', () => console.log('API ' + JSON.stringify({
  version: Bun.version,
  exports: Object.keys(runner).sort(),
  describe: ${JSON.stringify(describe)}.filter(name => typeof runner.describe[name] === 'function'),
  test: ${JSON.stringify(testApi)}.filter(name => typeof runner.test[name] === 'function')
})))`,
    )
    const child = spawnSync(process.env.QUALITY_BUN ?? 'bun', ['test', './audit.test.ts'], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stdout + child.stderr)
    const api = JSON.parse(child.stdout.match(/^API (.+)$/m)?.[1] ?? 'null')
    assert.equal(api?.version, '1.4.3', 'a Bun upgrade must repeat the runner API audit')
    assert.deepEqual(api.exports, [
      'afterAll',
      'afterEach',
      'beforeAll',
      'beforeEach',
      'default',
      'describe',
      'expect',
      'expectTypeOf',
      'it',
      'jest',
      'mock',
      'onTestFinished',
      'setDefaultTimeout',
      'setSystemTime',
      'spyOn',
      'test',
      'vi',
      'xdescribe',
      'xit',
      'xtest',
    ])
    assert.deepEqual(api.describe, describe)
    assert.deepEqual(api.test, testApi)
  })
})

for (const name of ['xit', 'xtest', 'xdescribe']) {
  for (const aliased of [false, true]) {
    test(`the real controller rejects ${aliased ? 'aliased' : 'bare'} Bun ${name} hiding a defect`, () => {
      const runner = aliased ? 'disabled' : name
      const failingCase = "test('deliberate defect', () => { throw new Error('defect') })"
      rejectedHiddenFailure(
        `import { test, ${name}${aliased ? ' as disabled' : ''} } from 'bun:test'\n${
          name === 'xdescribe'
            ? `${runner}('hidden suite', () => { ${failingCase} })`
            : `${runner}('deliberate defect', () => { throw new Error('defect') })`
        }\n`,
      )
    })
  }
  for (const binding of [
    `import { '${name}' as disabled } from 'bun:test'`,
    `import * as runner from 'bun:test'; const disabled = runner['${name}']`,
    `const { ${name}: disabled } = require('bun:test')`,
  ]) {
    test(`the real controller rejects extracting ${name}: ${binding}`, () => {
      rejected('apps/weak.test.ts', `${binding}\ndisabled('hidden', () => {})`, /added test modifier/)
    })
  }
}

for (const [modifier, condition, executed] of [
  ['skip', '', 0],
  ['todo', '', 0],
  ['if', '.call(test, false)', 0],
  ['skipIf', '.call(test, true)', 0],
  ['todoIf', '.call(test, true)', 0],
  ['failing', '', 1],
  ['failingIf', '.call(test, true)', 1],
]) {
  test(`the real controller rejects destructured Bun ${modifier} hiding a defect`, () => {
    rejectedHiddenFailure(
      `import { test } from 'bun:test'
const { '${modifier}': disabled } = test
disabled${condition}('deliberate defect', () => { throw new Error('defect') })\n`,
      executed,
    )
  })
}

for (const source of [
  'const { only: focused } = test',
  'const { runIf: conditional } = test',
  'const { skip } = test',
  'const { skip = fallback } = test',
  'const { ["skip"]: disabled } = test',
  '({ skip: disabled } = test)',
]) {
  test(`the real controller rejects runner modifier bindings: ${source}`, () => {
    rejected('apps/weak.test.ts', source, /added test modifier/)
  })
}

test('disabled names are frozen by occurrence while ordinary fixture text remains data', () => {
  assert.deepEqual(escapeHatches("const fixture = 'xit'; // xdescribe and xtest\n", true), [])
  const source = "import { xit as disabled } from 'bun:test'\n"
  assert.deepEqual(
    inspectChanges([{ path: 'a.test.ts', before: source, after: `${source}test('new', () => {})` }]),
    [],
  )
  assert.match(
    inspectChanges([{ path: 'a.test.ts', before: source, after: source + source }]).join('\n'),
    /added test modifier/,
  )
  assert.deepEqual(
    escapeHatches("test.concurrentIf(false)('a', () => {}); describe.serial('b', () => {})", true),
    [],
  )
})

test('the real controller accepts a behavior test and production change', () => {
  repository(({ cwd, put, commit, base }) => {
    put('apps/example.ts', 'export const read = () => 2\n')
    put('apps/contract.test.ts', "test('answer', () => expect(read()).toBe(2))\n")
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /preserves the trusted gate/)
  })
})

for (const [name, path, content] of [
  ['lowered threshold', 'scripts/quality/policy.json', '{"branches":0,"functions":0,"lines":0}'],
  ['coverage exclusion', 'bunfig.toml', '[test]\ncoveragePathIgnorePatterns = ["apps/**"]'],
  ['disabled workflow', '.github/workflows/ci.yml', 'jobs:\n  check:\n    steps:\n      - run: true\n'],
  [
    'additional spoofing workflow',
    '.github/workflows/spoof.yml',
    'jobs:\n  policy:\n    name: Quality policy\n    steps:\n      - run: true',
  ],
  ['replacement policy', 'scripts/quality/policy.mjs', 'process.exit(0)'],
  ['disabled Java quality tasks', 'apps/reporter/build.gradle.kts', 'tasks.test { enabled = false }'],
  ['replaced Gradle wrapper', 'apps/reporter/gradlew', '#!/bin/sh\nexit 0\n'],
  [
    'JUnit discovery configuration',
    'apps/reporter/src/test/resources/junit-platform.properties',
    'junit.jupiter.extensions.autodetection.enabled=true\n',
  ],
  [
    'Gradle execution properties',
    'apps/reporter/gradle.properties',
    'org.gradle.jvmargs=-javaagent:/tmp/agent.jar\n',
  ],
  ['Babel transform configuration', 'babel.config.js', 'export default { plugins: ["replace-tests"] }'],
  ['hidden coverage configuration', '.nycrc', '{"exclude":["**"]}'],
]) {
  test(`the real controller rejects ${name}`, () =>
    rejected(path, content, /protected quality infrastructure/))
}

test('the real controller rejects an always-success package command', () => {
  rejected(
    'package.json',
    JSON.stringify({ ...packageJson, scripts: { ...packageJson.scripts, test: 'true' } }),
    /protected test command/,
  )
})

test('the real controller rejects an install hook that rewrites the controller', () => {
  repository(({ cwd, put, commit, base }) => {
    put(
      'package.json',
      JSON.stringify({
        ...packageJson,
        scripts: {
          ...packageJson.scripts,
          postinstall: 'node scripts/bootstrap.mjs',
        },
      }),
    )
    put(
      'scripts/bootstrap.mjs',
      "import { writeFileSync } from 'node:fs'; writeFileSync('scripts/quality/coverage.mjs', 'process.exit(0)')\n",
    )
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stderr, /protected test command/)
  })
})

for (const hook of [
  'preinstall',
  'install',
  'prepare',
  'preprepare',
  'postprepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'prelint',
  'postlint',
]) {
  test(`the real controller rejects the ${hook} lifecycle entrypoint changing`, () => {
    rejected(
      'package.json',
      JSON.stringify({
        ...packageJson,
        scripts: {
          ...packageJson.scripts,
          [hook]: 'node scripts/bootstrap.mjs',
        },
      }),
      /protected test command/,
    )
  })
}

test('workspace install hooks cannot be introduced through a new manifest', () => {
  rejected(
    'apps/added/package.json',
    '{"scripts":{"postinstall":"node bootstrap.mjs"}}',
    /protected test command/,
  )
})

for (const path of [
  'lefthook.yml',
  '.lefthook.yaml',
  'lefthook-local.toml',
  '.lefthookrc',
  '.lefthookrc.json',
  '.config/lefthook.yml',
  '.lefthook/post-checkout/attack.sh',
  '.npmrc',
  '.yarnrc.yml',
  'scripts/check-subject.ts',
  'scripts/check-mentions.ts',
  'node_modules/.bin/lefthook',
  'apps/control/node_modules/.bin/git',
]) {
  test(`the real controller rejects installer or Git-hook input ${path}`, () => {
    rejected(
      path,
      'post-checkout:\n  commands:\n    rewrite:\n      run: node scripts/bootstrap.mjs\n',
      /protected quality infrastructure/,
    )
  })
}

test('the prepare command tool version is protected in package manifests', () => {
  rejected(
    'package.json',
    JSON.stringify({
      ...packageJson,
      devDependencies: {
        ...packageJson.devDependencies,
        lefthook: '3.0.0',
      },
    }),
    /protected test command/,
  )
})

for (const dependency of ['lefthook', 'lefthook-linux-x64', 'native-install', 'install-helper']) {
  test(`the installer dependency ${dependency} integrity is protected`, () => {
    const next = structuredClone(lock)
    next.packages[dependency][3] = 'sha512-replaced'
    rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
  })
}

test('a nested install dependency cannot shadow a trusted helper', () => {
  const next = structuredClone(lock)
  next.packages['native-install/install-helper'] = ['install-helper@2.0.0', '', {}, 'sha512-shadow']
  rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
})

for (const binary of ['lefthook', 'node', 'git']) {
  test(`an unrelated dependency cannot shadow the ${binary} executable`, () => {
    const next = structuredClone(lock)
    next.packages.ordinary[2].bin = { [binary]: 'rewrite.mjs' }
    rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
  })
}

test('a workspace cannot expose a replacement installer binary', () => {
  rejected(
    'package.json',
    JSON.stringify({ ...packageJson, bin: { lefthook: 'scripts/bootstrap.mjs' } }),
    /protected test command/,
  )
})

test('an unrelated dependency update leaves the quality tool graph unchanged', () => {
  repository(({ cwd, put, commit, base }) => {
    const next = structuredClone(lock)
    next.workspaces[''].dependencies.ordinary = '2.0.0'
    next.packages.ordinary = ['ordinary@2.0.0', '', {}, 'sha512-new-ordinary']
    put('bun.lock', JSON.stringify(next))
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
  })
})

test('a changed transitive tool integrity hash is rejected', () => {
  const next = structuredClone(lock)
  next.packages.leaf[3] = 'sha512-replaced'
  rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
})

test('a new nested tool dependency cannot shadow the trusted dependency', () => {
  const next = structuredClone(lock)
  next.packages['@stryker-mutator/core/engine'] = ['engine@2.0.0', '', {}, 'sha512-shadow']
  rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
})

test('malformed lock evidence fails closed', () => {
  rejected('bun.lock', '{"packages":{}}', /quality tool lock cannot be verified/)
})

test('Bun trailing commas are parsed without executing lockfile contents', () => {
  const withCommas = JSON.stringify(lock, null, 2).replace(/\n(\s*)}/g, ',\n$1}')
  assert.deepEqual(qualityLock(withCommas), qualityLock(JSON.stringify(lock)))
})

test('the real controller rejects changing a skip condition to true', () => {
  rejected(
    'apps/example.test.ts',
    "test.skipIf(true)('service', () => expect(read()).toBe(1))\n",
    /added test modifier/,
  )
})

for (const modifier of ['only', 'skip', 'todo', 'failing']) {
  test(`the real controller rejects ${modifier} tests`, () => {
    rejected(
      'apps/weak.test.ts',
      `test['${modifier}']('answer', () => expect(read()).toBe(1))`,
      /added test modifier/,
    )
  })
}

for (const [modifier, condition, executed] of [
  ['if', false, 0],
  ['todoIf', true, 0],
  ['failingIf', true, 1],
]) {
  test(`the real controller rejects Bun ${modifier} hiding a failure in an optional fleet file`, () => {
    repository(({ cwd, put, commit, base }) => {
      const path = 'apps/control/src/infra/fleet/fleet-runtime.e2e.test.ts'
      put(
        path,
        `import { test } from 'bun:test'\ntest.${modifier}(${condition})('must detect a defect', () => { throw new Error('deliberate defect') })\n`,
      )
      const junit = join(cwd, 'observed.xml')
      const run = spawnSync(
        process.env.QUALITY_BUN ?? 'bun',
        ['test', '--reporter=junit', `--reporter-outfile=${junit}`, `./${path}`],
        { cwd, encoding: 'utf8' },
      )
      assert.equal(run.status, 0, run.stdout + run.stderr)
      assert.equal(checkJUnit(readFileSync(junit, 'utf8'), [path], { allowOptionalOnly: true }), executed)
      const policy = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
        cwd,
        encoding: 'utf8',
      })
      assert.equal(policy.status, 1, policy.stdout + policy.stderr)
      assert.match(policy.stderr, /added test modifier/)
    })
  })
}

for (const modifier of ['if', 'todoIf', 'failingIf']) {
  test(`existing ${modifier} conditions are frozen, including quoted aliased members`, () => {
    const source = `const check = test; check['${modifier}'](enabled && ready())('service', () => expect(read()).toBe(1))\n`
    assert.deepEqual(
      inspectChanges([
        {
          path: 'apps/contract.test.ts',
          before: source,
          after: `${source}test('new case', () => expect(read()).toBe(1))\n`,
        },
      ]),
      [],
    )
    assert.match(
      inspectChanges([
        {
          path: 'apps/contract.test.ts',
          before: source,
          after: source.replace('enabled && ready()', modifier === 'if' ? 'false' : 'true'),
        },
      ]).join('\n'),
      /added test modifier/,
    )
  })
}

for (const modifier of ['if', 'todoIf']) {
  test(`the real controller rejects describe.${modifier} conditional suites`, () => {
    rejected(
      'apps/weak.test.ts',
      `describe.${modifier}(${modifier === 'if' ? 'false' : 'true'})('suite', () => test('case', () => expect(read()).toBe(1)))`,
      /added test modifier/,
    )
  })
}

test('the real controller rejects source coverage ignore directives', () => {
  rejected('apps/example.ts', '/* istanbul ignore next */\nexport const read = () => 1', /added ignore/)
})

test('the real controller rejects disabled Java cases and test assumptions', () => {
  const path = 'apps/reporter/src/test/java/blockly/reporter/WeakTest.java'
  rejected(path, '@org.junit.jupiter.api.Disabled class WeakTest {}', /added disabled Java test/)
  rejected(
    path,
    '@EnabledIfEnvironmentVariable(named="ALLOW", matches="yes") class WeakTest {}',
    /added disabled Java test/,
  )
  rejected(path, 'class WeakTest { void check() { assumeTrue(false); } }', /added conditional Java test/)
})

test('the real controller rejects mutant-aware assertions', () => {
  rejected(
    'apps/aware.test.ts',
    "test('answer', () => expect(process.env['__STRYKER_ACTIVE_MUTANT__'] ? false : true).toBe(true))",
    /added evidence access: __STRYKER_ACTIVE_MUTANT__/,
  )
})

test('the real controller rejects assigning fabricated coverage counters', () => {
  rejected(
    'apps/example.ts',
    'globalThis.__qualityCoverage__ = { fake: { s: { 0: 999999 }, f: { 0: 999999 }, b: { 0: [999999, 999999] } } }',
    /added evidence access: __qualityCoverage__/,
  )
})

for (const name of [
  '__coverage__',
  '__stryker__',
  'STRYKER_ACTIVE_MUTANT',
  'QUALITY_REPORT',
  'QUALITY_ROOT',
  'QUALITY_SHARD',
  'QUALITY_PREPARED',
  'QUALITY_PREPARED_SHA256',
  'QUALITY_PARTS',
  'QUALITY_PHASE',
  'QUALITY_EXPECTED_BASE',
  'QUALITY_EXPECTED_HEAD',
]) {
  test(`the real controller rejects quoted evidence access to ${name}`, () => {
    rejected('apps/evidence.test.ts', `const evidence = process.env['${name}']`, /added evidence access:/)
  })
}

test('existing evidence references are frozen by occurrence count; comments are not access', () => {
  const source = 'const path = process.env.QUALITY_REPORT\n'
  assert.deepEqual(
    inspectChanges([
      { path: 'a.ts', before: source, after: `${source}// QUALITY_REPORT names the evidence file\n` },
    ]),
    [],
  )
  assert.match(
    inspectChanges([{ path: 'a.ts', before: source, after: source + source }]).join('\n'),
    /added evidence access/,
  )
})

test('fixture strings and documentation text are not executable modifiers or directives', () => {
  assert.deepEqual(
    escapeHatches(`const fixture = "test.skip('later')"; const comment = '/* istanbul ignore next */'`, true),
    [],
  )
})

test('unchanged conditional skips remain allowed; copying one adds a forbidden occurrence', () => {
  const source = "test.skipIf(!database)('service', () => expect(read()).toBe(1))\n"
  assert.deepEqual(
    inspectChanges([
      { path: 'a.test.ts', before: source, after: `${source}test('new', () => expect(read()).toBe(1))` },
    ]),
    [],
  )
  assert.match(
    inspectChanges([{ path: 'a.test.ts', before: source, after: source + source }]).join('\n'),
    /added test modifier/,
  )
})

test('refs are hashes, never arbitrary git options', () => {
  const child = spawnSync(process.execPath, [controller, '--base', '--help', '--head', 'main'], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /full commit hash/)
})
