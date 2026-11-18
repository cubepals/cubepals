// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `node scripts/realtime-check.node.ts <host> [seconds] [--transport webtransport|websocket]`:
 * realtime at `<host>` (`rt.cubepals.com`) asked over WebTransport and its WebSocket fallback as a
 * browser asks it (lib/realtime-probe.node.ts), again every ten seconds until each answers or
 * `seconds` have passed (default 0: asked once). Prints a line a transport and exits 1 when one
 * doesn't answer. `--transport` asks one alone.
 *
 * Deploy production runs it after every deploy, the hotfix and the rollback before they say
 * production answers (production.ts), and the uptime check every five minutes (site-uptime.ts).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import {
  askRealtime,
  describeRealtime,
  realtimeUrls,
  TRANSPORT_NAMES,
  type Transport,
} from './lib/realtime-probe.node.ts'

const AGAIN_MS = 10 * SECOND_MS

const args = process.argv.slice(2)
const at = args.indexOf('--transport')
const only = at === -1 ? undefined : args[at + 1]
const [host, seconds = '0'] = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)]
if (!host || !/^\d+$/.test(seconds) || (only !== undefined && !(only in TRANSPORT_NAMES))) {
  process.stderr.write(
    'Usage: node scripts/realtime-check.node.ts <host> [seconds] [--transport webtransport|websocket]\n',
  )
  process.exit(2)
}
const all = realtimeUrls(host)
const urls = only === undefined ? all : { [only]: all[only as Transport] }
const end = Date.now() + Number(seconds) * SECOND_MS
for (;;) {
  const answers = await askRealtime(urls)
  for (const answer of answers) process.stdout.write(`${describeRealtime(answer)}\n`)
  if (answers.every((answer) => answer.up)) process.exit(0)
  if (Date.now() + AGAIN_MS > end) {
    const down = answers.filter((answer) => !answer.up).map((answer) => TRANSPORT_NAMES[answer.transport])
    process.stderr.write(`::error::Realtime at ${host} doesn't answer over ${down.join(' or ')}.\n`)
    process.exit(1)
  }
  await sleep(AGAIN_MS)
}
