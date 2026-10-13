// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * PostHog in the browser, cookieless: nothing is stored on the device (no cookie, no local or
 * session storage), so no consent banner is asked for. It counts pages,
 * web vitals and uncaught errors, each marked with the environment that built the page. It never
 * names anyone: no identify, no email, no address, no clicks or text read off the page, and no
 * recordings, which PostHog doesn't make without storage. With no token it does nothing at all.
 *
 * Pages name their own steps through `capture`, each area's events listed in one typed module
 * beside it (the create page's `servers/new/steps.ts`, for one). Their properties are codes,
 * counts and yes or no: never text someone typed, and never anything that names them.
 *
 * Not for anything about an account: control sends those, by the account's id.
 */
import posthog from 'posthog-js'
import { useEffect } from 'react'

const TOKEN = process.env.NEXT_PUBLIC_POSTHOG_TOKEN ?? ''
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com'

/** `production`, `staging` or `development`, from the deployment that built this (next.config.ts). */
export const ENVIRONMENT = process.env.BLOCKLY_ENVIRONMENT ?? 'development'
/** The build: its commit, short, or `dev`. Attached to feedback and errors. */
export const APP_VERSION = process.env.BLOCKLY_VERSION ?? 'dev'

/** Whether this build sends anything to PostHog; the feedback item shows only when it does. */
export const insightOn = TOKEN !== ''

let started = false

/** Starts PostHog once, as the page loads. Renders nothing. */
export function Insight() {
  useEffect(() => {
    start()
  }, [])
  return null
}

/**
 * Starts PostHog where it sends anything and hasn't started yet; whether it is running. A page's
 * own effects run before the root layout's, so the first step a page names may start it too.
 */
function start(): boolean {
  if (!insightOn || typeof window === 'undefined') return false
  if (started) return true
  started = true
  posthog.init(TOKEN, {
    api_host: HOST,
    cookieless_mode: 'always',
    persistence: 'memory',
    person_profiles: 'never',
    ip: false,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    capture_exceptions: true,
    capture_performance: { web_vitals: true, network_timing: false },
    // Nothing read off the page: no clicks, dead clicks or heatmaps, whatever the project turns on.
    autocapture: false,
    capture_dead_clicks: false,
    enable_heatmaps: false,
    disable_session_recording: true,
    disable_surveys: true,
    // Registered as the client loads, so every event carries them, autocaptured ones included.
    loaded: (ph) => ph.register({ environment: ENVIRONMENT, app_version: APP_VERSION }),
    // And held to it on the way out: no event leaves without its environment, or with an address.
    before_send: stamped,
  })
  return true
}

/** Page addresses an event carries; their query can hold an email or a token, so it never leaves. */
const ADDRESSES = ['$current_url', '$referrer', '$initial_referrer', '$prev_pageview_url'] as const

/** An address without its query or fragment; anything that isn't a string is left as it is. */
function bare(address: unknown): unknown {
  return typeof address === 'string' ? address.replace(/[?#].*$/, '') : address
}

/**
 * An event on its way out: marked with this build's environment, with no IP address, and with page
 * addresses cut to their path (sign-up's `/check-email?email=...` among them). Campaign tags are
 * read from the query before this, so they still arrive as their own properties.
 */
export function stamped<T extends { properties: Record<string, unknown> }>(event: T | null): T | null {
  if (event === null) return null
  const { $ip: _address, ...properties } = event.properties
  for (const key of ADDRESSES) if (key in properties) properties[key] = bare(properties[key])
  return { ...event, properties: { ...properties, environment: ENVIRONMENT } }
}

/** What an error boundary caught, sent with where it was caught; nothing when PostHog is off. */
export function reportError(error: unknown, boundary: string): void {
  if (!insightOn || !started) return
  posthog.captureException(error, { boundary, environment: ENVIRONMENT, app_version: APP_VERSION })
}

/** What a page's step carries: codes, counts and yes or no. */
export type Said = Record<string, string | number | boolean>

/**
 * A step a page names, as `event` with `properties`. `leaving`: the page is going away, so it is
 * sent at once by `sendBeacon`, which the browser finishes after the page has gone, rather than
 * waiting in posthog-js's batch. Nothing when PostHog is off.
 */
export function capture(event: string, properties: Said, leaving = false): void {
  if (!start()) return
  posthog.capture(event, properties, leaving ? { transport: 'sendBeacon', send_instantly: true } : undefined)
}

/**
 * A code as a step may carry it: lowercase letters, digits and underscores, else `other`. Some
 * codes come from an address anyone can type, so nothing else gets through.
 */
export function asCode(value: string | null | undefined): string {
  const code = value?.toLowerCase() ?? ''
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'other'
}
