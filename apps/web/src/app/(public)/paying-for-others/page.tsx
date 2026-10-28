// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page for anyone paying for a server they don't own: how a gift of Plus works, how it stops,
 * and what happens to the world after. Buying is `/gift`'s.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { dollars, FREE, PLUS } from '../../../legal/figures'
import { pageMetadata } from '../../../lib/site'
import { Button } from '../../../ui'

export const metadata: Metadata = pageMetadata({
  title: 'Paying for someone else’s server',
  description: `How to pay for a friend’s Cubepals server or your group’s: a gift of ${PLUS.name}, how it stops, and what happens to the world.`,
  path: '/paying-for-others',
})

/**
 * For anyone paying for a server they don't own: a friend's, or the one their group plays on.
 * How a gift works, how it stops, and what happens to the world after. Plan facts come from the
 * same figures the Terms state, so this page never says more than they do.
 */
export default function PayingForOthersPage() {
  const sections: Array<{ heading: string; lines: string[] }> = [
    {
      heading: 'How it works',
      lines: [
        `A server belongs to one account, and that account’s plan covers it for everyone who plays. To pay for a friend’s server, or the one your group plays on, give ${PLUS.name} to whoever owns it.`,
        `Buy a gift here and we email you a code: a month of ${PLUS.name} is ${dollars(PLUS.priceCents)}. Pass it on however you like. They redeem it signed in to their own account, and ${PLUS.name} starts then.`,
        `It’s still their server and their world. You don’t get access to their account, and they don’t see your card.`,
        `If they already pay for ${PLUS.name}, they set it to end in Manage billing first, and the gift starts when their paid time does. A second gift runs on from the first.`,
      ],
    },
    {
      heading: 'How to stop it',
      lines: [
        'A gift is paid once and never renews, so there’s nothing to cancel. It ends on its own after the time it gives.',
        'To keep paying, give another code before it ends. To stop, don’t.',
        'Changed your mind before they redeem it? Reply to the email with the code within 14 days of buying it, and you get everything back. The code stops working.',
      ],
    },
    {
      heading: 'What happens to the world',
      lines: [
        `When the gift ends, their account moves to the free trial. Nothing is deleted, and nothing is charged.`,
        `A server that needs ${PLUS.name} (mods, plugins or modpacks, a larger size, or more than ${FREE.maxServers} server) stops and waits, whole, until they have ${PLUS.name} again or change it to fit the free trial.`,
        `From then on the free trial’s rules apply: what is left of its ${FREE.totalHours} hours, to play on any day, and a world nobody plays for ${FREE.restsAfterDays} days rests in storage until someone joins, and one nobody plays for a year can be deleted, after two emails. They can download their world any time.`,
      ],
    },
  ]
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-24)', maxWidth: 'var(--width-form)' }}>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Paying for someone else’s server
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          For a friend’s server, or the one your group plays on.
        </p>
      </header>
      {sections.map((section) => (
        <section key={section.heading} className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <h2 className="type-heading" style={{ color: 'var(--ink)' }}>
            {section.heading}
          </h2>
          {section.lines.map((line) => (
            <p key={line} className="type-body" style={{ color: 'var(--ink-muted)' }}>
              {line}
            </p>
          ))}
        </section>
      ))}
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        The <Link href="/legal/refunds#gifts">Refunds</Link> page has the details.
      </p>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        <Button variant="primary" size="lg" href="/gift">
          Give {PLUS.name}
        </Button>
      </div>
    </div>
  )
}
