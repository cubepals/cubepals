// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { X509Certificate } from 'node:crypto'
import { Agent } from 'node:https'
import acme from 'acme-client'
import type { CertificateIssuer, IssuedCertificate } from '../../app/ports/certificates.ts'

/** Puts the DNS-01 TXT record where the CA will look for it, and takes it away again. */
export interface Dns01Solver {
  present(fqdn: string, value: string): Promise<void>
  cleanup(fqdn: string, value: string): Promise<void>
}

/**
 * ACME (RFC 8555) over DNS-01, through `acme-client` (docs/dependency-audit.md): a new account
 * and an ECDSA P-256 key per certificate, which happens every couple of months at most.
 */
export class AcmeIssuer implements CertificateIssuer {
  readonly #directoryUrl: string
  readonly #email: string
  readonly #solver: Dns01Solver
  readonly #verifyTxt: boolean

  constructor(options: {
    directoryUrl: string
    email: string
    solver: Dns01Solver
    /**
     * Whether to see the TXT record through this machine's resolver before asking the CA to look.
     * On for a public DNS provider; off for a test CA whose DNS the machine can't reach.
     */
    verifyTxt?: boolean
    /** A CA certificate to trust for the directory itself: a test CA such as Pebble. */
    directoryCa?: string
  }) {
    this.#directoryUrl = options.directoryUrl
    this.#email = options.email
    this.#solver = options.solver
    this.#verifyTxt = options.verifyTxt ?? true
    // acme-client talks through its own axios instance, which takes an agent for this.
    if (options.directoryCa) acme.axios.defaults.httpsAgent = new Agent({ ca: options.directoryCa })
  }

  async issue(hostname: string): Promise<IssuedCertificate> {
    const client = new acme.Client({
      directoryUrl: this.#directoryUrl,
      accountKey: await acme.crypto.createPrivateEcdsaKey(),
    })
    const [key, csr] = await acme.crypto.createCsr(
      { commonName: hostname, altNames: [hostname] },
      await acme.crypto.createPrivateEcdsaKey(),
    )
    const chain = await client.auto({
      csr,
      email: this.#email,
      // The operator accepted the CA's terms by configuring it (ACME_AGREE_TOS=true).
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      skipChallengeVerification: !this.#verifyTxt,
      challengeCreateFn: async (authz, _challenge, value) =>
        this.#solver.present(`_acme-challenge.${authz.identifier.value}`, value),
      challengeRemoveFn: async (authz, _challenge, value) =>
        this.#solver.cleanup(`_acme-challenge.${authz.identifier.value}`, value),
    })
    const leaf = new X509Certificate(leafOf(chain))
    return {
      certificatePem: chain,
      privateKeyPem: key.toString(),
      notBefore: new Date(leaf.validFrom),
      notAfter: new Date(leaf.validTo),
    }
  }
}

/** The first certificate of a PEM chain: the leaf. */
const leafOf = (chain: string) => {
  const end = '-----END CERTIFICATE-----'
  return chain.slice(0, chain.indexOf(end) + end.length)
}
