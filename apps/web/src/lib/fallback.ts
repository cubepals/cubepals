// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Worker (worker.ts) answers when Next can't: a 503 with the static page in
 * public/errors/unavailable.html, served from the Worker's assets, which never touch Next. It
 * stands in for a throw (Next failing to start, a manifest it can't read) and for a 5xx that isn't
 * a page: Next's own error pages are HTML and pass, since they are the app's. A call that isn't
 * for a page gets a bare 503 instead of a page it couldn't use. If the assets fail too, a few
 * lines written here answer.
 */
import { OPERATOR } from '../legal/operator'

/** Where wrangler.jsonc's ASSETS binding finds the page. */
const PAGE = '/errors/unavailable.html'

interface Assets {
  fetch(request: Request): Promise<Response>
}

/** The last resort, if even the assets can't answer. */
const BARE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cubepals is having a moment</title><body style="font:18px/28px system-ui;max-width:34rem;margin:15vh auto;padding:0 16px"><h1>Cubepals is having a moment</h1><p>Something is wrong on our side and we’re on it. It isn’t you.</p><p>Write to <a href="mailto:${OPERATOR.emails.support}">${OPERATOR.emails.support}</a>.</p>`

const HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'content-type': 'text/html; charset=utf-8',
}

/** Whether the visitor asked for a page, as a browser does when it navigates. */
const wantsPage = (request: Request) => (request.headers.get('accept') ?? '').includes('text/html')

/** The 503 for `request`: the page from the assets, or the few lines when they fail. */
export async function unavailable(request: Request, assets: Assets | undefined): Promise<Response> {
  if (!wantsPage(request))
    return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } })
  try {
    const page = new URL(PAGE, request.url)
    let found = await assets?.fetch(new Request(page))
    // Assets drop the .html from an address and send it there.
    if (found && found.status >= 300 && found.status < 400 && found.headers.has('location'))
      found = await assets?.fetch(new Request(new URL(found.headers.get('location') ?? PAGE, page)))
    if (found?.ok) return new Response(found.body, { status: 503, headers: HEADERS })
  } catch {
    // Fall through to the lines below.
  }
  return new Response(BARE, { status: 503, headers: HEADERS })
}

/**
 * What `render` answers, or the 503 when it throws or (`fivexx`) answers a 5xx that isn't an HTML
 * page.
 * Anything that threw is also said to the Worker's logs, which is where the cause is read.
 */
export async function withFallback(
  request: Request,
  assets: Assets | undefined,
  render: () => Promise<Response>,
  /** False for the control plane's calls, whose own 5xx (a JSON error) is an answer, not a failure. */
  fivexx = true,
): Promise<Response> {
  try {
    const response = await render()
    const html = (response.headers.get('content-type') ?? '').startsWith('text/html')
    if (!fivexx || response.status < 500 || html) return response
    console.error(`answered ${response.status} without a page for ${new URL(request.url).pathname}`)
  } catch (error) {
    console.error('threw for', new URL(request.url).pathname, error)
  }
  return unavailable(request, assets)
}
