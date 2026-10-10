// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Terraform side of `bun scripts/fleet.ts add` and `remove`: a Hetzner Cloud type's price from
 * the price catalog, the environment's fleet-nodes.auto.tfvars.json, and `terraform apply` for
 * one node (infra/terraform/modules/fleet-node). Talking to the control plane stays in fleet.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG, EUR_TO_USD, toUsd } from './economics/catalog.ts'

export const NODES_FILE = 'fleet-nodes.auto.tfvars.json'
/** Where Hetzner Cloud has servers; the stack maps each to its network zone. */
export const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin']
/** The host's name, which is also the Hetzner server's: a DNS label. */
export const NODE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export interface NodeEntry {
  location: string
  type: string
}

/**
 * A Hetzner Cloud type's monthly list price in whole US cents, from the catalog's entry whose sku
 * is the type, converted at the catalog's one exchange rate. Null for a type the catalog lacks.
 */
export function cloudPrice(type: string): { cents: number; said: string } | null {
  const found = CATALOG.find(
    (o) =>
      o.provider === 'Hetzner' && o.product.startsWith('Cloud') && o.sku.toLowerCase() === type.toLowerCase(),
  )
  if (found === undefined || found.monthlyPrice === null) return null
  const cents = Math.round(toUsd(found, found.monthlyPrice) * 100)
  const said =
    found.currency === 'EUR'
      ? `€${found.monthlyPrice} a month in scripts/economics/catalog, at €1 = $${EUR_TO_USD}`
      : `$${found.monthlyPrice} a month in scripts/economics/catalog`
  return { cents, said }
}

/** The types `cloudPrice` knows, for saying what to choose from. */
export const pricedTypes = () =>
  CATALOG.filter((o) => o.provider === 'Hetzner' && o.product.startsWith('Cloud')).map((o) =>
    o.sku.toLowerCase(),
  )

export const nodesFile = (dir: string) => join(dir, NODES_FILE)

export function readNodes(dir: string): Record<string, NodeEntry> {
  const parsed = JSON.parse(readFileSync(nodesFile(dir), 'utf8')) as {
    fleet_nodes?: Record<string, NodeEntry>
  }
  return parsed.fleet_nodes ?? {}
}

/** Writes the nodes sorted by name, so each change is one entry in a diff. */
export function writeNodes(dir: string, nodes: Record<string, NodeEntry>): void {
  const sorted = Object.fromEntries(Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(nodesFile(dir), `${JSON.stringify({ fleet_nodes: sorted }, null, 2)}\n`)
}

/** `<location>-<type>-<n>`, with the first n no entry has. */
export function nextName(nodes: Record<string, NodeEntry>, location: string, type: string): string {
  for (let n = 1; ; n++) {
    const name = `${location}-${type}-${n}`
    if (nodes[name] === undefined) return name
  }
}

/** The node's module in an environment (environments/<name>/main.tf → stack/main.tf). */
export const nodeTarget = (name: string) => `module.environment.module.fleet_node["${name}"]`

/**
 * `terraform apply` for one node, in the operator's terminal: terraform shows the plan and asks
 * before it spends anything, unless `yes`. A join line goes in through the environment only.
 */
export function applyNode(dir: string, name: string, options: { joinLine?: string; yes: boolean }): number {
  const args = ['terraform', `-chdir=${dir}`, 'apply', `-target=${nodeTarget(name)}`]
  if (options.yes) args.push('-auto-approve')
  const env = { ...process.env }
  // The environments read the Hetzner token as a variable (environments/<name>/main.tf).
  if (!env.TF_VAR_hcloud_token && env.HCLOUD_TOKEN) env.TF_VAR_hcloud_token = env.HCLOUD_TOKEN
  if (options.joinLine !== undefined)
    env.TF_VAR_fleet_join_lines = JSON.stringify({ [name]: options.joinLine })
  return Bun.spawnSync(args, { stdio: ['inherit', 'inherit', 'inherit'], env }).exitCode
}
