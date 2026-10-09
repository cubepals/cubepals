import { createAuthClient } from 'better-auth/react'

/** Talks to /api/auth on the page's own origin; the rewrite takes it to the control plane. */
export const authClient = createAuthClient()
