// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A server resting because its owner's free trial is used up, at the top of its page: where the
 * game sends everyone it turns away (`apps/edge/resting.ts`), private server or not. Only here
 * does Cubepals know who is reading, by who is signed in, so only here is it said to each: its
 * owner gets the one way on, the plan by the month on sale, straight to checkout; anyone else
 * whose server it is and what they can do. Nothing is guessed from a Minecraft name.
 *
 * Each is reported as it comes into view, and the owner's way on as it is pressed (`steps.ts`).
 * Not for the owner's own server page, which says the same in the app (`FreeHoursUsed`).
 */
import type { RestingView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../lib/api'
import { keepPlayingHref, monthlyOnSale } from '../../lib/keep-playing'
import { Button, FormSection, priceOf } from '../../ui'
import { ctaMark, seenMark } from './steps'

export function Resting({ view }: { view: RestingView }) {
  return view.yours ? (
    <OwnersWayOn name={view.name} serverId={view.serverId} />
  ) : (
    <FriendsLine name={view.name} />
  )
}

/** Its owner's: that the world is kept and nothing charged, and the plan that starts it again. */
function OwnersWayOn({ name, serverId }: { name: string; serverId: string }) {
  const trpc = useTRPC()
  const plans = useQuery(trpc.billing.plans.queryOptions())
  const plan = monthlyOnSale(plans.data ?? [])
  return (
    <div {...seenMark('resting_owner')}>
      <FormSection
        title={`${name} is resting`}
        description="Your free trial is used up. Your world is kept, and nothing is charged."
        actions={
          plan === null ? (
            <Button variant="outline" href={`/servers/${serverId}`}>
              Open your server
            </Button>
          ) : (
            <Button variant="primary" href={keepPlayingHref(plan.key, serverId)} {...ctaMark('keep_playing')}>
              Keep playing
            </Button>
          )
        }
      >
        {plan !== null && (
          <p className="type-body-sm">
            {plan.name} starts it again: {priceOf(plan.monthlyPriceCents)}, with {plan.includedHours} hours of
            play every month. Your world is kept just as you left it.
          </p>
        )}
      </FormSection>
    </div>
  )
}

/** Anyone else's: whose server it is, that nothing is wrong with them, and who can start it again. */
function FriendsLine({ name }: { name: string }) {
  return (
    <div {...seenMark('resting_friend')}>
      <FormSection
        title={`${name} is resting`}
        description="Its owner’s free trial is used up, so it can’t start for now. Its world is kept."
      >
        <p className="type-body-sm">
          Let its owner know you’d like to keep playing: they can start it again from their Cubepals account.
        </p>
      </FormSection>
    </div>
  )
}
