// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Bedrock test account's first sign-in, by a person at a keyboard: prismarine-auth's device
 * code flow, into a cache directory the Bedrock check then reuses (`signed-in.ts`).
 *
 *   bun tools/bedrock-join/xbox-sign-in.ts --cache <dir> [--account cubepals-bedrock-check]
 *
 * It prints Microsoft's address and the code to enter there, which the person needs and which is
 * good only for this sign-in, then waits while they sign in to the dedicated test account. Then it
 * has Minecraft's services issue a chain, to show the sign-in works, and prints the account's
 * gamertag, the last line of its output. It never prints a token. Run through
 * `scripts/bedrock-xbox-sign-in.ts`, which seals the directory and stores it for CI.
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DEFAULT_ACCOUNT, signedInProvider } from './signed-in.ts'

const { values } = parseArgs({
  options: {
    cache: { type: 'string' },
    account: { type: 'string', default: DEFAULT_ACCOUNT },
  },
})
if (values.cache === undefined) {
  console.error('usage: xbox-sign-in.ts --cache <dir> [--account name]')
  process.exit(2)
}
mkdirSync(values.cache, { recursive: true, mode: 0o700 })
chmodSync(values.cache, 0o700)

const auth = signedInProvider({
  cacheDirectory: values.cache,
  account: values.account,
  onDeviceCode: (code) => {
    console.error(
      `Sign in to the Bedrock test account at ${code.verificationUri} with the code ${code.userCode}.`,
    )
  },
})
const identity = await auth.getIdentity()
process.stdout.write(`${identity.displayName}\n`)
