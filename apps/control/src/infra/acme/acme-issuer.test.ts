// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { acmeCertificate } from '../../app/realtime/certificate.ts'
import { singleKey } from '../../app/secrets.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ChallengeTestDns, PEBBLE_LISTENER_CA, pebble } from '../../testing/pebble.ts'
import { AcmeIssuer } from './acme-issuer.ts'

const leafOf = (chain: string) =>
  new X509Certificate(chain.slice(0, chain.indexOf('-----END CERTIFICATE-----') + 25))

// ACME DNS-01 against Pebble, Let's Encrypt's test CA, whose validator resolves TXT records from
// pebble-challtestsrv: the real protocol and the realtime role's store-or-issue rule (§11).
describe.skipIf(!pebble || !hasDatabase)('ACME certificates', () => {
  let h: Harness
  let dns: ChallengeTestDns
  let issuer: AcmeIssuer
  const key = 'a-deployment-key-long-enough-to-use'

  beforeAll(async () => {
    h = await startHarness()
    dns = new ChallengeTestDns(pebble?.dnsUrl ?? '')
    issuer = new AcmeIssuer({
      directoryUrl: pebble?.directoryUrl ?? '',
      email: 'ops@blockly.test',
      solver: dns,
      verifyTxt: false,
      directoryCa: PEBBLE_LISTENER_CA,
    })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('the CA issues a certificate for the hostname after checking its TXT record', async () => {
    const hostname = `rt-${randomUUID().slice(0, 8)}.blockly.test`
    const issued = await issuer.issue(hostname)
    expect(dns.presented).toContain(`_acme-challenge.${hostname}`)
    const leaf = leafOf(issued.certificatePem)
    expect(leaf.subjectAltName).toBe(`DNS:${hostname}`)
    expect(leaf.issuer).toContain('Pebble')
    expect(leaf.checkPrivateKey(createPrivateKey(issued.privateKeyPem))).toBe(true)
    expect(issued.notAfter.getTime()).toBeGreaterThan(Date.now())
  }, 60_000)

  test('the realtime role stores what it got, reuses it across restarts, and renews it in time', async () => {
    const hostname = `rt-${randomUUID().slice(0, 8)}.blockly.test`
    const first = await acmeCertificate(h.db, issuer, { hostname, secrets: singleKey(key) })
    expect(first.issued).toBe(true)
    const [row] = await h.db
      .select()
      .from(schema.realtimeCertificate)
      .where(eq(schema.realtimeCertificate.id, 1))
    expect(row?.hostname).toBe(hostname)
    // The key is kept sealed, never as PEM.
    expect(row?.privateKeySealed).not.toContain('PRIVATE KEY')

    // A restart: the same certificate, no CA involved.
    const again = await acmeCertificate(h.db, issuer, { hostname, secrets: singleKey(key) })
    expect(again).toMatchObject({ issued: false, cert: first.cert, privKey: first.privKey })

    // Two thirds of its life on, or another hostname, or another deployment key: a new one.
    const late = new Date(first.renewAt.getTime() + 1_000)
    const renewed = await acmeCertificate(h.db, issuer, { hostname, secrets: singleKey(key) }, late)
    expect(renewed.issued).toBe(true)
    expect(renewed.cert).not.toBe(first.cert)
    const moved = await acmeCertificate(h.db, issuer, {
      hostname: `other-${hostname}`,
      secrets: singleKey(key),
    })
    expect(moved.issued).toBe(true)
    // A key rotation keeps the certificate, sealed again under the new key, so the old key can go.
    const newKey = 'the-rotated-deployment-key-v2'
    const rotating = { current: { version: 2, key: newKey }, previous: [{ version: 1, key }] }
    const kept = await acmeCertificate(h.db, issuer, { hostname: `other-${hostname}`, secrets: rotating })
    expect(kept).toMatchObject({ issued: false, cert: moved.cert })
    const rotated = await acmeCertificate(h.db, issuer, {
      hostname: `other-${hostname}`,
      secrets: singleKey(newKey),
    })
    expect(rotated).toMatchObject({ issued: false, cert: moved.cert })
    const rekeyed = await acmeCertificate(h.db, issuer, {
      hostname: `other-${hostname}`,
      secrets: singleKey('a-different-deployment-key-for-this'),
    })
    expect(rekeyed.issued).toBe(true)
  }, 120_000)
})
