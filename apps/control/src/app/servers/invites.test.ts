import { describe, expect, test } from 'bun:test'
import { InviteCode } from '@blockly/contracts'
import { looksLikeInviteCode, newInviteCode } from './invites.ts'

describe('invite codes', () => {
  test('every code the generator makes is one the API accepts', () => {
    // Codes with an `i` were generated and then refused by the API's pattern, one link in three.
    const codes = Array.from({ length: 2_000 }, newInviteCode)
    for (const code of codes) {
      expect(looksLikeInviteCode(code)).toBe(true)
      expect(InviteCode.safeParse(code).success).toBe(true)
    }
    expect(new Set(codes).size).toBe(codes.length)
  })

  test('the characters people misread are never in one, and nothing else is refused', () => {
    expect(InviteCode.safeParse('abcdefghijkm').success).toBe(true)
    expect(InviteCode.safeParse('npqrstuvwxyz').success).toBe(true)
    expect(InviteCode.safeParse('234567892345').success).toBe(true)
    for (const misread of ['l', '0', '1']) {
      const code = `abcdefghijk${misread}`
      expect(InviteCode.safeParse(code).success && looksLikeInviteCode(code)).toBe(false)
    }
  })
})
