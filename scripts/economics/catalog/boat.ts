/**
 * Boat sandboxes as catalog entries: one per size, priced per second while running.
 * Boat's plan tiers and the `xlarge` rate are not entries.
 */
import { CHECKED, type Offering } from './offering.ts'

const BOAT_COMMON = {
  provider: 'Boat (boat.dev, Dedale AI Corp.)',
  product: 'Sandbox VM',
  modelClass: 'A',
  regions: 'EU only: Germany, Finland, France (not selectable)',
  regionGroup: 'EU',
  currency: 'USD',
  setupFee: 0,
  minTerm: '$20/month account minimum, returned 1:1 as machine time',
  billing: 'per second while running; plan time first, then $20 packs at the same rates',
  billedWhenOff: false,
  cores: null,
  dedicatedCpu: false,
  cpuModel:
    'AMD Ryzen 9 9950X hosts (docs.boat.dev/machines); fallback: Hetzner cloud VM with an older AMD CPU, about 3× slower',
  st: {
    passmark: null,
    index: [33, 100],
    tag: '[Provider claim]',
    basis:
      '9950X hosts (100) per Boat; its own build benchmark puts the Hetzner fallback ~3× slower; vCPUs shared per the FAQ',
  },
  raid1: false,
  bandwidth: '2 TB egress per sandbox per month included; overage unpublished',
  egressOveragePerTb: null,
  ipv4Monthly: 0,
  storageWhileOffGbMonth: 0,
  ddos: 'not documented',
  gameAwareDdos: false,
  stock: 'on demand; fallback hosts when the standard machines are full',
  inStock: true,
  checked: CHECKED,
  sourceNote: 'boat-fly-polar.md (Boat section, SKU data)',
  source: 'https://docs.boat.dev/pricing ; https://docs.boat.dev/machines ; https://docs.boat.dev/faq',
} as const

const BOAT_NOTES =
  'A stopped sandbox costs $0 and keeps its disk; the IP (IPv6 or IPv4) changes on every resume; every create, fork or ' +
  'resume is a start against the plan quota. Contradictions: vCPUs "shared" (FAQ) vs "dedicated" (marketing) vs ' +
  '"guaranteed" (API); snapshots kept "for the life of the sandbox" (docs) vs "up to approximately 30 days" (Terms §8). ' +
  'Terms §2/§6 need Boat\'s written approval to give third parties access to compute and forbid "parking idle compute". No SLA.'

export const BOAT_SANDBOXES: readonly Offering[] = [
  {
    ...BOAT_COMMON,
    id: 'boat-small',
    sku: 'small',
    monthlyPrice: 13.14,
    hourlyPrice: 0.018,
    ramGb: 4,
    threads: 2,
    localDiskGb: 12,
    disks: '12 GB user disk; incremental snapshots every minute and on stop, free',
    notes: `Blockly maps servers up to 3 GB here (docs/boat-runtime-plan.md §7). ${BOAT_NOTES}`,
  },
  {
    ...BOAT_COMMON,
    id: 'boat-default',
    sku: 'default',
    monthlyPrice: 26.28,
    hourlyPrice: 0.036,
    ramGb: 8,
    threads: 4,
    localDiskGb: 50,
    disks: '50 GB user disk; snapshots free',
    notes: `Blockly maps servers up to 6 GB here, so its 4 GB size. ${BOAT_NOTES}`,
  },
  {
    ...BOAT_COMMON,
    id: 'boat-large',
    sku: 'large',
    monthlyPrice: 52.56,
    hourlyPrice: 0.072,
    ramGb: 16,
    threads: 8,
    localDiskGb: 125,
    disks: '125 GB user disk; snapshots free',
    notes: `Blockly maps 8 GB servers here. Not on the trial. ${BOAT_NOTES}`,
  },
]
