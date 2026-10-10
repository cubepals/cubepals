// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UpCloud's Cloud Native VMs as catalog entries, one VM per Minecraft server.
 * Other providers live in their own files beside this one.
 */
import { CHECKED, type Offering } from './offering.ts'

const UPCLOUD_CN = {
  provider: 'UpCloud',
  modelClass: 'A',
  regions: '15 zones incl. de-fra1, us-nyc1, us-chi1 (same price)',
  regionGroup: 'EU+US',
  currency: 'EUR',
  setupFee: 0,
  minTerm: 'none',
  billing: 'hourly, capped at 672 h a month; the plan is not billed while powered off',
  billedWhenOff: false,
  cores: null,
  dedicatedCpu: null,
  cpuModel: 'AMD EPYC 7542/7543/9354, or EPYC 9575F (Zen 5) on newer hosts; not pinned per plan',
  st: {
    passmark: null,
    index: [41, 88],
    tag: '[Independent]',
    basis:
      'EPYC 7542 hosts (41) seen through Aug 2026, 9575F hosts (88) since 2025 (VPSBenchmarks; cpu-performance.md §6)',
  },
  localDiskGb: null,
  disks: 'none: storage billed separately (MaxIOPS €0.00031/GB-h)',
  raid1: false,
  bandwidth: 'no egress fees; fair-transfer limit, then possible throttling to 100 Mbit/s',
  egressOveragePerTb: 0,
  ipv4Monthly: 3.23,
  // MaxIOPS €0.00031/GB-h × 730 h; whether storage is capped at 672 h is not stated.
  storageWhileOffGbMonth: 0.2263,
  ddos: 'no DDoS statement found',
  gameAwareDdos: null,
  stock: 'all three plan families in every zone',
  inStock: true,
  checked: CHECKED,
  sourceNote: 'do-linode-upcloud-scaleway.md (UpCloud, SKU data)',
  source:
    'https://calc.upcloud.com/cloud-servers?currency=EUR ; https://upcloud.com/docs/products/cloud-servers/configurations/',
  notes:
    'Cheapest VM per GB here, and stopping the server stops the plan charge; UpCloud does not say its public-cloud ' +
    'vCPUs are dedicated (only Private Cloud is marketed as free of noisy neighbours). IPv6 is free.',
} as const

export const UPCLOUD_VMS: readonly Offering[] = [
  {
    ...UPCLOUD_CN,
    id: 'upcloud-cn-1x4',
    product: 'Cloud Native',
    sku: 'CLOUDNATIVE-1xCPU-4GB',
    monthlyPrice: 12,
    hourlyPrice: 0.017857,
    ramGb: 4,
    threads: 1,
  },
  {
    ...UPCLOUD_CN,
    id: 'upcloud-cn-2x4',
    product: 'Cloud Native',
    sku: 'CLOUDNATIVE-2xCPU-4GB',
    monthlyPrice: 15,
    hourlyPrice: 0.022321,
    ramGb: 4,
    threads: 2,
  },
  {
    ...UPCLOUD_CN,
    id: 'upcloud-cn-4x8',
    product: 'Cloud Native',
    sku: 'CLOUDNATIVE-4xCPU-8GB',
    monthlyPrice: 32,
    hourlyPrice: 0.047619,
    ramGb: 8,
    threads: 4,
  },
]
