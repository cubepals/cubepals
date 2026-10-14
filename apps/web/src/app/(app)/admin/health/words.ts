// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the admin Health page words what the API reports: kinds of work, the steps an operation
 * went through, and how long things took. The API sends the domain's own words (`wake_from_rest`,
 * `loading_world`); what an admin reads is decided here.
 */

import { HOUR_S, MINUTE_S } from '@blockly/contracts/durations'

const KINDS: Record<string, string> = {
  create: 'Create',
  start: 'Start',
  wake: 'Wake',
  wake_from_rest: 'Wake from rest',
  rest: 'Rest',
  restart: 'Restart',
  apply: 'Apply a change',
  restore: 'Restore',
  stop: 'Stop',
  backup: 'Backup',
  archive: 'Archive',
  relocate: 'Move',
  access_sync: 'Access sync',
  prune_worlds: 'Prune worlds',
  decommission: 'Decommission',
  purge: 'Purge',
}

/** A kind of work: "Wake from rest". One the page doesn't know reads as the API sent it. */
export const kindLabel = (kind: string): string => KINDS[kind] ?? kind

const STEPS: Record<string, string> = {
  queued: 'Waiting in the queue',
  attempt: 'Began an attempt',
  allocating: 'Finding room',
  waiting_for_room: 'Waiting for a machine',
  storage: 'Disk',
  compute: 'Machine',
  booting: 'Booting',
  starting: 'Java starting',
  loading_world: 'Loading the world',
  verifying: 'Checking it answers',
  access: 'Access',
  saving: 'Saving',
  stopping: 'Stopping',
  rolling_back: 'Rolling back',
}

/** A step an operation reported: "Loading the world". */
export const stepLabel = (step: string): string => STEPS[step] ?? step

/** Seconds as an admin reads a wait, short enough for a column: "4.2s", "45s", "3m 10s", "1h 2m"; a dash for none. */
export function took(seconds: number | null): string {
  if (seconds === null) return '–'
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`
  if (seconds < MINUTE_S) return `${Math.round(seconds)}s`
  const whole = Math.round(seconds)
  if (whole < HOUR_S) return `${Math.floor(whole / MINUTE_S)}m ${String(whole % MINUTE_S).padStart(2, '0')}s`
  return `${Math.floor(whole / HOUR_S)}h ${String(Math.floor((whole % HOUR_S) / MINUTE_S)).padStart(2, '0')}m`
}

/** US cents as dollars: "$12.40". */
export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`
