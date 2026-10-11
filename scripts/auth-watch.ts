// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether signing in and signing up work on a site right now (scripts/lib/auth-through-website.ts):
 *   bun scripts/auth-watch.ts [https://cubepals.com]
 * sign-in-watch.yml runs it against production every 15 minutes, so a break shows as a failed run
 * even when nothing was deployed.
 */
import { authWorks } from './lib/auth-through-website.ts'

const site = process.argv[2] ?? 'https://cubepals.com'
try {
  console.log(`${site}: ${await authWorks(site)}`)
} catch (error) {
  console.error(`${site}: ${(error as Error).message}`)
  process.exit(1)
}
