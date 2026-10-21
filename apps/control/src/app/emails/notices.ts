// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Cubepals itself changed on someone's server, told to its owner once the change is stored
 * (servers/owner-notices.ts): a new address, or out of Browse. They come from the address nobody
 * reads (MAIL_NOTICE_FROM), so each says so where the other emails offer a reply.
 */
import { type Email, esc, INK, layout, OWNER, p } from '../emails.ts'

type Server = { id: string; name: string }

const UNREAD = 'This mailbox isn’t read.'
const OPEN = 'Open your server'

/** An address in bold, kept on one line: a long one would otherwise break at its dashes. */
const address = (text: string) => `<strong style="color:${INK};white-space:nowrap">${esc(text)}</strong>`

/**
 * A new address an operator gave the server. `from` and `to` are the join addresses players type;
 * `slug` is the old one's name alone.
 */
export function addressChanged(input: {
  server: Server
  slug: string
  from: string
  to: string
  origin: string
}): Email {
  const page = `${input.origin}/servers/${input.server.id}`
  const subject = 'Your server has a new address'
  const moved = (name: string, from: string, to: string, slug: string) =>
    `Your server “${name}” moved from ${from} to ${to}. Short addresses like “${slug}” are kept for Cubepals, so nobody mistakes a server for ours.`
  const kept =
    'Your world and settings didn’t change. You can pick another address in your server’s settings.'
  return {
    subject,
    text: [
      moved(input.server.name, input.from, input.to, input.slug),
      '',
      kept,
      page,
      '',
      UNREAD,
      '',
      'Cubepals',
    ].join('\n'),
    html: layout({
      origin: input.origin,
      heading: subject,
      body:
        p(moved(esc(input.server.name), address(input.from), address(input.to), esc(input.slug))) + p(kept),
      action: { label: OPEN, url: page },
      why: OWNER,
      unread: true,
    }),
  }
}

/** The server taken out of Browse by an operator; `join` is the address its friends join at. */
export function unlisted(input: { server: Server; join: string; origin: string }): Email {
  const page = `${input.origin}/servers/${input.server.id}`
  const subject = 'Your server is no longer listed in Browse'
  const said = (name: string, join: string) =>
    `We took “${name}” out of the public server list. Your friends can still join it at ${join}.`
  return {
    subject,
    text: [said(input.server.name, input.join), page, '', UNREAD, '', 'Cubepals'].join('\n'),
    html: layout({
      origin: input.origin,
      chip: { label: 'Not in Browse', tone: 'quiet' },
      heading: subject,
      body: p(said(esc(input.server.name), address(input.join))),
      action: { label: OPEN, url: page },
      why: OWNER,
      unread: true,
    }),
  }
}
