/**
 * Scaleway's Elastic Metal dedicated servers as catalog entries.
 * Other providers live in their own files beside this one.
 */
import { CHECKED, type Offering, passmark } from './offering.ts'

const SCALEWAY_EM = {
  provider: 'Scaleway',
  modelClass: 'C',
  regionGroup: 'EU',
  currency: 'EUR',
  setupFee: 0,
  minTerm: 'none (hourly) or monthly; no commitment fee SKU for the B*30E models',
  billing: 'hourly or monthly; hourly costs about twice the monthly price',
  billedWhenOff: true,
  dedicatedCpu: true,
  raid1: true,
  bandwidth: 'unlimited traffic; 3 Gbps public (max 10)',
  egressOveragePerTb: 0,
  // €0.005/h × 730 h; whether Elastic Metal includes one free IPv4 was not confirmed.
  ipv4Monthly: 3.65,
  ddos: 'not retrieved',
  gameAwareDdos: null,
  checked: CHECKED,
  sourceNote: 'do-linode-upcloud-scaleway.md (Scaleway, SKU data)',
  source:
    'https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products ; https://www.scaleway.com/en/pricing/elastic-metal/',
} as const

export const SCALEWAY_SERVERS: readonly Offering[] = [
  {
    ...SCALEWAY_EM,
    id: 'scaleway-em-b230e',
    product: 'Elastic Metal Beryllium (same hardware and price as Dedibox Pro-11-M-64G)',
    sku: 'EM-B230E-NVMe',
    regions: 'fr-par-1, fr-par-2, nl-ams-1, nl-ams-2 (128 GB variant fr-par only)',
    monthlyPrice: 119.99,
    hourlyPrice: 0.329,
    ramGb: 64,
    ramOptions: [{ ramGb: 128, extraMonthly: 30 }],
    cores: 8,
    threads: 16,
    cpuModel: 'AMD EPYC 4345P (Zen 5), 3.8 GHz base',
    st: passmark(4408, '52 samples'),
    localDiskGb: 2040,
    disks: '2× 1.02 TB NVMe',
    stock: 'listed in fr-par and nl-ams zones',
    inStock: true,
    notes:
      'The 128 GB variant is the separate SKU EM-B230E-NVMe-128G at €149.99 (fr-par only). IPv4 €0.005/h on the pricing page vs ' +
      '€0.004/h in the Instances FAQ.',
  },
  {
    ...SCALEWAY_EM,
    id: 'scaleway-em-b430e-128g',
    product: 'Elastic Metal Beryllium (same hardware and price as Dedibox Pro-11-XL-128G)',
    sku: 'EM-B430E-NVMe-128G',
    regions: 'fr-par-1, fr-par-2',
    monthlyPrice: 229.99,
    hourlyPrice: 0.63,
    ramGb: 128,
    cores: 16,
    threads: 32,
    cpuModel: 'AMD EPYC 4545P (Zen 5), 3.0 GHz base',
    st: passmark(4318, '75 samples'),
    localDiskGb: 7680,
    disks: '2× 3.84 TB NVMe',
    stock: 'listed in fr-par zones',
    inStock: true,
    notes: 'Largest local disk per euro in this catalog. EU (Paris) only.',
  },
]
