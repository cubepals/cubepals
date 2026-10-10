// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of a catalog entry: the `Offering` type every provider file writes its entries in.
 * It also carries what entries are built with: the check date and the PassMark single-thread helper.
 * It holds no prices; those live in the provider files beside it, and `../catalog.ts` assembles them.
 */

export const CHECKED = '2026-10-01'

/** PassMark single-thread rating of the Ryzen 9 9950X, the index's 100 (cpu-performance.md §1). */
const ST_REFERENCE_PASSMARK = 4728

type ModelClass = 'A' | 'B' | 'C'
type Currency = 'USD' | 'EUR'
type RegionGroup = 'EU' | 'US' | 'EU+US'
/** cpu-performance.md's labels: measured by a third party, claimed by the provider, or inferred. */
type EvidenceTag = '[Independent]' | '[Provider claim]' | '[Inferred]'

export interface SingleThread {
  /** PassMark single-thread rating where the CPU is known exactly (cpu-performance.md, CPU data). */
  passmark: number | null
  /** Ryzen 9 9950X = 100. A range where a plan doesn't pin its CPU generation. */
  index: number | readonly [number, number] | null
  tag: EvidenceTag
  basis: string
}

/** A RAM upgrade a dedicated server can be ordered with, priced per month on top of the base. */
interface RamOption {
  ramGb: number
  extraMonthly: number
}

export interface Offering {
  id: string
  provider: string
  product: string
  sku: string
  modelClass: ModelClass
  regions: string
  regionGroup: RegionGroup
  currency: Currency
  /** List price for a whole month, in `currency`: always on, or the monthly cap. */
  monthlyPrice: number | null
  hourlyPrice: number | null
  /** Fly only: the rate live on Fly's pricing pages at check time (the scheduled Oct-1 rate is `hourlyPrice`). */
  hourlyPriceLive?: number
  setupFee: number | null
  minTerm: string
  billing: string
  billedWhenOff: boolean | null
  ramGb: number
  ramOptions?: readonly RamOption[]
  /** Physical cores; null for VMs, whose vCPUs are threads. */
  cores: number | null
  /** Performance cores of a hybrid Intel part: only these reach the single-thread index. */
  fastCores?: number
  /** Hardware threads, or vCPUs for VMs. */
  threads: number | null
  dedicatedCpu: boolean | null
  cpuModel: string
  st: SingleThread
  /** Local disk across all drives, GB; null when storage is billed separately. */
  localDiskGb: number | null
  disks: string
  /** Two identical drives sold as software RAID 1: usable space is half of `localDiskGb`. */
  raid1: boolean
  bandwidth: string
  /** Egress price beyond the allowance, per TB, in `currency`; 0 = unmetered or no fee. */
  egressOveragePerTb: number | null
  /** What one public IPv4 adds a month, in `currency`; 0 = one is included. */
  ipv4Monthly: number | null
  /** VM per server: what keeping the world costs while the VM is stopped or deleted, per GB-month. */
  storageWhileOffGbMonth?: number | null
  ddos: string
  gameAwareDdos: boolean | null
  stock: string
  inStock: boolean | null
  checked: string
  sourceNote: string
  source: string
  notes: string
}

/** A known CPU's single-thread index from its PassMark rating (cpu-performance.md, CPU data). */
export const passmark = (rating: number, basis: string): SingleThread => ({
  passmark: rating,
  index: Math.round((rating / ST_REFERENCE_PASSMARK) * 100),
  tag: '[Independent]',
  basis: `PassMark ST ${rating.toLocaleString('en-US')} ÷ 4,728; ${basis}`,
})
