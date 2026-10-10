// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local checkout's pages, in place of Polar's checkout and customer portal: one starts a
 * plan, one cancels it, and one pays a balance owed. Each sends what it did to the billing webhook as a signed delivery,
 * through the same route a Polar delivery takes, then goes back to the account page, which reads
 * the plan as it would after a real payment. Only `local-billing.ts` makes their links.
 */
import { Hono } from 'hono'
import { LOCAL_BILLING_PATH, type LocalBilling, type Ticket } from './local-billing.ts'

/** The pages, under LOCAL_BILLING_PATH on the api listener. */
export function localCheckoutPages(deps: {
  billing: LocalBilling
  /** The billing webhook's route (interfaces/billing/webhook.ts). */
  webhook: { request: (path: string, init: RequestInit) => Response | Promise<Response> }
}): Hono {
  const app = new Hono()

  const deliver = async (delivery: Parameters<LocalBilling['delivery']>[0]) => {
    const { body, headers } = deps.billing.delivery(delivery)
    const response = await deps.webhook.request('/api/billing/webhook', { method: 'POST', body, headers })
    if (!response.ok) throw new Error(`the billing webhook answered ${response.status}`)
  }

  app.get(`${LOCAL_BILLING_PATH}/checkout`, (c) => {
    const ticket = deps.billing.ticket(c.req.query('ticket') ?? '', 'checkout')
    if (ticket === null) return c.html(expired(), 400)
    const plan = escaped(title(ticket.planKey ?? ''))
    return c.html(
      page(
        'Test checkout',
        `<p>This Cubepals runs on your own computer, so nothing is charged here. Start ${plan} and this account gets it, the way a payment would give it.</p>`,
        form(c.req.query('ticket') ?? '', `Start ${title(ticket.planKey ?? '')}`, ticket),
      ),
    )
  })

  app.post(`${LOCAL_BILLING_PATH}/checkout`, async (c) => {
    const ticket = deps.billing.ticket(String((await c.req.parseBody()).ticket ?? ''), 'checkout')
    if (ticket === null || ticket.planKey === null) return c.html(expired(), 400)
    await deliver({ type: 'subscription.started', userId: ticket.userId, planKey: ticket.planKey })
    await deliver({
      type: 'order.paid',
      userId: ticket.userId,
      planKey: ticket.planKey,
      cents: ticket.priceCents,
    })
    return c.redirect(ticket.returnUrl, 303)
  })

  app.get(`${LOCAL_BILLING_PATH}/settle`, (c) => {
    const ticket = deps.billing.ticket(c.req.query('ticket') ?? '', 'settle')
    if (ticket === null) return c.html(expired(), 400)
    const owed = `$${(ticket.priceCents / 100).toFixed(2)}`
    return c.html(
      page(
        'Test payment',
        `<p>This account owes ${owed} from a payment that didn’t go through. Nothing is charged here, on your own computer; paying settles it the way a payment would.</p>`,
        form(c.req.query('ticket') ?? '', `Pay ${owed}`, ticket),
      ),
    )
  })

  app.post(`${LOCAL_BILLING_PATH}/settle`, async (c) => {
    const ticket = deps.billing.ticket(String((await c.req.parseBody()).ticket ?? ''), 'settle')
    if (ticket === null) return c.html(expired(), 400)
    await deliver({
      type: 'order.paid',
      userId: ticket.userId,
      planKey: null,
      cents: ticket.priceCents,
      settles: ticket.settles ?? [],
    })
    return c.redirect(ticket.returnUrl, 303)
  })

  app.get(`${LOCAL_BILLING_PATH}/portal`, async (c) => {
    const ticket = deps.billing.ticket(c.req.query('ticket') ?? '', 'portal')
    if (ticket === null) return c.html(expired(), 400)
    const paid = (await deps.billing.stateOf(ticket.userId))?.subscription ?? null
    if (paid === null)
      return c.html(
        page('Billing', '<p>This account pays for nothing right now.</p>', back(ticket.returnUrl)),
      )
    const plan = escaped(title(paid.planKey))
    return c.html(
      page(
        'Billing',
        `<p>This account has ${plan}. Nothing is charged for it here, on your own computer. Cancel it and the account is on Free right away.</p>`,
        form(c.req.query('ticket') ?? '', `Cancel ${title(paid.planKey)}`, ticket),
      ),
    )
  })

  app.post(`${LOCAL_BILLING_PATH}/portal`, async (c) => {
    const ticket = deps.billing.ticket(String((await c.req.parseBody()).ticket ?? ''), 'portal')
    if (ticket === null) return c.html(expired(), 400)
    await deliver({ type: 'subscription.cancelled', userId: ticket.userId })
    return c.redirect(ticket.returnUrl, 303)
  })

  return app
}

const title = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)

const escaped = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  )

/** The page's one action, posted back to the same address with its ticket. */
const form = (ticket: string, label: string, to: Ticket) =>
  `<form method="post"><input type="hidden" name="ticket" value="${escaped(ticket)}"><button>${escaped(label)}</button>${back(to.returnUrl, 'Go back')}</form>`

const back = (returnUrl: string, label = 'Back to Cubepals') =>
  `<a href="${escaped(returnUrl)}">${escaped(label)}</a>`

const expired = () =>
  page('This link has run out', '<p>Go back to Cubepals and choose the plan again.</p>', '')

const page = (heading: string, body: string, actions: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(heading)} · Cubepals</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 16px; background: #f6f5f1; color: #1d1c1a; }
  main { max-width: 440px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  form { display: flex; gap: 16px; align-items: center; margin-top: 20px; }
  button { font: inherit; padding: 10px 18px; border: 0; border-radius: 8px; background: #1d1c1a; color: #fff; cursor: pointer; }
  a { color: inherit; }
</style>
</head>
<body><main><h1>${escaped(heading)}</h1>${body}${actions}</main></body>
</html>`
