// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CI runs only the "Web app, edge and scripts" test group on a pull request that changes nothing
 * beyond the web app (ci.yml, "Which test groups run"). That is safe only while no test outside that
 * group can reach the web app's code: nothing outside apps/web, apps/edge and scripts imports from
 * apps/web, by a relative path or by its package name.
 */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
/** The group the web app's own tests run in, by the paths ci.yml gives it. */
const WEB_GROUP = ['apps/web/', 'apps/edge/', 'scripts/']

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Whether an import in `file` reaches the web app. */
const reachesWeb = (file: string, specifier: string): boolean =>
  specifier === '@blockly/web' ||
  specifier.startsWith('@blockly/web/') ||
  (specifier.startsWith('.') &&
    `${relative(ROOT, resolve(ROOT, dirname(file), specifier))}/`.startsWith('apps/web/'))

test('a relative path or the package name reaches the web app; other packages don’t', () => {
  expect(reachesWeb('apps/control/src/a.ts', '../../web/src/lib/api.ts')).toBe(true)
  expect(reachesWeb('packages/contracts/src/a.ts', '../../../apps/web/x')).toBe(true)
  expect(reachesWeb('apps/control/src/a.ts', '@blockly/web/lib')).toBe(true)
  expect(reachesWeb('apps/control/src/a.ts', '@blockly/contracts')).toBe(false)
  expect(reachesWeb('apps/control/src/a.ts', '../../edge/poll.ts')).toBe(false)
})

test('nothing outside the web app’s test group imports the web app', () => {
  const files = spawnSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.js', '*.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter((file) => file !== '' && !WEB_GROUP.some((dir) => file.startsWith(dir)))
  const reaching = files.flatMap((file) =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(SPECIFIER)]
      .map((match) => match[1] as string)
      .filter((specifier) => reachesWeb(file, specifier))
      .map((specifier) => `${file}: ${specifier}`),
  )
  expect(reaching).toEqual([])
})
