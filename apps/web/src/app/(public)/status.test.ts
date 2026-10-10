// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PRIVATE, UNLISTED } from '../../lib/site'
import { generateMetadata as inviteTitle } from './join/[code]/page'
import { InviteView } from './join/[code]/view'
import { generateMetadata as pageTitle } from './server/[slug]/page'
import { inviteCodeOf, invitedTo, statusOf } from './status'

/**
 * What a shared link's page says when the read behind it didn't find a server: that it is gone
 * only when it is, and nothing at all about the server when Blockly just couldn't answer.
 */
describe('what a shared link says when it has no server to show', () => {
  const realFetch = globalThis.fetch
  const asked: string[] = []
  const answering = (answer: number | Error, body: unknown = { error: 'x' }) => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      asked.push(String(url))
      if (answer instanceof Error) throw answer
      return new Response(JSON.stringify(body), { status: answer })
    }) as typeof fetch
  }
  afterEach(() => {
    globalThis.fetch = realFetch
    asked.length = 0
  })
  const code = 'abcdefghijkm'
  const opened = <T>(value: T) => ({ params: Promise.resolve(value) })
  // Whatever else they say, invites are never listed or followed, and server pages never listed.
  const invite = (said: object) => ({ ...said, robots: PRIVATE })
  const page = (said: object) => ({ ...said, alternates: { canonical: '/server/sunset' }, robots: UNLISTED })

  test('a busy minute is neither an expired invite nor a private server', async () => {
    answering(429)
    expect(await invitedTo(code)).toBe('unanswered')
    expect(await statusOf('sunset')).toBe('unanswered')
    // Blockly's own name and nothing else: a chat keeps the preview it was first shown.
    expect(await inviteTitle(opened({ code }))).toEqual(invite({}))
    expect(await pageTitle(opened({ slug: 'sunset' }))).toEqual(page({}))
    // Blockly out of reach says as little.
    answering(new Error('connection refused'))
    expect(await invitedTo(code)).toBe('unanswered')
    expect(await pageTitle(opened({ slug: 'sunset' }))).toEqual(page({}))
  })

  test('an invite that is gone, or a page that isn’t public, still says so', async () => {
    answering(404)
    expect(await invitedTo(code)).toBe('missing')
    expect(await inviteTitle(opened({ code }))).toEqual(invite({ title: 'This invite has expired' }))
    expect(await pageTitle(opened({ slug: 'sunset' }))).toEqual(page({ title: 'A private server' }))
  })

  test('a public server reads as its status', async () => {
    const status = { name: 'Sunset Valley', state: 'awake' }
    answering(200, status)
    expect(await statusOf('sunset')).toEqual(status as never)
  })

  test('what a chat app adds to a link is taken off, and a link cut short says so', async () => {
    expect(inviteCodeOf(`${code}.`)).toBe(code)
    expect(inviteCodeOf(`${code.toUpperCase()}),`)).toBe(code)
    expect(inviteCodeOf(`(${code}`)).toBe(code)
    expect(inviteCodeOf(`${code}%2E`)).toBe(code)
    expect(inviteCodeOf(`${code}%`)).toBe(code)
    // Cut off part way, or a letter that no invite has in it.
    expect(inviteCodeOf('abcdefg')).toBeNull()
    expect(inviteCodeOf('abcdefghijk1')).toBeNull()
    expect(inviteCodeOf('.')).toBeNull()

    // The page reads the code without the full stop.
    answering(404)
    await inviteTitle(opened({ code: `${code}.` }))
    expect(asked).toEqual([expect.stringMatching(new RegExp(`/api/public/invites/${code}$`))])
    // A link cut short isn't read at all, and says so rather than calling the invite expired.
    asked.length = 0
    expect(await inviteTitle(opened({ code: 'abcdefg' }))).toEqual(
      invite({ title: 'This link isn’t quite right' }),
    )
    expect(asked).toEqual([])
    expect(renderToStaticMarkup(createElement(InviteView, { code: null }))).toContain(
      'This link isn’t quite right',
    )
  })
})
