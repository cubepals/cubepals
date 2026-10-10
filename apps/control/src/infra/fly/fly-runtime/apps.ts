// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's Fly app: its name, which ties it to one deployment, the app itself on a private
 * network of its own, its Flycast address and its secrets. The app outlives its machines and
 * volumes; those are `machines.ts` and `volumes.ts`.
 */

import type { RuntimeKey } from '../../../app/ports/runtime.ts'
import { FlyApiError, type FlyClient } from '../client.ts'
import { must, succeeded } from './responses.ts'

export const appPrefix = (deployment: string) => `bly-${deployment}-`

export function appName(deployment: string, key: RuntimeKey): string {
  return `${appPrefix(deployment)}${key.replace(/-/g, '')}`
}

/** `bly-<deployment>-<32 hex>` back to the server id, or null for anything else. */
export function keyFromApp(app: string, prefix: string): RuntimeKey | null {
  if (!app.startsWith(prefix)) return null
  const hex = app.slice(prefix.length)
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as RuntimeKey
}

/** Never another deployment's app, whatever a caller passes. */
export function requireOwnApp(app: string, deployment: string): void {
  if (!app.startsWith(appPrefix(deployment)))
    throw new Error(`${app} does not belong to deployment ${deployment}`)
}

export async function ensureApp(
  fly: FlyClient,
  org: string,
  deployment: string,
  app: string,
  key: RuntimeKey,
): Promise<void> {
  const found = await fly.GET('/v1/apps/{app_name}', { params: { path: { app_name: app } } })
  if (found.response.ok) return
  if (found.response.status !== 404)
    throw new FlyApiError(found.response.status, `reading ${app}`, found.error)
  // Its own network: machines of different servers cannot reach each other.
  succeeded(
    await fly.POST('/v1/apps', {
      body: {
        name: app,
        org_slug: org,
        network: app,
        enable_subdomains: false,
        idempotency_key: `${deployment}:${key}`,
      },
    }),
    `creating ${app}`,
  )
}

/** A Flycast address on the organization's default network, and no public address at all. */
export async function ensureFlycast(fly: FlyClient, org: string, app: string): Promise<void> {
  const assigned = must(
    await fly.GET('/v1/apps/{app_name}/ip_assignments', { params: { path: { app_name: app } } }),
    'listing addresses',
  )
  if ((assigned.ips ?? []).some((ip) => ip.ip?.startsWith('fdaa:'))) return
  succeeded(
    await fly.POST('/v1/apps/{app_name}/ip_assignments', {
      params: { path: { app_name: app } },
      body: { type: 'private_v6', org_slug: org },
    }),
    'allocating the Flycast address',
  )
}

/** App secrets, so they never sit in a machine's config. Returns the version machines must see. */
export async function setSecrets(
  fly: FlyClient,
  app: string,
  secrets: Readonly<Record<string, string>>,
): Promise<number | undefined> {
  if (Object.keys(secrets).length === 0) return undefined
  const updated = must(
    await fly.POST('/v1/apps/{app_name}/secrets', {
      params: { path: { app_name: app } },
      body: { values: { ...secrets } },
    }),
    'setting secrets',
  )
  return updated.version
}

export async function deleteApp(fly: FlyClient, app: string): Promise<void> {
  succeeded(
    await fly.DELETE('/v1/apps/{app_name}', { params: { path: { app_name: app } } }),
    `deleting ${app}`,
    404,
  )
}
