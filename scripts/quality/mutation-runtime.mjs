// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pin the invoking checker's code separately from the proposed application and later Git edits. */
import {
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const trustedRoot = fileURLToPath(new URL('../../', import.meta.url))

export function freezeMutationRuntime(from = trustedRoot) {
  const root = mkdtempSync(join(tmpdir(), 'blockly-mutation-runner-'))
  try {
    const scripts = join(root, 'scripts/quality')
    mkdirSync(scripts, { recursive: true })
    for (const file of readdirSync(join(from, 'scripts/quality')))
      if (file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
        copyFileSync(join(from, 'scripts/quality', file), join(scripts, file))
    mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
    copyFileSync(
      join(from, 'packages/contracts/src/durations.ts'),
      join(root, 'packages/contracts/src/durations.ts'),
    )
    mkdirSync(join(root, 'tools/quality'), { recursive: true })
    copyFileSync(join(from, 'tools/quality/package.json'), join(root, 'tools/quality/package.json'))
    cpSync(realpathSync(join(from, 'tools/quality/node_modules')), join(root, 'tools/quality/node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    })
    return {
      root,
      command: join(scripts, 'mutation-command.mjs'),
      sandbox: join(scripts, 'mutation-sandbox.mjs'),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
