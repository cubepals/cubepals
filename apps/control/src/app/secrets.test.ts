import { describe, expect, test } from 'bun:test'
import { openSecret, sealSecret } from './secrets.ts'

describe('sealed secrets', () => {
  const key = 'a-deployment-key-long-enough-to-use'

  test('open what was sealed, under the same key and purpose only', () => {
    const sealed = sealSecret(key, 'realtime-tls-key', 'the private key')
    expect(sealed).not.toContain('the private key')
    expect(openSecret(key, 'realtime-tls-key', sealed)).toBe('the private key')
    expect(openSecret('another-deployment-key-entirely', 'realtime-tls-key', sealed)).toBeNull()
    expect(openSecret(key, 'another-purpose', sealed)).toBeNull()
    // Each seal is fresh.
    expect(sealSecret(key, 'realtime-tls-key', 'the private key')).not.toBe(sealed)
  })

  test('a tampered or malformed seal opens to nothing', () => {
    const [version, iv, tag, body] = sealSecret(key, 'p', 'secret').split('.')
    const flipped = `${body?.[0] === 'A' ? 'B' : 'A'}${body?.slice(1)}`
    expect(openSecret(key, 'p', [version, iv, tag, flipped].join('.'))).toBeNull()
    expect(openSecret(key, 'p', 'not a seal')).toBeNull()
    expect(openSecret(key, 'p', ['v2', iv, tag, body].join('.'))).toBeNull()
  })
})
