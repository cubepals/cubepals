import type { AuthMethods } from '@blockly/contracts'
import { apiUpstream } from '../../lib/upstream'

/**
 * Which ways in this deployment offers, asked of the control plane on each request, so turning
 * Google or GitHub on or off is configuration there and needs no web deploy.
 */
export async function authMethods(): Promise<AuthMethods> {
  try {
    const response = await fetch(`${apiUpstream()}/api/auth-methods`, { cache: 'no-store' })
    if (response.ok) return (await response.json()) as AuthMethods
  } catch {
    // The control plane is unreachable. Email still renders, and says so if someone uses it.
  }
  return { google: false, github: false }
}

/**
 * Whether sign-up has room for another free account (docs/money-guards.md), as the control plane
 * says. When it can't be asked, or its answer can't be read, the answer is `unknown` and sign-up
 * waits: a form that shows while nobody can say whether there's room is a promise nobody checked.
 */
export async function signupsOpen(): Promise<'open' | 'full' | 'unknown'> {
  try {
    const response = await fetch(`${apiUpstream()}/api/signups`, { cache: 'no-store' })
    if (!response.ok) return 'unknown'
    const { open } = (await response.json()) as { open?: unknown }
    if (typeof open === 'boolean') return open ? 'open' : 'full'
  } catch {
    // The control plane is unreachable: below, as unknown.
  }
  return 'unknown'
}

type Param = string | string[] | undefined

export const firstParam = (value: Param): string | null => (Array.isArray(value) ? value[0] : value) ?? null

/** A place to go after signing in, kept to paths on this origin: never `//host` or `/\host`. */
export function localPath(value: Param): string | null {
  const path = firstParam(value)
  return path?.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : null
}
