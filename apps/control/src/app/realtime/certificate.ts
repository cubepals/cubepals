import { X509Certificate } from 'node:crypto'
import { type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CertificateIssuer } from '../ports/certificates.ts'
import { openSealed, openSecret, type SecretKeyring, sealSecret } from '../secrets.ts'

const certificates = schema.realtimeCertificate

/**
 * The realtime role publishes its pinned certificate's hash here; the api role hands it to
 * browsers. They may run in different processes. A pinned certificate is never stored itself.
 */
export async function publishCertificate(q: Queryable, sha256: string, expiresAt: Date): Promise<void> {
  const values = {
    id: 1,
    sha256,
    expiresAt,
    hostname: null,
    certificatePem: null,
    privateKeySealed: null,
    issuedAt: null,
    updatedAt: new Date(),
  }
  await q.insert(certificates).values(values).onConflictDoUpdate({ target: certificates.id, set: values })
}

export async function currentCertificate(q: Queryable, now = new Date()): Promise<string | null> {
  const [row] = await q.select().from(certificates).where(eq(certificates.id, 1))
  return row && row.expiresAt > now ? row.sha256 : null
}

/** Sealed private keys are for this and nothing else. */
const KEY_PURPOSE = 'realtime-tls-key'

export interface ServedCertificate {
  cert: string
  privKey: string
  /** When to get the next one: once two thirds of this one's life have passed. */
  renewAt: Date
  /** Whether the CA was asked this time, rather than the stored one reused. */
  issued: boolean
}

/**
 * The certificate the realtime role serves in `acme` mode (§11). The stored one while it is for
 * this hostname and a third of its life is left; otherwise a new one from the CA, stored before
 * it is used, so restarts don't spend the CA's rate limits. Renewing at two thirds of the
 * lifetime keeps working as CAs shorten it.
 */
export async function acmeCertificate(
  q: Queryable,
  issuer: CertificateIssuer,
  settings: { hostname: string; secrets: SecretKeyring },
  now = new Date(),
): Promise<ServedCertificate> {
  const [row] = await q.select().from(certificates).where(eq(certificates.id, 1))
  if (row?.hostname === settings.hostname && row.certificatePem && row.privateKeySealed && row.issuedAt) {
    const privKey = openSealed(settings.secrets, KEY_PURPOSE, row.privateKeySealed)
    const renewAt = renewalOf(row.issuedAt, row.expiresAt)
    if (privKey !== null && renewAt > now) {
      // Sealed under a key being rotated out: sealed again under the current one, so dropping
      // the old key later doesn't cost a new certificate.
      if (openSecret(settings.secrets.current.key, KEY_PURPOSE, row.privateKeySealed) === null)
        await q
          .update(certificates)
          .set({ privateKeySealed: sealSecret(settings.secrets.current.key, KEY_PURPOSE, privKey) })
          .where(eq(certificates.id, 1))
      return { cert: row.certificatePem, privKey, renewAt, issued: false }
    }
  }
  const issued = await issuer.issue(settings.hostname)
  const leaf = new X509Certificate(leafOf(issued.certificatePem))
  const values = {
    id: 1,
    sha256: leaf.fingerprint256.replaceAll(':', '').toLowerCase(),
    expiresAt: issued.notAfter,
    hostname: settings.hostname,
    certificatePem: issued.certificatePem,
    privateKeySealed: sealSecret(settings.secrets.current.key, KEY_PURPOSE, issued.privateKeyPem),
    issuedAt: issued.notBefore,
    updatedAt: new Date(),
  }
  await q.insert(certificates).values(values).onConflictDoUpdate({ target: certificates.id, set: values })
  return {
    cert: issued.certificatePem,
    privKey: issued.privateKeyPem,
    renewAt: renewalOf(issued.notBefore, issued.notAfter),
    issued: true,
  }
}

const renewalOf = (from: Date, to: Date) => new Date(to.getTime() - (to.getTime() - from.getTime()) / 3)

/** The first certificate of a PEM chain: the leaf. */
const leafOf = (chain: string) => {
  const end = '-----END CERTIFICATE-----'
  return chain.slice(0, chain.indexOf(end) + end.length)
}
