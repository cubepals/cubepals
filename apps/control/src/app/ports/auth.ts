/**
 * Sign-in and sessions, whoever provides them (Better Auth, in infra/auth). The interfaces serve
 * its endpoints and ask it who a request belongs to; nothing else about it leaks out.
 */
/**
 * The header a request to the auth endpoints carries its client's address in, set by the HTTP
 * layer from what it trusts (interfaces/http/client-address.ts) and never by the caller. Sign-in's
 * limits count each address; without it, everyone shares one.
 */
export const CLIENT_ADDRESS_HEADER = 'x-blockly-client-address'

export interface Authenticator {
  /** Serves the auth endpoints under /api/auth, their client's address in CLIENT_ADDRESS_HEADER. */
  handle(request: Request): Promise<Response>
  /** The account a request's session belongs to; null when it is signed out. */
  userOf(headers: Headers): Promise<string | null>
}
