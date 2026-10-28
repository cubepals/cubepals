// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The headers every answer from the site carries: no page of it is shown inside another site's
 * frame, a file is read as the type it says it is, another site is told only which origin a link
 * came from, and the browser keeps to HTTPS for the site.
 *
 * Three places send them, so that each kind of answer gets them once: next.config.ts's headers()
 * for whatever Next answers (on the Worker, OpenNext's routing applies it, `/_next/image`
 * included), `withSiteHeaders` in worker.ts for what the Worker answers without Next (the control
 * plane's /api answers, the 503 page, the `www.` redirect), and public/_headers for the files
 * Cloudflare serves from the Worker's assets without running it. site-headers.test.ts holds the
 * three to this list.
 *
 * Not a full Content-Security-Policy: only `frame-ancestors`, which can't stop a script or a
 * picture the site loads.
 */

/** Each header's name and value, as next.config.ts's headers() takes them. */
export const SITE_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
]

/**
 * `response` with every header above it doesn't already say. A switch of protocols (101) is
 * passed as it is, since its answer can't be made again.
 */
export function withSiteHeaders(response: Response): Response {
  if (response.status === 101) return response
  const answer = new Response(response.body, response)
  for (const { key, value } of SITE_HEADERS) if (!answer.headers.has(key)) answer.headers.set(key, value)
  return answer
}
