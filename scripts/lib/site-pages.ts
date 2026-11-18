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
 * redirects to its sign-in (a 3xx), and realtime, at rt, is asked over WebTransport and over its
 * WebSocket fallback as a browser asks it, and must refuse a session with no ticket itself
 * (realtime-check.node.ts, run with Node, since its WebTransport client is a native binding).
 *
 * Not a test of what the pages say, or of the API behind them (health.yml and the sign-in guard do
 * that): only that the sites are up.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { SECOND_MS } from '@blockly/contracts/durations'
import { REALTIME_FALLBACK_PATH } from '@blockly/contracts/realtime'

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
  /** How it is asked where a plain GET isn't the question; the status, or 0 with why. */
  ask?: () => Promise<{ status: number; error?: string }>
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

/** A picture through Next's image optimizer, as the pages load theirs: the logo, at a width Next allows. */
const IMAGE_PATH = '/_next/image?url=%2Flogo.png&w=64&q=75'

/**
 * What proves a preview of the website, as CLAUDE.md sets the bar for one: each page and a picture
 * answer 200 exactly. Deploy production's website route takes only a commit proved so.
 */
export const proofTargets = (origin: string): Target[] =>
  [...SITE_PAGES, IMAGE_PATH].map((path) => ({
    name: path === IMAGE_PATH ? '/_next/image' : path,
    url: new URL(path, origin).href,
    ok: (status) => status === 200,
    want: '200',
  }))

/** The control plane's health through the website, which every production deploy asks after. */
export const apiTarget = (origin: string): Target => ({
  name: '/api/health',
  url: new URL('/api/health', origin).href,
  ok: (status) => status === 200,
  want: '200',
})

const CHECK = join(import.meta.dir, '..', 'realtime-check.node.ts')
/** Past the check's own limits (a handshake and a refusal, six seconds each), it is stopped. */
const CHECK_MS = 30 * SECOND_MS

/**
 * Realtime at `host` over one transport, through realtime-check.node.ts. Up, it is the status that
 * opens such a session, a 200 for WebTransport's CONNECT and a 101 for the WebSocket's upgrade,
 * followed by realtime's own refusal; anything else is 0 with what was heard.
 */
export function realtimeTarget(transport: 'webtransport' | 'websocket', host: string): Target {
  const status = transport === 'webtransport' ? 200 : 101
  return {
    name: `${host} over ${transport === 'webtransport' ? 'WebTransport' : 'WebSocket'}`,
    url: transport === 'webtransport' ? `https://${host}/` : `wss://${host}${REALTIME_FALLBACK_PATH}`,
    ok: (answered) => answered === status,
    want: `a session (${status}) that realtime itself turns away`,
    ask: () =>
      new Promise((resolve) => {
        const child = spawn('node', [CHECK, host, '--transport', transport], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        setTimeout(() => child.kill(), CHECK_MS).unref()
        let out = ''
        child.stdout.on('data', (chunk) => {
          out += chunk
        })
        child.on('error', (error) => resolve({ status: 0, error: error.message }))
        child.on('close', (code) => {
          const line =
            out
              .trim()
              .split('\n')
              .at(-1)
              ?.replace(/^\w+: /, '') ?? ''
          resolve(code === 0 ? { status } : { status: 0, error: line || `the check exited ${code}` })
        })
      }),
  }
}

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
  realtimeTarget('webtransport', 'rt.cubepals.com'),
  realtimeTarget('websocket', 'rt.cubepals.com'),
]

/** Each target asked once, with a timeout so a hung Worker is an answer too. */
export async function ask(targets: readonly Target[]): Promise<Answer[]> {
  return Promise.all(
    targets.map(async (target): Promise<Answer> => {
      if (target.ask) return { target, ...(await target.ask()) }
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
