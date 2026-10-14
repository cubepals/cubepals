// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether Cubepals says it is in beta, and whether this browser has read the letter that says so
 * (`/beta`). One switch, WEB_BETA, turns the tag beside the wordmark and the first-visit banner
 * on or off for the whole site: on unless the deployment sets it to `0`. The letter's page stays
 * either way.
 *
 * Read or not is kept in the browser alone, so nobody needs an account for it and nothing goes
 * back to the server. The root layout asks before the page paints (`BETA_UNREAD`), so the banner
 * never shows, even for a moment, to someone who already closed it.
 */

/** Whether the site says it is in beta: the root layout marks `<html data-beta>` when it is. */
export const betaOn = (): boolean => process.env.WEB_BETA !== '0'

/** Where this browser keeps that the letter was read or the banner closed. */
const READ = 'cubepals:beta-read'

/**
 * Run before the page paints: marks `<html data-beta-unread>` when this browser hasn't closed the
 * banner or opened the letter. Storage that can't be read shows nothing, since a close couldn't
 * be kept there either.
 */
export const BETA_UNREAD = `try{if(!localStorage.getItem(${JSON.stringify(READ)}))document.documentElement.setAttribute('data-beta-unread','')}catch(e){}`

/** The banner was closed or the letter opened: it doesn't come back on this browser. */
export function markBetaRead(): void {
  try {
    localStorage.setItem(READ, '1')
  } catch {
    // Storage refused: the banner still goes for this visit.
  }
  document.documentElement.removeAttribute('data-beta-unread')
}
