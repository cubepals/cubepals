// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bun scripts/site-check.ts <origin> [seconds] [--proof] [--api]`: the website's pages asked of an
 * origin (lib/site-pages.ts), retried for `seconds` (default 0: asked once). Exits 1 when any isn't
 * up. Staging's deploy and the Nightly run it against https://staging.cubepals.com.
 *
 * --proof asks for 200 exactly from each page and from a picture through /_next/image: what a
 * preview must answer before Deploy production's website route takes its commit. --api asks for
 * /api/health too, as every production deploy does after.
 */
import { apiTarget, proofTargets, waitFor, websiteTargets } from './lib/site-pages.ts'

const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'))
const [origin, seconds = '0'] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const unknown = flags.filter((flag) => flag !== '--proof' && flag !== '--api')
if (!origin || !/^https?:\/\//.test(origin) || !/^\d+$/.test(seconds) || unknown.length > 0) {
  process.stderr.write('Usage: bun scripts/site-check.ts <origin> [seconds] [--proof] [--api]\n')
  process.exit(2)
}
const targets = [
  ...(flags.includes('--proof') ? proofTargets(origin) : websiteTargets(origin)),
  ...(flags.includes('--api') ? [apiTarget(origin)] : []),
]
const { failing } = await waitFor(targets, Number(seconds), (line) => process.stdout.write(`${line}\n`))
if (failing.length > 0) {
  process.stderr.write(`::error::${origin} is down: ${failing.length} of its pages don't answer.\n`)
  process.exit(1)
}
