/**
 * What the control plane is told about the browser behind a sign-in: its address as this app's
 * host saw it, and the secret that makes the control plane believe it (WEB_PROXY_SECRET). Sign-in's
 * limits count each address, and every request reaches the control plane from this app, so without
 * it everyone would count as one.
 *
 * The header comes from configuration, not from guessing the host: WEB_CLIENT_ADDRESS_HEADER names
 * the one its edge sets and overwrites (`cf-connecting-ip` on Cloudflare, `fly-client-ip` on Fly). Any other
 * header a browser could write itself.
 */
export function clientAddressHeaders(incoming: Headers): Record<string, string> {
  const secret = process.env.WEB_PROXY_SECRET
  const hostHeader = process.env.WEB_CLIENT_ADDRESS_HEADER
  if (!secret || !hostHeader) return {}
  const address = incoming.get(hostHeader)?.trim()
  if (!address) return {}
  return { 'x-blockly-client': address, 'x-blockly-proxy': secret }
}

/** The headers a browser sent that name its own address to the control plane; never passed on. */
export const CLAIMED = ['x-blockly-client', 'x-blockly-proxy', 'x-blockly-client-address'] as const
