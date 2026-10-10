// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * People on a Blockly web app, as the smoke test and the staging check use them: signed up and
 * confirmed through the mail they were sent (a Mailpit), then calling the same API the pages call.
 */
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'

// The shapes these answer with are the app's own contracts; a script that only reads a field or
// two of each is clearer left loose than restating them.
// biome-ignore lint/suspicious/noExplicitAny: read loosely on purpose, see above
export type Api = (path: string, input?: unknown, method?: 'GET' | 'POST') => Promise<any>
export interface Person {
  email: string
  password: string
  api: Api
}

/**
 * Where the web app and its mail catcher answer. `origin` is the web app's own address when `web`
 * reaches it some other way (a `fly proxy` tunnel): requests carry it, as a browser on that
 * address would, and the links mailed for it are followed through `web`.
 */
export function people(web: string, mailpit: string, origin = web) {
  // Sign-in's limits count each address, and a script's accounts all come from one: a refusal
  // waits out the window (Better Auth says how long) and tries again, as a person would.
  const auth = async (path: string, body: unknown, cookie = '', tries = 8): Promise<Response> => {
    const response = await fetch(`${web}/api/auth/${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual',
    })
    if (response.status !== 429 || tries <= 1) return response
    const wait = Number(response.headers.get('x-retry-after') ?? response.headers.get('retry-after') ?? 10)
    await Bun.sleep((Number.isFinite(wait) && wait > 0 ? wait : 10) * 1000 + Math.random() * 2000)
    return auth(path, body, cookie, tries - 1)
  }
  const cookiesOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .filter(Boolean)
      .join('; ')

  /** The API the pages call, as one signed-in person. Throws what the page would have shown them. */
  const apiAs = (cookie: () => string): Api =>
    // biome-ignore lint/suspicious/noExplicitAny: read loosely on purpose, see Api above
    async function call(path, input = {}, method = 'POST', tries = 20): Promise<any> {
      const url =
        method === 'GET'
          ? `${web}/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`
          : `${web}/api/trpc/${path}?batch=1`
      const response = await fetch(url, {
        method,
        headers: { cookie: cookie(), origin, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ 0: input }) } : {}),
      })
      const body = await response.text()
      // The dev web app answers a page instead of JSON while it recompiles; it should not do that
      // for long, and a page that never becomes JSON is a failure worth seeing.
      if (!body.trimStart().startsWith('[')) {
        if (tries <= 0) throw new Error(`${path} answered ${response.status}, not JSON: ${body.slice(0, 80)}`)
        await Bun.sleep(1000)
        return call(path, input, method, tries - 1)
      }
      const [first] = JSON.parse(body) as [{ result?: { data: unknown }; error?: { message: string } }]
      if (first.error) throw new Error(first.error.message)
      return first.result?.data
    }

  /** The newest link mailed to `email` that matches `kind`, once it has arrived. */
  async function mailedLink(email: string, kind = /verify-email/): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const found = (await (
        await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
      ).json()) as { messages: { ID: string }[] }
      const id = found.messages[0]?.ID
      if (id) {
        const message = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as { Text: string }
        const link = message.Text.match(/https?:\/\/\S+/g)?.find((found) => kind.test(found))
        if (link) return link
      }
      await Bun.sleep(500)
    }
    throw new Error(`no email with a ${kind.source} link for ${email}`)
  }

  /** Signs someone up and confirms their email the way they would, through the mail they were sent. */
  async function person(email: string, password = `smoke-${randomUUID()}`): Promise<Person> {
    // Agreeing to the Terms in force, as the sign-up page does: the control plane makes no account
    // without it.
    const signedUp = await auth('sign-up/email', {
      email,
      password,
      name: 'Smoke Tester',
      callbackURL: '/servers',
      agreement: { terms: TERMS_VERSION },
    })
    if (!signedUp.ok)
      throw new Error(`signing up as ${email} answered ${signedUp.status}: ${await signedUp.text()}`)
    await fetch((await mailedLink(email)).replace(origin, web), { redirect: 'manual' })
    const cookie = cookiesOf(await auth('sign-in/email', { email, password }))
    if (cookie === '') throw new Error(`signing in as ${email} set no session`)
    return { email, password, api: apiAs(() => cookie) }
  }

  return { person, apiAs, auth, cookiesOf, mailedLink }
}
