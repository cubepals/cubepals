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
 *
 * Once the pages are up, the prices they state (lib/stated-prices.ts): one price and hours a month
 * for each plan, everywhere, and none in the policies. Prices that disagree are asked again a few
 * times, since a page keeps its reading of the offer for a minute; past that, exits 1 naming them.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { apiTarget, proofTargets, waitFor, websiteTargets } from './lib/site-pages.ts'
import { checkPrices } from './lib/stated-prices.ts'

/** How often prices that disagree are asked again, and how long apart: past a page's minute. */
const PRICE_TRIES = 3
const PRICE_AGAIN_MS = 40 * SECOND_MS

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
const say = (line: string) => process.stdout.write(`${line}\n`)
const { failing } = await waitFor(targets, Number(seconds), say)
if (failing.length > 0) {
  process.stderr.write(`::error::${origin} is down: ${failing.length} of its pages don't answer.\n`)
  process.exit(1)
}
for (let tried = 1; ; tried++) {
  const problems = await checkPrices(origin, say)
  if (problems.length === 0) break
  for (const line of problems) say(`Prices: ${line}`)
  if (tried === PRICE_TRIES) {
    for (const line of problems) process.stderr.write(`::error::${line}\n`)
    process.exit(1)
  }
  await Bun.sleep(PRICE_AGAIN_MS)
}
