// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A certificate a CA issued for a hostname, with its private key. */
export interface IssuedCertificate {
  /** The leaf first, then its chain. */
  certificatePem: string
  privateKeyPem: string
  notBefore: Date
  notAfter: Date
}

/**
 * Gets a CA-issued certificate for a hostname this deployment controls (§11: the realtime role's
 * `acme` TLS mode). Slow and rate-limited by the CA: callers keep what it returns.
 */
export interface CertificateIssuer {
  issue(hostname: string): Promise<IssuedCertificate>
}
