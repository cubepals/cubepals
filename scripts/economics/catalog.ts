/**
 * A catalog of compute offerings and their list prices: per-second runtimes, a VM per server, and
 * machines that run many servers. `scripts/fleet-hetzner.ts` reads a fleet node's monthly price
 * from it, and `scripts/fleet.ts` shows that price when it adds a node.
 *
 * Every number was read from the provider's official pages or price API on 2026-10-01; each entry
 * names those URLs (`source`) and the research note that recorded it (`sourceNote`). `null` means
 * the source doesn't give the number; nothing is filled in from memory. Where sources disagree,
 * the entry's `notes` say so.
 *
 * Model classes: A = one VM (or per-second machine) per Minecraft server; B = one large VM running
 * many servers; C = a dedicated (bare-metal) server running many servers.
 *
 * Parts (`catalog/`):
 * - `offering.ts`: the shape every entry is written in, with the check date and the PassMark helper.
 * - `fly.ts`: Fly Machines, priced per second.
 * - `boat.ts`: Boat sandboxes, priced per second.
 * - `vultr.ts`: Vultr VMs for one server each, and Vultr bare metal.
 * - `hetzner.ts`: Hetzner cloud VMs, small and large, and Hetzner dedicated servers.
 * - `upcloud.ts`: UpCloud Cloud Native VMs.
 * - `linode.ts`: the Akamai (Linode) G8 Dedicated VM.
 * - `digitalocean.ts`: the DigitalOcean CPU-Optimized droplet.
 * - `ovh.ts`: OVHcloud dedicated servers, the EU company and OVHcloud US.
 * - `scaleway.ts`: Scaleway Elastic Metal servers.
 * - `specialists.ts`: single servers from bare-metal specialists.
 */

import { BOAT_SANDBOXES } from './catalog/boat.ts'
import { DIGITALOCEAN_VMS } from './catalog/digitalocean.ts'
import { FLY_MACHINES } from './catalog/fly.ts'
import { HETZNER_LARGE_VMS, HETZNER_SERVERS, HETZNER_VMS } from './catalog/hetzner.ts'
import { LINODE_VMS } from './catalog/linode.ts'
import type { Offering } from './catalog/offering.ts'
import { OVH_EU_SERVERS, OVH_US_SERVERS } from './catalog/ovh.ts'
import { SCALEWAY_SERVERS } from './catalog/scaleway.ts'
import { SPECIALIST_SERVERS } from './catalog/specialists.ts'
import { UPCLOUD_VMS } from './catalog/upcloud.ts'
import { VULTR_SERVERS, VULTR_VMS } from './catalog/vultr.ts'

export type { Offering } from './catalog/offering.ts'

/**
 * One euro in US dollars: a fixed rate, not a sourced one. Every EUR price is converted with this
 * one constant.
 */
export const EUR_TO_USD = 1.17

/** The candidate offerings: 46 entries, not every SKU the providers sell. */
export const CATALOG: readonly Offering[] = [
  // ─── Per-second runtimes (model A) ──────────────────────────────────────────────────────────
  ...FLY_MACHINES,
  ...BOAT_SANDBOXES,

  // ─── One VM per server (model A) ────────────────────────────────────────────────────────────
  ...VULTR_VMS,
  ...HETZNER_VMS,
  ...UPCLOUD_VMS,
  ...LINODE_VMS,
  ...DIGITALOCEAN_VMS,

  // ─── Large VMs running many servers (model B) ───────────────────────────────────────────────
  ...HETZNER_LARGE_VMS,

  // ─── Dedicated servers (model C): OVHcloud EU ───────────────────────────────────────────────
  ...OVH_EU_SERVERS,

  // ─── Dedicated servers (model C): OVHcloud US (separate company, USD) ───────────────────────
  ...OVH_US_SERVERS,

  // ─── Dedicated servers (model C): Hetzner ───────────────────────────────────────────────────
  ...HETZNER_SERVERS,

  // ─── Dedicated servers (model C): Vultr bare metal ──────────────────────────────────────────
  ...VULTR_SERVERS,

  // ─── Dedicated servers (model C): Scaleway ──────────────────────────────────────────────────
  ...SCALEWAY_SERVERS,

  // ─── Dedicated servers (model C): bare-metal specialists ────────────────────────────────────
  ...SPECIALIST_SERVERS,
]

/** A price in the offering's currency, in US dollars. */
export const toUsd = (o: Pick<Offering, 'currency'>, amount: number): number =>
  o.currency === 'EUR' ? amount * EUR_TO_USD : amount
