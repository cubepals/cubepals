// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DigitalOcean's CPU-Optimized droplet as a catalog entry, one VM per Minecraft server.
 * It has no shared constants; every field is written out in the entry.
 * Other providers live in their own files beside this one.
 */
import { CHECKED, type Offering } from './offering.ts'

export const DIGITALOCEAN_VMS: readonly Offering[] = [
  {
    id: 'do-c-2',
    provider: 'DigitalOcean',
    product: 'CPU-Optimized Regular (dedicated vCPU)',
    sku: 'c-2',
    modelClass: 'A',
    regions: 'NYC1/2/3, SFO3, TOR1, LON1, AMS3, FRA1, BLR1, SGP1, SYD1',
    regionGroup: 'EU+US',
    currency: 'USD',
    monthlyPrice: 42,
    hourlyPrice: 0.0625,
    setupFee: 0,
    minTerm: 'none',
    billing: 'per second (60 s minimum), capped at 672 h a month',
    billedWhenOff: true,
    ramGb: 4,
    cores: null,
    threads: 2,
    dedicatedCpu: true,
    cpuModel: 'Intel "Ice Lake and older", base > 2.6 GHz',
    st: {
      passmark: 2078,
      index: 44,
      tag: '[Independent]',
      basis:
        'Xeon Platinum 8168 (PassMark 2,078) observed on DO dedicated lines until Jan 2024; current mix unknown',
    },
    localDiskGb: 25,
    disks: '25 GiB SSD',
    raid1: false,
    bandwidth: '4,000 GiB/month pooled per team; $0.01/GiB beyond',
    egressOveragePerTb: 10.24,
    ipv4Monthly: 0,
    storageWhileOffGbMonth: 0.06,
    ddos: 'free L3/L4; blackholes the IP when capacity is reached',
    gameAwareDdos: false,
    stock: 'standard DCs',
    inStock: true,
    checked: CHECKED,
    sourceNote: 'do-linode-upcloud-scaleway.md (DigitalOcean, SKU data)',
    source:
      'https://www.digitalocean.com/pricing/droplets ; https://docs.digitalocean.com/products/droplets/details/pricing/',
    notes:
      'Listed for completeness and flagged uncompetitive: $42 for 2 hyper-threads of an old Intel core, the same hourly price ' +
      "as Fly's 3 GB machine in fra. Powered-off droplets bill in full.",
  },
]
