// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading what a pack's own files parse to (JSON, TOML, properties), whose shape nothing promises:
 * a value of the wrong kind reads as absent, never as an error. Not for what Blockly writes itself,
 * which its own types describe.
 */

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Text, or a number written where text was meant. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

export const isString = (value: string | undefined): value is string => value !== undefined

/** A release id, or null for anything that isn't one. */
export function releaseId(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return /^\d+\.\d+(\.\d+)?$/.test(trimmed) ? trimmed : null
}
