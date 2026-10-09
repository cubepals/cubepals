import { describe, expect, test } from 'bun:test'
import { CheckoutConsent, SignUpAgreement, TERMS_VERSION } from '@blockly/contracts'
import { AGREED, consentFor } from './agreement.ts'

describe('the agreement a new account is made under', () => {
  test('is the Terms in force, in the shape the control plane requires', () => {
    expect(AGREED).toEqual({ terms: TERMS_VERSION })
    expect(SignUpAgreement.safeParse(AGREED).success).toBe(true)
  })

  test('the control plane refuses anything short of it', () => {
    for (const short of [null, {}, { terms: 'yes' }, 'yes'])
      expect(SignUpAgreement.safeParse(short).success).toBe(false)
  })
})

describe('the consent before a paid plan starts', () => {
  test('needs both boxes: the Terms, and starting now inside the 14 days', () => {
    expect(consentFor(false, false)).toBeNull()
    expect(consentFor(true, false)).toBeNull()
    expect(consentFor(false, true)).toBeNull()
    const consent = consentFor(true, true)
    expect(CheckoutConsent.safeParse(consent).success).toBe(true)
    expect(CheckoutConsent.safeParse({ terms: TERMS_VERSION, startNow: false }).success).toBe(false)
  })
})
