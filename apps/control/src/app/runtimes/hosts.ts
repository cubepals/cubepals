// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hosts servers booted on, by their provider's own names, and the CPU read on each
 * (`runtime_hosts`): what a boot that read its host adds to. A provider's hosts differ, a server
 * stays on the one its storage was made on, and the provider says which host that is before any
 * compute runs there; so what earlier boots read of a host is what is known of it then, and a
 * runtime that provisions may ask whether a host is known to be slow (`ProgressSink.slowHost`).
 * Reading a host is the runtime's (`MinecraftRuntime.hostCpu`), and a boot's own record of it
 * `host-cpu.ts`'s.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import type { HostCpu } from '../ports/runtime.ts'

const hosts = schema.runtimeHosts
type Host = NonNullable<HostCpu['host']>

/**
 * One more reading of a host: its clock as last read, and as the least and the most ever read
 * there, with when and how many. A reading that names no host, or no clock, teaches nothing and
 * is not kept.
 */
export async function hostSeen(q: Queryable, provider: string, cpu: HostCpu, at = new Date()): Promise<void> {
  if (cpu.host === null || cpu.mhz === null) return
  await q
    .insert(hosts)
    .values({
      provider,
      region: cpu.host.region,
      host: cpu.host.id,
      model: cpu.model,
      mhz: cpu.mhz,
      mhzMin: cpu.mhz,
      mhzMax: cpu.mhz,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .onConflictDoUpdate({
      target: [hosts.provider, hosts.region, hosts.host],
      set: {
        model: sql`coalesce(excluded.model, ${hosts.model})`,
        mhz: sql`excluded.mhz`,
        mhzMin: sql`least(${hosts.mhzMin}, excluded.mhz)`,
        mhzMax: sql`greatest(${hosts.mhzMax}, excluded.mhz)`,
        readings: sql`${hosts.readings} + 1`,
        lastSeenAt: sql`greatest(${hosts.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
}

/**
 * Whether a host is known to be slow: every clock read on it is under `floorMhz`. A host never
 * read is not known. Nor is one whose readings fall on both sides of the floor: a name that reads
 * both slow and fast doesn't stand for one kind of host, so what was read there says nothing of
 * what the next server would get, and a host not known is treated as any new one is. Known fast
 * and not known are the same answer here, since only a slow host is acted on.
 */
export async function knownSlow(
  q: Queryable,
  provider: string,
  host: Host,
  floorMhz: number,
): Promise<boolean> {
  const [row] = await q
    .select({ most: hosts.mhzMax })
    .from(hosts)
    .where(and(eq(hosts.provider, provider), eq(hosts.region, host.region), eq(hosts.host, host.id)))
  return row !== undefined && row.most < floorMhz
}
