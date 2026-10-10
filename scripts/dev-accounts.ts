// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test accounts for local development, one per plan: `bun run dev:accounts`, with `bun run dev`
 * running (docs/local-development.md).
 *
 * Each is made the way a person makes one: sign-up agreeing to the Terms, then the confirmation
 * link Mailpit caught. A paid one is put on its plan the way a person buys it, through Upgrade's
 * checkout, which locally is the local checkout. Run again, it resets them: each signs in with
 * its saved password (or gets it back through a reset link), has its email confirmed, and is put
 * back on its plan.
 *
 * Passwords go to local/dev/accounts.json, which git ignores. The terminal shows only where.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { TERMS_VERSION } from '@blockly/contracts'
import { PLAN_KEYS } from '../apps/control/src/domain/account/entitlements.ts'
import { people } from './lib/people.ts'

const WEB = process.env.WEB_CANONICAL_ORIGIN ?? 'http://localhost:3000'
const MAILPIT = process.env.DEV_MAILPIT ?? 'http://localhost:8025'
const SAVED = 'local/dev/accounts.json'

const say = (line: string) => process.stdout.write(`${line}\n`)
const title = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)

const { auth, apiAs, cookiesOf, mailedLink } = people(WEB, MAILPIT)

let saved: Record<string, string> = {}
try {
  saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, string>
} catch {
  // None yet: every account gets a new password.
}

/** Forgets what Mailpit holds for `email`, so the next link read is the one asked for now. */
const forgetMail = (email: string) =>
  fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: 'DELETE' })

const signIn = async (email: string, password: string) =>
  cookiesOf(await auth('sign-in/email', { email, password }))

/** A session for the account, made, or given `password` again through a reset link. */
async function session(email: string, password: string): Promise<{ cookie: string; made: boolean }> {
  const cookie = await signIn(email, password)
  if (cookie !== '') return { cookie, made: false }
  await forgetMail(email)
  const signedUp = await auth('sign-up/email', {
    email,
    password,
    name: 'Test account',
    callbackURL: '/servers',
    agreement: { terms: TERMS_VERSION },
  })
  if (signedUp.ok) {
    await fetch(await mailedLink(email), { redirect: 'manual' })
    return { cookie: await signIn(email, password), made: true }
  }
  // It exists with a password this machine no longer has: the reset link a person would follow.
  await auth('request-password-reset', { email, redirectTo: '/reset-password' })
  const link = await mailedLink(email, /reset-password/)
  const landed = await fetch(link, { redirect: 'manual' })
  const token = new URL(landed.headers.get('location') ?? '', WEB).searchParams.get('token')
  if (token === null) throw new Error(`the reset link for ${email} gave no token`)
  const reset = await auth('reset-password', { newPassword: password, token })
  if (!reset.ok) throw new Error(`resetting ${email} answered ${reset.status}: ${await reset.text()}`)
  return { cookie: await signIn(email, password), made: false }
}

/** Confirms the account's email, through the link a person would be sent, if it isn't yet. */
async function confirm(email: string, cookie: string): Promise<void> {
  const current = (await (await fetch(`${WEB}/api/auth/get-session`, { headers: { cookie } })).json()) as {
    user?: { emailVerified?: boolean }
  }
  if (current.user?.emailVerified) return
  await forgetMail(email)
  await auth('send-verification-email', { email, callbackURL: '/servers' }, cookie)
  await fetch(await mailedLink(email), { redirect: 'manual' })
}

/**
 * Puts the account on `plan` through Upgrade or Manage billing: their link, and the local page's
 * one button. Polar's own pages are a person's to go through, so with LOCAL_BILLING=polar it says so.
 */
async function putOn(plan: string, api: ReturnType<typeof apiAs>): Promise<string | null> {
  const current = (await api('account.me', {}, 'GET')).standing.plan as string
  if (current === plan) return null
  const { url } = (
    plan === 'free'
      ? await api('billing.portal')
      : await api('billing.checkout', { plan, consent: { terms: TERMS_VERSION, startNow: true } })
  ) as { url: string }
  const link = new URL(url)
  if (!link.pathname.startsWith('/api/billing/local/'))
    return `LOCAL_BILLING=polar: ${plan === 'free' ? 'cancel' : 'buy'} ${title(plan)} through Polar's pages yourself`
  const pressed = await fetch(new URL(link.pathname, WEB), {
    method: 'POST',
    body: new URLSearchParams({ ticket: link.searchParams.get('ticket') ?? '' }),
    redirect: 'manual',
  })
  if (pressed.status !== 303) throw new Error(`the local checkout answered ${pressed.status}`)
  return null
}

say(`Test accounts on ${WEB}, one per plan:`)
let failed = false
for (const plan of PLAN_KEYS) {
  const email = `${plan}@blockly.localhost`
  const password = saved[email] ?? `dev-${randomUUID()}`
  try {
    const { cookie, made } = await session(email, password)
    if (cookie === '') throw new Error('signing in set no session')
    saved[email] = password
    await confirm(email, cookie)
    const api = apiAs(() => cookie)
    const note = await putOn(plan, api)
    const now = (await api('account.me', {}, 'GET')).standing.plan as string
    say(`  ${email.padEnd(28)} ${title(now).padEnd(6)} ${made ? 'made' : 'reset'}${note ? ` — ${note}` : ''}`)
    if (now !== plan && note === null) throw new Error(`is on ${now}, not ${plan}`)
  } catch (error) {
    failed = true
    say(`  ${email.padEnd(28)} FAILED — ${(error as Error).message}`)
  }
}

mkdirSync('local/dev', { recursive: true })
writeFileSync(SAVED, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
say(`Passwords: ${SAVED}`)
if (failed) {
  say('Is `bun run dev` running, with its containers up?')
  process.exit(1)
}
