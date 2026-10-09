/**
 * Akamai (Linode)'s G8 Dedicated VM as a catalog entry, one VM per Minecraft server.
 * It has no shared constants; every field is written out in the entry.
 * Other providers live in their own files beside this one.
 */
import { CHECKED, type Offering } from './offering.ts'

export const LINODE_VMS: readonly Offering[] = [
  {
    id: 'linode-g8-4x2',
    provider: 'Akamai (Linode)',
    product: 'G8 Dedicated 4x2 (Zen 5)',
    sku: 'g8-dedicated-4-2',
    modelClass: 'A',
    regions: '33 core regions (Jakarta, São Paulo priced higher)',
    regionGroup: 'EU+US',
    currency: 'USD',
    monthlyPrice: null,
    hourlyPrice: 0.07,
    setupFee: 0,
    minTerm: 'none',
    billing: 'hourly, rounded up, NO monthly cap since 2026-07-01',
    billedWhenOff: true,
    ramGb: 4,
    cores: null,
    threads: 2,
    dedicatedCpu: true,
    cpuModel: 'AMD Zen 5 (exact SKU unpublished)',
    st: {
      passmark: null,
      index: null,
      tag: '[Inferred]',
      basis:
        'Akamai says Zen 5; Kechagias 2026 found Akamai Turin single-thread "very low" vs other Turin (no number)',
    },
    localDiskGb: 41,
    disks: '41 GB local SSD',
    raid1: false,
    bandwidth: 'no transfer included; all egress billed',
    egressOveragePerTb: 5,
    ipv4Monthly: null,
    storageWhileOffGbMonth: 0.1,
    ddos: 'not confirmed (official pages unreadable); staff said null-routing in 2012',
    gameAwareDdos: false,
    stock: 'not stated per region',
    inStock: null,
    checked: CHECKED,
    sourceNote: 'do-linode-upcloud-scaleway.md (Linode, SKU data)',
    source:
      'https://api.linode.com/v4/linode/types ; https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works',
    notes: 'About $51.10 at 730 h. Akamai names Minecraft for G8. Billed in full while the Linode exists.',
  },
]
