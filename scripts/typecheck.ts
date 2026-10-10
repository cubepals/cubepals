// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Type-checks every project with the workspace's TypeScript. Run: bun run typecheck
import { CONFIGS } from './typecheck-projects.ts'

let failed = false
for (const project of CONFIGS) {
  const result = Bun.spawnSync(['node_modules/.bin/tsc', '-p', project, '--pretty', 'false'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) failed = true
  console.warn(`${result.exitCode === 0 ? 'ok  ' : 'FAIL'} ${project}`)
}
process.exit(failed ? 1 : 0)
