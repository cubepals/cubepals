// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * flyctl run without holding up the rest of a script while it answers, for the checks that run
 * several things at once (`staging-check.ts`, `bedrock-check.ts`). `staging.ts` runs it
 * synchronously and has its own.
 */

import { flyAsync } from './fly-rate-limit.ts'

/** Runs `fly` with these arguments and answers its output; a failure throws what flyctl said. */
export async function fly(args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await flyAsync(args)
  if (exitCode !== 0) throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${stderr.trim()}`)
  return stdout
}
