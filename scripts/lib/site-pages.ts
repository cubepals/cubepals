// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the website answers: the pages a visitor lands on, requested from an origin and counted
 * as up when they answer 2xx or 3xx. Cloudflare's error 1101 (a Worker that throws) is a 500, so a
 * build that deploys but can't serve a page fails here. The same list is asked of the Worker built
 * in CI (worker-smoke.ts), of staging after its deploy, of production after its deploy
 * (production-website.ts) and from outside every few minutes (site-uptime.ts).
 *
 * Production has two more public addresses, each with the answer it gives when it is well: hq
 * redirects to its sign-in (a 3xx) and rt, realtime's own TLS endpoint, answers 404 to a plain
 * request (anything under 500 shows it is reachable).
 *
 * Not a test of what the pages say, or of the API behind them (health.yml and the sign-in guard do
 * that): only that the sites are up.
 */
import { SECOND_MS } from '@blockly/contracts/durations'

/** The website's pages asked: the home page, the pricing page, sign-in and the server browser. */
export const SITE_PAGES = ['/', '/pricing', '/sign-in', '/browse'] as const

/** One address asked, and what counts as it being well. */
export interface Target {
  /** What a person calls it in a report: "/pricing", "hq.cubepals.com". */
  name: string
  url: string
  ok: (status: number) => boolean
  /** The answer wanted, in words: "2xx or 3xx". */
  want: string
}

export interface Answer {
  target: Target
  /** The HTTP status, or 0 when nothing answered (`error` says why). */
  status: number
  error?: string
}

export const isUp = (answer: Answer) => answer.target.ok(answer.status)

const upOrRedirect = (status: number) => status >= 200 && status < 400

/** The website's pages at an origin; up is 2xx or 3xx (a redirect is not followed: it is an answer). */
export const websiteTargets = (origin: string): Target[] =>
  SITE_PAGES.map((path) => ({
    name: path,
    url: new URL(path, origin).href,
    ok: upOrRedirect,
    want: '2xx or 3xx',
  }))

/**
 * Production's other public addresses. They are not the website Worker, so a failure here is
 * reported but never rolled back by rolling the Worker back (site-uptime.ts).
 */
export const PRODUCTION_OTHERS: Target[] = [
  {
    name: 'hq.cubepals.com',
    url: 'https://hq.cubepals.com/',
    ok: (status) => status >= 300 && status < 400,
    want: 'a redirect to sign-in (3xx)',
  },
  {
    name: 'rt.cubepals.com',
    url: 'https://rt.cubepals.com/',
    ok: (status) => status > 0 && status < 500,
    want: 'an answer under 500 (404 when well)',
  },
]

/** Each target asked once, with a timeout so a hung Worker is an answer too. */
export async function ask(targets: readonly Target[]): Promise<Answer[]> {
  return Promise.all(
    targets.map(async (target): Promise<Answer> => {
      try {
        const response = await fetch(target.url, {
          redirect: 'manual',
          headers: { 'cache-control': 'no-cache', 'user-agent': 'cubepals-site-guard' },
          signal: AbortSignal.timeout(20 * SECOND_MS),
        })
        await response.body?.cancel()
        return { target, status: response.status }
      } catch (error) {
        return { target, status: 0, error: (error as Error).message }
      }
    }),
  )
}

/** One line a person reads: "/pricing 500", "/browse no answer (timed out)". */
export const describe = (answer: Answer) =>
  answer.status === 0
    ? `${answer.target.name} no answer (${answer.error})`
    : `${answer.target.name} ${answer.status}`

/**
 * The targets asked until all are well or `seconds` have passed, a few seconds apart: Cloudflare
 * takes a moment to move traffic to a new version. Returns what the last ask found; an empty
 * `failing` is up.
 */
export async function waitFor(
  targets: readonly Target[],
  seconds: number,
  say: (line: string) => void,
): Promise<{ answers: Answer[]; failing: Answer[] }> {
  const end = Date.now() + seconds * SECOND_MS
  for (;;) {
    const answers = await ask(targets)
    const failing = answers.filter((answer) => !isUp(answer))
    if (failing.length === 0) {
      say(`Up: ${answers.map(describe).join(', ')}.`)
      return { answers, failing }
    }
    say(`Failing: ${failing.map(describe).join(', ')}.`)
    if (Date.now() + 10 * SECOND_MS > end) return { answers, failing }
    await Bun.sleep(10 * SECOND_MS)
  }
}
