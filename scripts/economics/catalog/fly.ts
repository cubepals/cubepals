// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fly Machines as catalog entries: one per size and region, priced per second while started.
 */
import { CHECKED, type Offering, type SingleThread } from './offering.ts'

const FLY_SOURCE = 'https://github.com/superfly/docs/pull/2507 ; https://docs.fly.io/about/pricing'
const FLY_ST: SingleThread = {
  passmark: null,
  index: 36,
  tag: '[Inferred]',
  basis:
    'one Geekbench 6 SC run of 1,213 on performance-2x (VPSBenchmarks, 2024) ÷ 9950X 3,410; Rome-class (cpu-performance.md §2, §6)',
}
const FLY_COMMON = {
  provider: 'Fly.io',
  modelClass: 'A',
  currency: 'USD',
  setupFee: 0,
  minTerm: 'none',
  billing: 'per second while started',
  billedWhenOff: true,
  cores: null,
  dedicatedCpu: true,
  cpuModel:
    'AMD EPYC (model not published); performance vCPU = 100% CFS quota, not documented as core-pinned',
  st: FLY_ST,
  localDiskGb: null,
  disks: 'world on a Fly Volume, $0.15/GB-month provisioned, billed while stopped',
  raid1: false,
  bandwidth: 'none included; $0.02/GB egress in North America and Europe',
  egressOveragePerTb: 20,
  ipv4Monthly: 0,
  ddos: 'no DDoS page; staff say Fly mitigates a whole /24 at a time',
  gameAwareDdos: false,
  inStock: true,
  checked: CHECKED,
  sourceNote: 'boat-fly-polar.md (Fly section, SKU data)',
  source: FLY_SOURCE,
} as const

export const FLY_MACHINES: readonly Offering[] = [
  {
    ...FLY_COMMON,
    id: 'fly-fra-3g',
    product: 'Fly Machine for Blockly 3 GB',
    sku: 'performance-1x + 1 GB',
    regions: 'fra (factor 1.153846154)',
    regionGroup: 'EU',
    monthlyPrice: 45.63,
    hourlyPrice: 0.06251,
    hourlyPriceLive: 0.0577,
    ramGb: 3,
    threads: 1,
    stock: 'available',
    notes:
      'Scheduled 1 Oct 2026 rate (superfly/docs PR #2507, unmerged at 18:12 UTC); the live page still showed $0.05770/h. ' +
      "Blockly's code prices it at $0.0593/h.",
  },
  {
    ...FLY_COMMON,
    id: 'fly-fra-4g',
    product: 'Fly Machine for Blockly 4 GB',
    sku: 'performance-2x',
    regions: 'fra (factor 1.153846154)',
    regionGroup: 'EU',
    monthlyPrice: 77.21,
    hourlyPrice: 0.10577,
    hourlyPriceLive: 0.09936,
    ramGb: 4,
    threads: 2,
    stock: 'available',
    notes: 'Scheduled Oct-1 rate; live page $0.09936/h. Code: $0.0993/h.',
  },
  {
    ...FLY_COMMON,
    id: 'fly-fra-8g',
    product: 'Fly Machine for Blockly 8 GB',
    sku: 'performance-4x',
    regions: 'fra (factor 1.153846154)',
    regionGroup: 'EU',
    monthlyPrice: 154.43,
    hourlyPrice: 0.21155,
    hourlyPriceLive: 0.19872,
    ramGb: 8,
    threads: 4,
    stock: 'available',
    notes: 'Scheduled Oct-1 rate; live page $0.19872/h. Code: $0.1986/h.',
  },
  {
    ...FLY_COMMON,
    id: 'fly-iad-3g',
    product: 'Fly Machine for Blockly 3 GB',
    sku: 'performance-1x + 1 GB',
    regions: 'iad (factor 1.0)',
    regionGroup: 'US',
    monthlyPrice: 39.55,
    hourlyPrice: 0.05417,
    hourlyPriceLive: 0.05,
    ramGb: 3,
    threads: 1,
    stock: 'available; iad volume hosts failed with "insufficient CPUs" in Jan–Mar 2026',
    notes: 'Scheduled Oct-1 rate; live page $0.05000/h.',
  },
  {
    ...FLY_COMMON,
    id: 'fly-iad-4g',
    product: 'Fly Machine for Blockly 4 GB',
    sku: 'performance-2x',
    regions: 'iad (factor 1.0)',
    regionGroup: 'US',
    monthlyPrice: 66.92,
    hourlyPrice: 0.09167,
    hourlyPriceLive: 0.08611,
    ramGb: 4,
    threads: 2,
    stock: 'available (see fly-iad-3g)',
    notes: 'Scheduled Oct-1 rate; live page $0.08611/h (matches fly.io/pricing $62.00 per 30 days).',
  },
  {
    ...FLY_COMMON,
    id: 'fly-iad-8g',
    product: 'Fly Machine for Blockly 8 GB',
    sku: 'performance-4x',
    regions: 'iad (factor 1.0)',
    regionGroup: 'US',
    monthlyPrice: 133.84,
    hourlyPrice: 0.18334,
    hourlyPriceLive: 0.17222,
    ramGb: 8,
    threads: 4,
    stock: 'available (see fly-iad-3g)',
    notes: 'Scheduled Oct-1 rate; live page $0.17222/h (matches fly.io/pricing $124.00 per 30 days).',
  },
]
