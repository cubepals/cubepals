// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every table Blockly keeps, as Drizzle defines them. The migrations are generated from these
 * (drizzle.config.ts reads this file), and `@blockly/db` hands them out as `schema`. Each part is
 * one concern's tables; this file only gathers them.
 *
 * Parts (`schema/`):
 * - `columns.ts`: the timestamp columns every table writes the same way.
 * - `auth.ts`: the accounts people sign in to, as Better Auth keeps them.
 * - `accounts.ts`: an account's standing and plan, admins, the platform's controls, spend and alerts.
 * - `servers.ts`: a Minecraft server, its revisions and worlds, its runtime, and its operations.
 * - `access.ts`: who may join a server and who runs it.
 * - `backups.ts`: a server's snapshots and archive copies, and the world downloads made of them.
 * - `artifacts.ts`: stored files, uploads in flight, uploaded mods and the packs read from them.
 * - `catalog.ts`: the mod catalogs' cache, the trust in them, and checked and curated packs.
 * - `listings.ts`: the public directory, its reports, and the stars and notes on public servers.
 * - `usage.ts`: when servers ran and who played on them.
 * - `players.ts`: one player's facts kept while their server sleeps, and what waits for them to join.
 * - `billing.ts`: subscriptions and the orders that charged them.
 * - `audit.ts`: the platform's audit log.
 * - `insight.ts`: funnel events kept once before they are sent, and good-moment questions.
 * - `placement.ts`: where servers run when a deployment has several runtimes.
 * - `realtime.ts`: the realtime endpoint's pinned certificate.
 * - `fleet.ts`: the fleet runtime's own state.
 */

export * from './schema/access.ts'
export * from './schema/accounts.ts'
export * from './schema/artifacts.ts'
export * from './schema/audit.ts'
export * from './schema/auth.ts'
export * from './schema/backups.ts'
export * from './schema/billing.ts'
export * from './schema/catalog.ts'
export * from './schema/fleet.ts'
export * from './schema/insight.ts'
export * from './schema/listings.ts'
export * from './schema/placement.ts'
export * from './schema/players.ts'
export * from './schema/realtime.ts'
export * from './schema/servers.ts'
export * from './schema/usage.ts'
