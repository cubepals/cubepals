// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono'
import type { BillingService } from '../../app/billing/service.ts'
import { CapabilityUnavailable } from '../../app/capabilities.ts'
import { WebhookRejected } from '../../app/ports/optional.ts'

/**
 * The billing provider's webhooks. The body is read raw: its signature covers the
 * exact bytes. A delivery that isn't authentic is refused; one that fails for any other reason
 * answers 500, so the provider delivers it again.
 */
export function createBillingWebhook(deps: { billing: BillingService }): Hono {
  const app = new Hono()
  app.post('/api/billing/webhook', async (c) => {
    const body = await c.req.text()
    try {
      const outcome = await deps.billing.receiveWebhook(body, Object.fromEntries(c.req.raw.headers))
      return c.json({ outcome })
    } catch (error) {
      if (error instanceof WebhookRejected) return c.json({ error: 'The delivery is not authentic.' }, 401)
      if (error instanceof CapabilityUnavailable)
        return c.json({ error: 'This deployment takes no payments.' }, 404)
      throw error
    }
  })
  return app
}
