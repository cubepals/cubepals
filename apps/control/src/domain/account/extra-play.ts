/**
 * Who may play past their plan's included hours, and how far: the guards that keep extra play,
 * which is billed after it is played, from being play nobody pays for (docs/money-guards.md). Pure,
 * over what the billing provider has said about the account. It is not where hours are counted
 * (`meter.ts`) or where a server is stopped (`AccountService.enforceLimits`).
 */
import { dollars } from '../policy/spend.ts'
import { type Entitlements, EXTRA_CEILING, entitlementsFor, PAID_PLANS, planName } from './entitlements.ts'

/** What the billing provider has said about an account, as extra play needs it. */
export interface BillingFacts {
  /** The account's newest subscription; null when it never had one (a plan an admin gave it). */
  subscription: { status: string; cancelAtPeriodEnd: boolean } | null
  /** Orders for the plan that were paid with money and not refunded in full. */
  paidOrders: number
  /** Of those, renewals: the plan paid for again at the end of a period. */
  paidRenewals: number
  /**
   * What the account owes: charges carrying extra play that failed and are no longer in their grace
   * (`unpaidOrders`). Owing blocks starts and new servers until it is paid; downloads stay.
   */
  owedCents: number
}

export type ExtraPlay =
  /** `units`: what the owner allowed, held to `ceiling`. */
  | { may: true; ceiling: number; units: number }
  /** `why`: one sentence the account page and a refusal say. */
  | { may: false; why: string }

/**
 * Whether the account may play past its included hours now, and up to how many: Plus with a
 * subscription that is active (not on a trial, not past due, not set to end), paid for at least
 * once, and nothing owed. The ceiling is `EXTRA_CEILING`'s, by whether a renewal has been paid. The
 * moment any of that stops being true, extra play stops; what was played stays owed.
 */
export function extraPlay(plan: Entitlements, allowed: number, billing: BillingFacts): ExtraPlay {
  const no = (why: string): ExtraPlay => ({ may: false, why })
  if (!plan.mayBuyMore) {
    const sells = PAID_PLANS.find((key) => entitlementsFor(key).mayBuyMore)
    return no(
      sells === undefined
        ? 'Extra hours aren’t available here. This month’s hours reset on the 1st.'
        : `Extra hours come with ${planName(sells)}.`,
    )
  }
  const name = planName(plan.plan)
  if (billing.owedCents > 0)
    return no(
      `You owe ${dollars(billing.owedCents)} from a payment that didn’t go through, so extra hours are off until it’s paid.`,
    )
  const status = billing.subscription?.status
  if (status === 'past_due')
    return no('Your last payment didn’t go through, so extra hours are off until it does.')
  if (status !== 'active' && status !== 'trialing')
    return no(`Extra hours are billed on a ${name} subscription, and this account doesn’t have one.`)
  if (status === 'trialing' || billing.paidOrders === 0)
    return no(`Extra hours open once your first ${name} payment has gone through.`)
  if (billing.subscription?.cancelAtPeriodEnd)
    return no(
      `Your ${name} is set to end, so extra hours are off. Keep ${name} in Manage billing to allow them.`,
    )
  const ceiling = billing.paidRenewals > 0 ? EXTRA_CEILING.renewed : EXTRA_CEILING.untilRenewed
  return { may: true, ceiling, units: Math.min(Math.max(0, allowed), ceiling) }
}

/** The extra play the account may use now, in units: zero whenever it may not. */
export const extraUnits = (decision: ExtraPlay): number => (decision.may ? decision.units : 0)
