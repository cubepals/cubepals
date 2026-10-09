/**
 * Who runs Cubepals and how to reach them, as the policies and the footer say it. A detail not given
 * yet (the operator's legal name and address, the law the Terms are under) is null, and every page
 * shows a null as a marked placeholder, so nothing invented is published as fact. The Privacy
 * Policy's section on transfers names `country`, so it changes with it.
 *
 * The product's code is still called Blockly; Cubepals is the name players see.
 */
export interface Operator {
  /** The name players know the service by. */
  brand: string
  /** The site, and the domain players' server addresses sit under (`<slug>.play.<domain>`). */
  domain: string
  playDomain: string
  /** The operator's legal name, shown publicly as who runs the service. */
  name: string | null
  /** A postal address where notices can be sent. */
  address: string | null
  /** The operator's country, which decides who regulates the service. */
  country: string | null
  /** The law the Terms are under, and where disputes go. */
  law: string | null
  /** The company that sends {brand}'s email, and where it handles it: not chosen yet. */
  emailProvider: string | null
  emailProviderWhere: string | null
  /** Where each kind of message goes. Each mailbox must exist before the pages go live. */
  emails: { support: string; privacy: string; legal: string }
}

export const OPERATOR: Operator = {
  brand: 'Cubepals',
  domain: 'cubepals.com',
  playDomain: 'play.cubepals.com',
  name: null,
  address: null,
  country: 'Saudi Arabia',
  law: null,
  emailProvider: null,
  emailProviderWhere: null,
  emails: {
    support: 'support@cubepals.com',
    privacy: 'privacy@cubepals.com',
    legal: 'legal@cubepals.com',
  },
}

/** What a page says in place of a value not given yet. */
export const PLACEHOLDERS: Record<OwnerDetail, string> = {
  name: "Owner's legal name",
  address: 'Postal address for notices',
  country: 'Country of residence',
  law: 'Governing law and courts',
  emailProvider: 'Email provider, to be chosen',
  emailProviderWhere: 'Where it handles data, once chosen',
}

/** The details only the operator can give. */
export type OwnerDetail = 'name' | 'address' | 'country' | 'law' | 'emailProvider' | 'emailProviderWhere'

/**
 * Whether the policies are still drafts. Every page says so at its top while this is true; it is
 * turned off once a lawyer has read them.
 */
export const DRAFT = true
