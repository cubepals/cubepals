// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether signing in and signing up work through the website, for the staging and production
 * checks and every website deploy (production.ts).
 * Sign-in is the way in: if it breaks, nobody gets in. So each way of it is asked, without making
 * an account:
 *
 * - the session read answers JSON;
 * - starting with Google, sign-in and sign-up alike, gives Google's address to go to;
 * - Google's way back gives a redirect, which is what carries the session cookie. On 2026-10-11
 *   the Worker followed that redirect itself, so the cookie never arrived and the person saw a 404.
 *   Asked with a made-up state, the control plane still answers with a redirect (to sign-in, with
 *   an error), which is all this needs;
 * - email sign-in with a wrong password is told so;
 * - email sign-up with nothing in it is told what is missing.
 *
 * Each answer must come from the control plane as it is, not a page standing in for it.
 */
type Probe = {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  ok: (answer: Response, text: string) => boolean
}

const json = (answer: Response) => (answer.headers.get('content-type') ?? '').startsWith('application/json')

/** Whether the answer sends the browser to Google's own sign-in host. */
function googleHost(text: string): boolean {
  try {
    return new URL((JSON.parse(text) as { url: string }).url).host === 'accounts.google.com'
  } catch {
    return false
  }
}

const PROBES: Probe[] = [
  { name: 'session', method: 'GET', path: '/api/auth/get-session', ok: (a) => a.status === 200 && json(a) },
  {
    name: 'Google start',
    method: 'POST',
    path: '/api/auth/sign-in/social',
    body: { provider: 'google', callbackURL: '/servers' },
    ok: (a, text) => a.status === 200 && googleHost(text),
  },
  {
    name: 'Google return',
    method: 'GET',
    path: '/api/auth/callback/google?state=check&code=check',
    ok: (a) => a.status >= 300 && a.status < 400 && a.headers.has('location'),
  },
  {
    name: 'email sign-in',
    method: 'POST',
    path: '/api/auth/sign-in/email',
    body: { email: 'nobody-check@cubepals.com', password: 'not-the-password-of-anyone' },
    ok: (a) => a.status === 401 && json(a),
  },
  {
    name: 'email sign-up',
    method: 'POST',
    path: '/api/auth/sign-up/email',
    body: {},
    ok: (a) => a.status === 400 && json(a),
  },
]

/** Every way in, asked through `site`; throws naming each one that didn't answer as it should. */
export async function authWorks(site: string): Promise<string> {
  const broken: string[] = []
  for (const probe of PROBES) {
    const answer = await fetch(`${site}${probe.path}`, {
      method: probe.method,
      redirect: 'manual',
      headers: { origin: site, 'content-type': 'application/json' },
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await answer.text()
    if (!probe.ok(answer, text)) {
      const type = answer.headers.get('content-type') ?? ''
      broken.push(
        `${probe.name} (${probe.method} ${probe.path.split('?')[0]} answered ${answer.status} ${type})`,
      )
    }
  }
  if (broken.length > 0) throw new Error(`sign-in or sign-up is broken: ${broken.join('; ')}`)
  return `${PROBES.map((probe) => probe.name).join(', ')} all answer`
}
