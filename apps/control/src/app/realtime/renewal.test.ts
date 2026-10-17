// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In `acme` mode the realtime role renews its certificate at two thirds of its life. A renewal the
 * CA doesn't answer (the CA, Cloudflare's DNS API, or the DNS-01 token having a bad day) keeps
 * the stored certificate served while it is still valid, and the CA is asked again later, rather
 * than the start failing and every restart spending the CA's rate limit on failed orders.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { CertificateIssuer } from '../ports/certificates.ts'
import { singleKey } from '../secrets.ts'
import { acmeCertificate } from './certificate.ts'

const HOSTNAME = 'rt.example.test'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)
afterAll(async () => {
  if (hasDatabase) await h.close()
})

describe.skipIf(!hasDatabase)('a renewal the CA does not answer', () => {
  test('keeps serving the stored certificate while it is still valid', async () => {
    const secrets = singleKey('k'.repeat(32))
    const pem = await mintPinnedCertificate(HOSTNAME, 13)
    const issuedAt = new Date('2026-01-01T00:00:00Z')
    const notAfter = new Date(issuedAt.getTime() + 90 * DAY_MS)
    let asked = 0
    const working: CertificateIssuer = {
      issue: async () => {
        asked++
        return { certificatePem: pem.cert, privateKeyPem: pem.privKey, notBefore: issuedAt, notAfter }
      },
    }
    // The first start: issued and stored.
    await acmeCertificate(h.db, working, { hostname: HOSTNAME, secrets }, issuedAt)
    expect(asked).toBe(1)

    // Day 61, past two thirds: the process exited to renew, and the CA doesn't answer.
    const day61 = new Date(issuedAt.getTime() + 61 * DAY_MS)
    const down: CertificateIssuer = {
      issue: async () => {
        throw new Error('acme: the order failed (urn:ietf:params:acme:error:serverInternal)')
      },
    }
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const served = await acmeCertificate(h.db, down, { hostname: HOSTNAME, secrets }, day61)
      .then(
        (s) => s,
        (error: Error) => `threw: ${error.message}`,
      )
      .finally(() => quiet.mockRestore())
    // 29 days of validity left: the start goes on with it, and asks the CA again in an hour.
    expect(typeof served === 'string' ? served : served.cert).toBe(pem.cert)
    expect(typeof served === 'string' ? null : served.renewAt).toEqual(new Date(day61.getTime() + HOUR_MS))
  })

  test('fails the start once the stored certificate has lapsed', async () => {
    const secrets = singleKey('k'.repeat(32))
    const down: CertificateIssuer = {
      issue: async () => {
        throw new Error('acme: the order failed')
      },
    }
    const day91 = new Date(new Date('2026-01-01T00:00:00Z').getTime() + 91 * DAY_MS)
    await expect(acmeCertificate(h.db, down, { hostname: HOSTNAME, secrets }, day91)).rejects.toThrow(
      'acme: the order failed',
    )
  })
})
