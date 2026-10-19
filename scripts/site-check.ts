// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bun scripts/site-check.ts <origin> [seconds]`: the website's pages asked of an origin
 * (lib/site-pages.ts), retried for `seconds` (default 0: asked once). Exits 1 when any isn't up.
 * Staging's deploy and the Nightly run it against https://staging.cubepals.com.
 */
import { waitFor, websiteTargets } from './lib/site-pages.ts'

const [origin, seconds = '0'] = process.argv.slice(2)
if (!origin || !/^https?:\/\//.test(origin) || !/^\d+$/.test(seconds)) {
  process.stderr.write('Usage: bun scripts/site-check.ts <origin> [seconds]\n')
  process.exit(2)
}
const { failing } = await waitFor(websiteTargets(origin), Number(seconds), (line) =>
  process.stdout.write(`${line}\n`),
)
if (failing.length > 0) {
  process.stderr.write(`::error::${origin} is down: ${failing.length} of its pages don't answer.\n`)
  process.exit(1)
}
