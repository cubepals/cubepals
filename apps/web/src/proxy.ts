import { type NextRequest, NextResponse } from 'next/server'
import { CLAIMED, clientAddressHeaders } from './lib/client-address'

/**
 * Every call to the control plane's sign-in endpoints says whose browser it came from
 * (lib/client-address.ts), and nothing the browser claimed about that goes with it. Only
 * /api/auth reads it, so nothing else pays for this hop.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  for (const name of CLAIMED) headers.delete(name)
  for (const [name, value] of Object.entries(clientAddressHeaders(request.headers))) headers.set(name, value)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: '/api/auth/:path*' }
