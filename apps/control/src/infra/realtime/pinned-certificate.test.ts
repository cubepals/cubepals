import { describe, expect, test } from 'bun:test'
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import { mintPinnedCertificate } from './pinned-certificate.ts'

// What Chrome requires of a certificate pinned with serverCertificateHashes: ECDSA P-256 and a
// validity of at most 14 days. The browser test is in docs/dependency-audit.md.
describe('mintPinnedCertificate', () => {
  test('mints a P-256 certificate valid for 13 days, with its own key and hash', async () => {
    const minted = await mintPinnedCertificate('127.0.0.1')
    const x509 = new X509Certificate(minted.cert)
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(x509.subjectAltName).toBe('IP Address:127.0.0.1')
    expect(x509.ca).toBe(false)
    const days = (new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime()) / 86_400_000
    expect(days).toBeLessThanOrEqual(14)
    expect(days).toBeCloseTo(13, 1)
    expect(x509.checkPrivateKey(createPrivateKey(minted.privKey))).toBe(true)
    expect(minted.sha256).toBe(createHash('sha256').update(x509.raw).digest('hex'))
    expect(minted.expiresAt.getTime()).toBe(new Date(x509.validTo).getTime())
  })

  test('names a host by DNS when it is not an address', async () => {
    const x509 = new X509Certificate((await mintPinnedCertificate('localhost')).cert)
    expect(x509.subjectAltName).toBe('DNS:localhost')
  })
})
