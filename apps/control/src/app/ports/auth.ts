// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sign-in and sessions, whoever provides them (Better Auth, in infra/auth). The interfaces serve
 * its endpoints and ask it who a request belongs to; nothing else about it leaks out.
 */
/**
 * The header a request to the auth endpoints carries its client's address in, set by the HTTP
 * layer from what it trusts (interfaces/http/client-address.ts) and never by the caller. Sign-in's
 * limits count each address; without it, everyone shares one.
 */
export const CLIENT_ADDRESS_HEADER = 'x-blockly-client-address'

export interface Authenticator {
  /** Serves the auth endpoints under /api/auth, their client's address in CLIENT_ADDRESS_HEADER. */
  handle(request: Request): Promise<Response>
  /** Whose a request's session is; null when it is signed out. */
  sessionOf(headers: Headers): Promise<SignedIn | null>
  /** One request's session, to switch: the cookies it sets go on `response`. */
  switchFor(request: Headers, response: Headers): SessionSwitch
}

interface SignedIn {
  userId: string
  /** The admin using this test account's session ("Use as this account"); null for its own. */
  impersonatedBy: string | null
}

/**
 * An admin's session swapped for a test account's and back. The application decides who may; this
 * only does it. Nothing else reaches the sign-in provider's own impersonation.
 */
export interface SessionSwitch {
  /** This request's session becomes `userId`'s for an hour, the admin's kept to come back to. */
  impersonate(userId: string): Promise<void>
  /** Back to the admin's own session; the test account's ends. */
  stopImpersonating(): Promise<void>
}
