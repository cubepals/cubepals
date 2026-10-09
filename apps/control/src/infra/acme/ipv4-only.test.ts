import { describe, expect, test } from 'bun:test'
import { assertIpv4Only } from './ipv4-only.ts'

const failing = (code: string) => async () => {
  throw Object.assign(new Error(code), { code })
}

describe('the realtime hostname is A-only', () => {
  test('no AAAA record, or no such name yet, passes', async () => {
    await assertIpv4Only('rt.example.test', async () => [])
    await assertIpv4Only('rt.example.test', failing('ENODATA'))
    await assertIpv4Only('rt.example.test', failing('ENOTFOUND'))
  })

  test('an AAAA record stops the start, and says which', async () => {
    await expect(assertIpv4Only('rt.example.test', async () => ['2a09:8280:1::1'])).rejects.toThrow(
      /rt.example.test has an AAAA record \(2a09:8280:1::1\)/,
    )
  })

  test('a resolver that fails for another reason is not taken as "no record"', async () => {
    await expect(assertIpv4Only('rt.example.test', failing('ETIMEOUT'))).rejects.toThrow('ETIMEOUT')
  })
})
