// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { checkoutHref } from '../../../lib/checkout'
import { behindSignUp, useSignedIn } from '../../../lib/viewer'
import { Button } from '../../../ui'

/**
 * A plan's button on the pricing page. Signed in, it goes to the checkout page (the agreement,
 * then paying) and back to their servers; signed out, it makes the account first, and the
 * account page carries on to the checkout page.
 */
export function GetPlan({ plan, name, paid }: { plan: string; name: string; paid: boolean }) {
  const signedIn = useSignedIn()
  if (!paid)
    return (
      <Button variant="outline" href={behindSignUp(signedIn, '/servers/new')}>
        Create a server
      </Button>
    )
  if (!signedIn)
    return (
      <Button variant="primary" href={behindSignUp(false, `/account?get=${plan}&reason=pricing`)}>
        Get {name}
      </Button>
    )
  return (
    <Button variant="primary" href={checkoutHref({ plan, reason: 'pricing', next: '/servers' })}>
      Get {name}
    </Button>
  )
}
