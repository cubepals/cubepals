// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Local development (docs/local-development.md): a deployment whose web app is on this machine or
 * its local network, as `bun run dev` and `bun run dev:lan` serve it. Nothing deployed is, since
 * a deployed origin must be https on a public name.
 *
 * Here, what would need an outside account is stood in for or left off, and each choice is one
 * line for the log. A deployment gets none of it: it refuses what this would have covered.
 */
import { PAID_PLANS } from '../domain/account/entitlements.ts'
import { type DeploymentConfig, isLocal, LOCAL_ONLY, PolarConfig } from './schema.ts'

/** Whether WEB_CANONICAL_ORIGIN is on this machine or its local network. */
export function isLocalDeployment(env: NodeJS.ProcessEnv): boolean {
  try {
    return isLocal(new URL(env.WEB_CANONICAL_ORIGIN ?? '').hostname)
  } catch {
    return false
  }
}

/**
 * The local checkout, unless LOCAL_BILLING=polar asks for Polar's sandbox: its webhooks never reach
 * this machine, so a checkout there would upgrade nobody here. Asked for, Polar when every one of
 * its values is there and right, and the local checkout otherwise, so that a half-filled .env never
 * stops the stack. Either way, the line that says which and why.
 */
export function localBilling(
  polar: Record<string, unknown> | null,
  wanted: string | undefined,
): { billing: unknown; note: string } {
  const standIn = { provider: 'local' }
  if (wanted !== 'polar')
    return {
      billing: standIn,
      note: `Payments: the local checkout. Upgrade grants a plan, Manage billing cancels it.${polar === null ? '' : " LOCAL_BILLING=polar uses Polar's values instead."}`,
    }
  if (polar === null)
    return {
      billing: standIn,
      note: 'Payments: LOCAL_BILLING=polar, but no Polar values, so the local checkout.',
    }
  const parsed = PolarConfig.safeParse(polar)
  const problems = parsed.success
    ? PAID_PLANS.filter((plan) => !(plan in parsed.data.products)).map(
        (plan) => `POLAR_PRODUCTS: nothing sells ${plan}`,
      )
    : parsed.error.issues.map((issue) => `${polarName(issue.path)}: ${issue.message}`)
  if (problems.length === 0) return { billing: polar, note: `Payments: Polar's ${polar.server} server.` }
  return {
    billing: standIn,
    note: `Payments: Polar's values are incomplete (${problems.join('; ')}), so the local checkout stands in.`,
  }
}

/** The variable a Polar setting comes from, for a note that says what to fix. */
function polarName(path: readonly PropertyKey[]): string {
  const names: Record<string, string> = {
    accessToken: 'POLAR_ACCESS_TOKEN',
    webhookSecret: 'POLAR_WEBHOOK_SECRET',
    server: 'POLAR_SERVER',
    products: 'POLAR_PRODUCTS',
  }
  return names[String(path[0])] ?? String(path[0])
}

/** What else stands in for an outside service here, or is left off, one line each. */
export function localNotes(env: NodeJS.ProcessEnv): string[] {
  const notes = ['Sign-up: no cap on free accounts.']
  if (!env.AUTH_GOOGLE_CLIENT_ID)
    notes.push('Sign-in: Google is off (no AUTH_GOOGLE_CLIENT_ID). Email works.')
  if (!env.AUTH_GITHUB_CLIENT_ID)
    notes.push('Sign-in: GitHub is off (no AUTH_GITHUB_CLIENT_ID). Email works.')
  // The host alone: a URL can carry a password.
  const smtp = URL.parse(env.SMTP_URL ?? '')?.host ?? 'SMTP_URL'
  notes.push(`Mail: sent to ${smtp}. With docker compose, Mailpit shows it at http://localhost:8025.`)
  if (!env.ARCHIVE_S3_ENDPOINT)
    notes.push('Archives: off (no ARCHIVE_S3_ENDPOINT). Backups, uploads and downloads are unavailable.')
  return notes
}

/**
 * What only local development may have, refused anywhere else: the local checkout, which grants
 * plans for nothing, and .env.example's secrets, which anyone can read.
 */
export function localOnly(config: DeploymentConfig): string[] {
  if (config.local !== null) return []
  const problems: string[] = []
  if (config.billing?.provider === 'local')
    problems.push('The local checkout grants plans for free. Configure Polar (POLAR_*) or no billing.')
  const secrets = {
    AUTH_SECRET: config.auth.secret,
    REALTIME_TICKET_SECRET: config.realtime.ticketSecret,
    EDGE_TOKEN: config.edge.token,
    RUNTIME_SECRETS_KEY: config.runtimeSecrets.current.key,
  }
  for (const [name, value] of Object.entries(secrets))
    if (value.startsWith(LOCAL_ONLY))
      problems.push(`${name} is the value .env.example gives everyone. Give this deployment its own.`)
  return problems
}
