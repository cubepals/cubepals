// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A realtime session carries no cookie, so the api issues a short-lived ticket the browser puts in
 * the query string, and the realtime role checks it before opening the session.
 */
export interface RealtimeTickets {
  issue(userId: string): Promise<string>
  /** The user id the ticket was issued to, or null when it is forged, expired or for another deployment. */
  verify(ticket: string): Promise<string | null>
}
