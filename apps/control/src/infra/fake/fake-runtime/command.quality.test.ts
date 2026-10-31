// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Child-process results preserve diagnostics and distinguish failure, timeout, and launch errors. */
import { expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { run } from './command.ts'

async function completed<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The child finished but its result never settled')),
          2 * SECOND_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test.concurrent('successful commands keep stdout and stderr separately', async () => {
  const result = await completed(
    run(process.execPath, [
      '-e',
      'process.stdout.write("the result\\n"); process.stderr.write("a warning\\n")',
    ]),
  )
  expect(result).toEqual({ exitCode: 0, stdout: 'the result\n', stderr: 'a warning\n' })
})

test.concurrent('a nonzero exit rejects with its actual exit code and trimmed stderr', async () => {
  await expect(
    completed(run(process.execPath, ['-e', 'process.stderr.write("  refused\\n"); process.exit(7)'])),
  ).rejects.toThrow(`${process.execPath} exited with 7: refused`)
})

test.concurrent('tolerating failure preserves its exit code and both untrimmed streams', async () => {
  const result = await completed(
    run(
      process.execPath,
      ['-e', 'process.stdout.write("partial\\n"); process.stderr.write("  refused\\n"); process.exit(7)'],
      SECOND_MS,
      { tolerateFailure: true },
    ),
  )
  expect(result).toEqual({ exitCode: 7, stdout: 'partial\n', stderr: '  refused\n' })
})

test.concurrent('a killed command reports failure instead of a successful result', async () => {
  const result = await completed(
    run(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${SECOND_MS * 3})`], SECOND_MS, {
      tolerateFailure: true,
    }),
  )
  expect(result).toEqual({ exitCode: 137, stdout: '', stderr: '' })
})

test.concurrent('a program that cannot start preserves the operating system launch error', async () => {
  await expect(completed(run('/definitely-missing-blockly-quality-program', []))).rejects.toMatchObject({
    code: 'ENOENT',
    path: '/definitely-missing-blockly-quality-program',
  })
})
