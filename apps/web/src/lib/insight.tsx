'use client'

/**
 * PostHog in the browser, cookieless: nothing is stored on the device (no cookie, no local or
 * session storage), so no consent banner is asked for. It counts pages,
 * web vitals and uncaught errors, each marked with the environment that built the page. It never
 * names anyone: no identify, no email, no address, no clicks or text read off the page, and no
 * recordings, which PostHog doesn't make without storage. With no token it does nothing at all.
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
    if (!insightOn || started) return
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
  }, [])
  return null
}

/** An event on its way out: marked with this build's environment, and with no address on it. */
export function stamped<T extends { properties: Record<string, unknown> }>(event: T | null): T | null {
  if (event === null) return null
  const { $ip: _address, ...properties } = event.properties
  return { ...event, properties: { ...properties, environment: ENVIRONMENT } }
}

/** What an error boundary caught, sent with where it was caught; nothing when PostHog is off. */
export function reportError(error: unknown, boundary: string): void {
  if (!insightOn || !started) return
  posthog.captureException(error, { boundary, environment: ENVIRONMENT, app_version: APP_VERSION })
}
