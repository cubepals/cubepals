// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When play running out is worth a word to the owner: once this share of a block of it is used,
 * in per cent. Four fifths, of a month’s included play or of the free trial’s hours.
 * The emails that warn (`AccountService.warnAboutPlay`) and the server pages
 * (`apps/web/src/lib/trial-left.ts`) read it here, so the page warns from the moment the email
 * does.
 */
export const PLAY_WARNING_AT = 80
