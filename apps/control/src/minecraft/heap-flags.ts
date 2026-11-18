// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a server's Java holds its memory: the image's variables for the heap and the garbage
 * collector, and the C library's.
 *
 * The heap grows as the game needs it and gives back what it no longer does. The image's
 * `USE_AIKAR_FLAGS` would set the same collector tuning, but with `-XX:+AlwaysPreTouch` and with
 * `-Xms` equal to `-Xmx` (its `MEMORY`), which together make the whole heap resident from the
 * first second and keep it so: a vanilla 3 GB server held about 2.3 GiB in every state, awake,
 * idle or frozen, for a live heap under 300 MiB, since G1 never shrinks below `-Xms`. So the
 * tuning is written here without those two, and:
 *
 * - `-Xms` is small (`INIT_MEMORY`) and `-Xmx` is the server's heap (`MAX_MEMORY`);
 * - `MinHeapFreeRatio=10` and `MaxHeapFreeRatio=30` let G1 keep at most 30% of the heap free
 *   after a collection, where its default of 70% kept nearly three times the live heap;
 * - compact object headers (JEP 519, a product flag from Java 25) take about 6% off the live
 *   heap; older Java refuses the flag, so it is set only from 25;
 * - `MALLOC_ARENA_MAX=2` keeps glibc from giving each thread an arena of its own, up to eight per
 *   CPU the host has. The Alpine image runs musl, where the variable means nothing, so it is set
 *   only on the others.
 *
 * No periodic collection: an empty server pauses its ticks and allocates nothing, and a
 * collection on a timer would mark the heap for nothing and, after a sleep, pull it back in.
 *
 * Not for how big the heap is (`heapMb` in `runtime-spec.ts`).
 */

/** The heap a server starts with. It grows to `-Xmx` as the game asks. */
const INITIAL_HEAP_MB = 256

/** From this heap on, Aikar's tuning takes a larger young generation and larger regions. */
const LARGE_HEAP_MB = 12 * 1024

/** The first Java whose compact object headers are a product flag. */
const COMPACT_HEADERS_JAVA = 25

/**
 * Aikar's G1 tuning as the pinned image writes it (`start-finalExec`, release 2026.9.1), without
 * `AlwaysPreTouch` and without the two system properties that only name the flags.
 */
function aikarG1(heapMb: number): string[] {
  const large = heapMb >= LARGE_HEAP_MB
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
  ]
}

/** The image's variables for a server's memory: its heap, its collector and its C library. */
export function heapEnv(heapMb: number, java: number, glibc: boolean): Record<string, string> {
  const flags = [
    ...aikarG1(heapMb),
    '-XX:MinHeapFreeRatio=10',
    '-XX:MaxHeapFreeRatio=30',
    ...(java >= COMPACT_HEADERS_JAVA ? ['-XX:+UseCompactObjectHeaders'] : []),
  ]
  return {
    INIT_MEMORY: `${Math.min(INITIAL_HEAP_MB, heapMb)}M`,
    MAX_MEMORY: `${heapMb}M`,
    JVM_XX_OPTS: flags.join(' '),
    ...(glibc ? { MALLOC_ARENA_MAX: '2' } : {}),
  }
}
