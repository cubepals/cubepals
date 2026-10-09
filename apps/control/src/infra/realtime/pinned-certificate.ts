import { createHash, X509Certificate } from 'node:crypto'
import selfsigned from 'selfsigned'

export interface PinnedCertificate {
  cert: string
  privKey: string
  sha256: string
  expiresAt: Date
}

/**
 * A self-signed ECDSA P-256 certificate for WebTransport pinning. Browsers accept a pinned
 * certificate valid for at most 14 days, so it is minted for 13 and the process restarts before
 * it lapses.
 *
 * Minted by `selfsigned` (@peculiar/x509 underneath) rather than the `openssl` binary, so the
 * image needs no openssl and nothing is written to disk (docs/dependency-audit.md).
 */
export async function mintPinnedCertificate(hostname: string, days = 13): Promise<PinnedCertificate> {
  // A minute early, so a server clock slightly ahead of the browser's is still accepted.
  const notBeforeDate = new Date(Date.now() - 60_000)
  const notAfterDate = new Date(notBeforeDate.getTime() + days * 86_400_000)
  const altName = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    ? { type: 7 as const, ip: hostname }
    : { type: 2 as const, value: hostname }
  const pems = await selfsigned.generate([{ name: 'commonName', value: hostname }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [altName] },
    ],
  })
  const x509 = new X509Certificate(pems.cert)
  return {
    cert: pems.cert,
    privKey: pems.private,
    sha256: createHash('sha256').update(x509.raw).digest('hex'),
    expiresAt: new Date(x509.validTo),
  }
}
