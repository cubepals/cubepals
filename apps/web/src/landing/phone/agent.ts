// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How a phone is told apart by what its browser says of itself, as next.config.ts's rewrite
 * matches a header (the whole value, as a regular expression). A phone's browser puts "Mobi" in
 * its user agent, and Chromium says so again in `Sec-CH-UA-Mobile`. A tablet and a computer say
 * neither: they are sent the page with both forms, and the width of the screen chooses
 * (Layouts.tsx).
 */
export const PHONE_AGENT = '.*Mobi.*'
export const PHONE_HINT = '\\?1'
