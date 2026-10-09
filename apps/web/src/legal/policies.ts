import { ACCEPTABLE_USE } from './acceptable-use'
import { COOKIES } from './cookies'
import type { Policy } from './policy'
import { PRIVACY } from './privacy'
import { REFUNDS } from './refunds'
import { TAKEDOWN } from './takedown'
import { TERMS } from './terms'

/** Every policy, in the order the footer and the /legal index list them. */
export const POLICIES: readonly Policy[] = [TERMS, PRIVACY, REFUNDS, ACCEPTABLE_USE, TAKEDOWN, COOKIES]

/** A policy by its path under /legal, or undefined. */
export const policyAt = (slug: string): Policy | undefined => POLICIES.find((policy) => policy.slug === slug)

/** Where a policy is read. */
export const hrefOf = (policy: Pick<Policy, 'slug'>): string => `/legal/${policy.slug}`
