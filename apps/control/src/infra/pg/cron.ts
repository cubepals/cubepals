// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When each scheduled job runs, and how often that is in seconds. What each job does is
 * `app/scheduled-jobs.ts`'s; how a pass is claimed and run is `jobs.ts`'s.
 */
import { DAY_S, HOUR_S, MINUTE_S } from '@blockly/contracts/durations'
import type { ScheduledJob, WorkerHeartbeat } from '../../app/ports/jobs.ts'

export const CRON: Record<ScheduledJob | WorkerHeartbeat, string> = {
  // Does nothing: each pass says the worker is working its schedules (`/api/health`).
  'worker-heartbeat': '* * * * *',
  reconcile: '* * * * *',
  drift: '* * * * *',
  relocations: '* * * * *',
  'presence-sync': '* * * * *',
  'idle-check': '* * * * *',
  'session-check': '* * * * *',
  'disk-check': '*/10 * * * *',
  'purge-sweep': '*/10 * * * *',
  // A server made for a while goes within a few minutes of its time, not on the hour.
  'expiry-sweep': '*/5 * * * *',
  // Worlds rest after days without play: once an hour finds them soon enough.
  'store-sweep': '47 * * * *',
  // Worlds kept a year after their last play: once a day, early, when the emails go.
  'retention-sweep': '13 6 * * *',
  orphans: '17 * * * *',
  'catalog-refresh': '41 * * * *',
  // The Via plugins Paper servers start with, pinned again per release: a new build reaches them
  // within a day, at their next start.
  'compat-pins': '23 4 * * *',
  // The lists of known malware, fetched again where they are published: a few times a day.
  'malware-lists': '7 */6 * * *',
  // The default modpack list's packs, checked before anybody picks one (§15.6).
  'pack-checks': '29 * * * *',
  // Reviewed releases of curated packs a deploy brought, queued to be checked.
  curation: '53 * * * *',
  'backup-schedule': '23 * * * *',
  'artifact-gc': '37 4 * * *',
  'standing-sweep': '* * * * *',
  // Extra play counted and sent to be billed (app/billing/extra-usage.ts).
  'extra-play-report': '* * * * *',
  'listing-eligibility-sweep': '51 3 * * *',
  'admin-alerts': '*/5 * * * *',
  // Free accounts their players show are one group's, linked before the next alert sweep reads them.
  'free-play-links': '*/5 * * * *',
  // Networks that no longer wake a server with a ping, forgotten: counted by the day, so hourly.
  'known-addresses': '31 * * * *',
  // A day's spend against its limit. At the most the platform runs at
  // once, ten minutes between passes is about 35 cents past the limit before it pauses.
  'spend-watchdog': '*/10 * * * *',
  // Creates closed for want of room open again within a minute of room freeing.
  'creates-room': '* * * * *',
  'usage-close': '*/10 * * * *',
  // Whose each server is and what it's called, at the provider: a rename shows there within minutes.
  'provider-tags': '*/10 * * * *',
  // What a runtime keeps tidy behind its port (the fleet's uploads, copies and health records).
  'runtime-upkeep': '* * * * *',
  // Funnel events kept as they happened, sent to PostHog within a minute.
  'insight-send': '* * * * *',
}

/**
 * How often a schedule runs, in seconds, for the forms `CRON` uses: every minute or every n, once
 * an hour or every n hours, once a day.
 */
export function everySecondsOf(cron: string): number {
  const [minute = '*', hour = '*'] = cron.split(' ')
  const every = (field: string) => (field === '*' ? 1 : Number(field.slice(2)))
  if (minute === '*' || minute.startsWith('*/')) return every(minute) * MINUTE_S
  if (hour === '*' || hour.startsWith('*/')) return every(hour) * HOUR_S
  return DAY_S
}
