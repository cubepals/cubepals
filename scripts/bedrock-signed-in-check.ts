// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That staging's edge checks Xbox sign-in: once BEDROCK_VALIDATE_LOGIN is back on, a headless
 * Bedrock player, who has no Xbox account, is not let in. Run after the Bedrock check
 * (`bedrock-check.ts`), which turns the check off for its own players, and after the setting is
 * on again:
 *
 *   bun scripts/bedrock-signed-in-check.ts
 *
 * It waits for the edge's signaling to answer after the restart the setting caused, then joins
 * once. Not proof that a real Xbox account gets in: only that one without a sign-in doesn't.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { until } from '@blockly/contracts/waits'
import { bedrockJoin, bedrockProbe } from './lib/bedrock-client.ts'

const PLAY_DOMAIN = 'play.staging.cubepals.com'
const ADDRESS = `bedrock-check.${PLAY_DOMAIN}`
/**
 * The two ways Geyser refuses a player no Xbox account signed in, both before any server is asked
 * for, so either alone tells a refused sign-in from an address with no server behind it:
 *
 * - At NetherNet's signaling, the first: with Xbox sign-in checked, Geyser's built-in signaling
 *   trusts only tokens Minecraft's services issued (`TokenTrust.MINECRAFT_AUTH` in Geyser's
 *   `NetherNetServer`) and refuses a self-signed offer with HTTP 401, which the headless client
 *   reports as `JoinRefusedError` words (`@jsprismarine/nethernet`'s `joinByAddress`).
 * - At login, if an offer got through: Geyser's `invalid_xbox_account` text in GeyserMC/languages
 *   (texts/en_US.properties), "Please log into Xbox to join this server.".
 */
const NOT_SIGNED_IN = ['The server refused the offer with HTTP 401', 'log into Xbox']

let probed = ''
await until(
  "the edge's signaling to answer again",
  async () => {
    probed = await bedrockProbe(`https://${ADDRESS}:19132`).catch((error: Error) => error.message)
    return probed.startsWith('2')
  },
  { timeoutMs: 5 * MINUTE_MS, seen: () => `last probe: ${probed}` },
)
const run = await bedrockJoin(ADDRESS, ['--timeout', '60'])
const said = run.told[0]?.kicked ?? 'nothing'
if (run.spawned !== 0 || !NOT_SIGNED_IN.some((words) => said.includes(words))) {
  console.error(
    `A Bedrock player with no Xbox sign-in wasn't refused for it (spawned ${run.spawned}, it said ${said}): the edge doesn't check sign-in.`,
  )
  process.exit(1)
}
console.warn(`With Xbox sign-in checked, a player with no sign-in was refused: ${said}`)
