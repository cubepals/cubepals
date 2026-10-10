// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pebble, Let's Encrypt's test CA, and its DNS test server: stand-ins for a real CA and DNS provider
 * in the ACME tests. The root below signs Pebble's own HTTPS listener; it is public, published in
 * https://github.com/letsencrypt/pebble/blob/main/test/certs/pebble.minica.pem (valid until 2125).
 */
export const PEBBLE_LISTENER_CA = `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIIU0Xm9UFdQxUwDQYJKoZIhvcNAQELBQAwIDEeMBwGA1UE
AxMVbWluaWNhIHJvb3QgY2EgNTM0NWU2MCAXDTI1MDkwMzIzNDAwNVoYDzIxMjUw
OTAzMjM0MDA1WjAgMR4wHAYDVQQDExVtaW5pY2Egcm9vdCBjYSA1MzQ1ZTYwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5WgZNoVJandj43kkLyU50vzCZ
alozvdRo3OFiKoDtmqKPNWRNO2hC9AUNxTDJco51Yc42u/WV3fPbbhSznTiOOVtn
Ajm6iq4I5nZYltGGZetGDOQWr78y2gWY+SG078MuOO2hyDIiKtVc3xiXYA+8Hluu
9F8KbqSS1h55yxZ9b87eKR+B0zu2ahzBCIHKmKWgc6N13l7aDxxY3D6uq8gtJRU0
toumyLbdzGcupVvjbjDP11nl07RESDWBLG1/g3ktJvqIa4BWgU2HMh4rND6y8OD3
Hy3H8MY6CElL+MOCbFJjWqhtOxeFyZZV9q3kYnk9CAuQJKMEGuN4GU6tzhW1AgMB
AAGjezB5MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATASBgNV
HRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSu8RGpErgYUoYnQuwCq+/ggTiEjDAf
BgNVHSMEGDAWgBSu8RGpErgYUoYnQuwCq+/ggTiEjDANBgkqhkiG9w0BAQsFAAOC
AQEAXDVYov1+f6EL7S41LhYQkEX/GyNNzsEvqxE9U0+3Iri5JfkcNOiA9O9L6Z+Y
bqcsXV93s3vi4r4WSWuc//wHyJYrVe5+tK4nlFpbJOvfBUtnoBDyKNxXzZCxFJVh
f9uc8UejRfQMFbDbhWY/x83y9BDufJHHq32OjCIN7gp2UR8rnfYvlz7Zg4qkJBsn
DG4dwd+pRTCFWJOVIG0JoNhK3ZmE7oJ1N4H38XkZ31NPcMksKxpsLLIS9+mosZtg
4olL7tMPJklx5ZaeMFaKRDq4Gdxkbw4+O4vRgNm3Z8AXWKknOdfgdpqLUPPhRcP4
v1lhy71EhBuXXwRQJry0lTdF+w==
-----END CERTIFICATE-----
`

/** The ACME directory and the DNS test server, where both run (see .github/workflows/ci.yml). */
export const pebble =
  process.env.PEBBLE_TEST_URL && process.env.CHALLTESTSRV_TEST_URL
    ? { directoryUrl: process.env.PEBBLE_TEST_URL, dnsUrl: process.env.CHALLTESTSRV_TEST_URL }
    : null

/** DNS-01 through pebble-challtestsrv's management API: what Pebble's validator resolves. */
export class ChallengeTestDns {
  readonly #url: string
  readonly presented: string[] = []

  constructor(url: string) {
    this.#url = url.replace(/\/$/, '')
  }

  async present(fqdn: string, value: string): Promise<void> {
    this.presented.push(fqdn)
    await this.#post('/set-txt', { host: `${fqdn}.`, value })
  }

  async cleanup(fqdn: string): Promise<void> {
    await this.#post('/clear-txt', { host: `${fqdn}.` })
  }

  async #post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.#url}${path}`, { method: 'POST', body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`challtestsrv ${path} answered ${response.status}`)
  }
}
