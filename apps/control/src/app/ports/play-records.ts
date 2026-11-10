// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** One A record the control plane keeps for a play name, as the zone holds it. */
export interface PlayRecord {
  readonly id: string
  /** The play name it answers for, `<slug>.<play domain>`. */
  readonly name: string
  readonly ipv4: string
}

/**
 * The A records the control plane keeps in the play domains' zone, and only those: each is marked
 * as this deployment's when it is written, and nothing unmarked (the wildcard, anything an operator
 * or Terraform made) is listed or touched. Each written is DNS-only, as the wildcard is.
 */
export interface PlayRecords {
  /** Every record this deployment keeps. */
  list(): Promise<PlayRecord[]>
  create(name: string, ipv4: string): Promise<void>
  /** The record `id` now answers `name` with `ipv4`. */
  update(record: PlayRecord): Promise<void>
  remove(id: string): Promise<void>
}
