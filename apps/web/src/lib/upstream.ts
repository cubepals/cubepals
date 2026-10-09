/**
 * The control plane this web app fronts: server-side only. Local development defaults to the
 * control plane's local listener; every deployed environment sets API_UPSTREAM.
 */
export function apiUpstream(): string {
  const upstream =
    process.env.API_UPSTREAM ?? (process.env.NODE_ENV === 'production' ? undefined : 'http://127.0.0.1:4000')
  if (upstream === undefined)
    throw new Error('API_UPSTREAM must name the control plane the /api rewrite forwards to')
  return upstream.replace(/\/$/, '')
}
