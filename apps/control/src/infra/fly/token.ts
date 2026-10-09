/**
 * A Fly token read the way fly-go's tokens package reads one: an optional `FlyV1` or `Bearer`
 * scheme, then comma-separated macaroons (fm1r_, fm1a_, fm2_) and user tokens. Macaroons are sent
 * as `FlyV1` and win when both are present; the log history API refuses a mixed header (checked
 * 2026-09-19). NATS takes the same value without a scheme.
 */
export interface FlyCredentials {
  authorization: string
  natsPassword: string
}

const MACAROON = /^(?:fm1r|fm1a|fm2)_/

export function flyCredentials(token: string): FlyCredentials {
  const parts = token
    .trim()
    .replace(/^(?:(?:FlyV1|Bearer)\s+)+/i, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const macaroons = parts.filter((part) => MACAROON.test(part))
  if (macaroons.length > 0)
    return { authorization: `FlyV1 ${macaroons.join(',')}`, natsPassword: macaroons.join(',') }
  return { authorization: `Bearer ${parts.join(',')}`, natsPassword: parts.join(',') }
}
