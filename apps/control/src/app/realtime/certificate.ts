// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { X509Certificate } from 'node:crypto'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { recordJobFailed, recordJobSucceeded } from '../platform/persistence.ts'
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

/** Where each renewal's outcome is written down (`job_health`), for the expiry alert to quote. */
export const CERTIFICATE_RENEWAL = 'realtime-certificate'
/** How soon before a stored certificate lapses admins hear it hasn't been renewed. */
export const CERTIFICATE_WARN_MS = 7 * DAY_MS
/** How long after a renewal the CA refused it is asked again, the stored one served meanwhile. */
const RETRY_MS = HOUR_MS
/** The longest delay a Node timer holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface ServedCertificate {
  cert: string
  privKey: string
  /** When to ask the CA next: two thirds into this one's life, or an hour after a refusal. */
  renewAt: Date
  /** Whether the CA was asked this time, rather than the stored one reused. */
  issued: boolean
}

/**
 * The certificate the realtime role serves in `acme` mode (§11). The stored one while it is for
 * this hostname and a third of its life is left; otherwise a new one from the CA, stored before
 * it is used, so restarts don't spend the CA's rate limits. Renewing at two thirds of the
 * lifetime keeps working as CAs shorten it. A renewal the CA refuses (it, or the DNS it checks,
 * being down) serves the stored one while it is still valid and asks again in an hour; the
 * `realtime_certificate_expiring` alert says so a week before it lapses.
 */
export async function acmeCertificate(
  q: Queryable,
  issuer: CertificateIssuer,
  settings: { hostname: string; secrets: SecretKeyring },
  now = new Date(),
): Promise<ServedCertificate> {
  const stored = await storedFor(q, settings)
  if (stored !== null && stored.renewAt > now)
    return { cert: stored.cert, privKey: stored.privKey, renewAt: stored.renewAt, issued: false }
  let issued: Awaited<ReturnType<CertificateIssuer['issue']>>
  try {
    issued = await issuer.issue(settings.hostname)
  } catch (error) {
    await recordJobFailed(q, CERTIFICATE_RENEWAL, now, error instanceof Error ? error.message : String(error))
    if (stored === null || stored.expiresAt <= now) throw error
    console.error(
      `realtime certificate: renewal failed; serving the stored one until ${stored.expiresAt.toISOString()} and asking again in an hour`,
      error,
    )
    const retryAt = Math.min(now.getTime() + RETRY_MS, stored.expiresAt.getTime())
    return { cert: stored.cert, privKey: stored.privKey, renewAt: new Date(retryAt), issued: false }
  }
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
  await recordJobSucceeded(q, CERTIFICATE_RENEWAL, now)
  return {
    cert: issued.certificatePem,
    privKey: issued.privateKeyPem,
    renewAt: renewalOf(issued.notBefore, issued.notAfter),
    issued: true,
  }
}

/**
 * The stored certificate, when it is for this hostname and its key opens: when to renew it and
 * when it lapses. One sealed under a key being rotated out is sealed again under the current one,
 * so dropping the old key later doesn't cost a new certificate.
 */
async function storedFor(
  q: Queryable,
  settings: { hostname: string; secrets: SecretKeyring },
): Promise<{ cert: string; privKey: string; renewAt: Date; expiresAt: Date } | null> {
  const [row] = await q.select().from(certificates).where(eq(certificates.id, 1))
  if (row?.hostname !== settings.hostname || !row.certificatePem || !row.privateKeySealed || !row.issuedAt)
    return null
  const privKey = openSealed(settings.secrets, KEY_PURPOSE, row.privateKeySealed)
  if (privKey === null) return null
  if (openSecret(settings.secrets.current.key, KEY_PURPOSE, row.privateKeySealed) === null)
    await q
      .update(certificates)
      .set({ privateKeySealed: sealSecret(settings.secrets.current.key, KEY_PURPOSE, privKey) })
      .where(eq(certificates.id, 1))
  const renewAt = renewalOf(row.issuedAt, row.expiresAt)
  return { cert: row.certificatePem, privKey, renewAt, expiresAt: row.expiresAt }
}

/**
 * What the realtime role serves in `acme` mode as it starts (`acmeCertificate`), kept renewed as
 * it comes due, in this process: once a newer one is stored, `renewed` (the role exits, and its
 * next start serves it); while the CA refuses, the served one stays and the CA is asked again an
 * hour later.
 */
export async function servedAcme(
  q: Queryable,
  issuer: CertificateIssuer,
  settings: { hostname: string; secrets: SecretKeyring },
  renewed: () => void,
): Promise<{ cert: string; privKey: string }> {
  const served = await acmeCertificate(q, issuer, settings)
  if (served.issued) console.warn(`issued a realtime certificate for ${settings.hostname}`)
  keepRenewed(q, issuer, settings, served, renewed)
  return { cert: served.cert, privKey: served.privKey }
}

/** Asks the CA as `served` comes due, and again after each refusal, until a newer one is stored. */
function keepRenewed(
  q: Queryable,
  issuer: CertificateIssuer,
  settings: { hostname: string; secrets: SecretKeyring },
  served: ServedCertificate,
  renewed: () => void,
): void {
  const again = (renewAt: Date) => keepRenewed(q, issuer, settings, { ...served, renewAt }, renewed)
  const attempt = () =>
    acmeCertificate(q, issuer, settings).then(
      (next) => (next.issued || next.cert !== served.cert ? renewed() : again(next.renewAt)),
      (error: unknown) => {
        console.error('realtime certificate: renewal failed', error)
        again(new Date(Date.now() + RETRY_MS))
      },
    )
  const wait = served.renewAt.getTime() - Date.now()
  // A wait longer than a timer holds is waited out in steps.
  if (wait > MAX_TIMER_MS) setTimeout(() => again(served.renewAt), MAX_TIMER_MS).unref()
  else setTimeout(() => void attempt(), Math.max(0, wait)).unref()
}

/** The stored certificate an `acme` realtime role serves, for the expiry alert; null for a pinned one. */
export async function storedAcmeCertificate(
  q: Queryable,
): Promise<{ hostname: string; expiresAt: Date } | null> {
  const [row] = await q.select().from(certificates).where(eq(certificates.id, 1))
  if (!row?.hostname || row.certificatePem === null) return null
  return { hostname: row.hostname, expiresAt: row.expiresAt }
}

const renewalOf = (from: Date, to: Date) => new Date(to.getTime() - (to.getTime() - from.getTime()) / 3)

/** The first certificate of a PEM chain: the leaf. */
const leafOf = (chain: string) => {
  const end = '-----END CERTIFICATE-----'
  return chain.slice(0, chain.indexOf(end) + end.length)
}
