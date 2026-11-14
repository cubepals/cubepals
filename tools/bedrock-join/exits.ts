// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The exit code that means "the test account must be signed in again", not "the join failed". */
export const REAUTH_EXIT = 3
/** The one command that signs the Bedrock test account in again (a maintainer, at a keyboard). */
export const SIGN_IN_COMMAND = 'bun scripts/bedrock-xbox-sign-in.ts'
