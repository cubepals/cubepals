# Minecraft Capacity Research

Research date: 2026-09-19. Benchmarks: local Apple M4 (relative curves) and Fly Machines in `ams` (production calibration). Harness and scripts: [`docs/research/minecraft-capacity/harness`](research/minecraft-capacity/harness).

The smallest safe Blockly machine for 1–5 vanilla/Paper players on 26.3 is a Fly performance-1x with 3 GB of RAM and a 2 GB heap. Every shared-CPU Fly size failed in our tests. Evidence comes from sourced research, 46 local server runs on the pinned `itzg/minecraft-server:2026.9.1` image, and 10 Fly calibration machines.

- **CPU class matters more than core count.**
  - Fly shared vCPUs were throttled to 50–92% steal within minutes and every shared size crashed. That includes shared-cpu-4x at 6 GB.
  - Tick time is single-threaded. A second dedicated core gave 33.8 ms vs 31.4 ms with 5 spread players.
  - Blockly's `guestFor()` used shared CPUs and had to change. (Since done: it picks performance
    CPUs only.)
- **Memory follows loaded chunks, not players.**
  - Live heap is about 150 MB plus about 0.1 MB per loaded chunk. Each isolated player loads (2·vd+7)² chunks: 729 at vd 10.
  - 10 grouped players used about the same memory as 1. 10 spread players used 3.4×.
  - “base + players × X” is misleading.
- **The JVM needs about 650 MB outside `-Xmx`.** Blockly's 75% heap rule was OOM-killed on a Fly 2 GB machine. Heap should be at least 1.6× the live set; 512 MB crashed with `OutOfMemoryError` under a 5-player load.
- **Spread and exploration drive cost.**
  - 10 spread players cost 4× the tick time of 10 together.
  - 5 players exploring apart grew the world 2.5 GB/h vs 0.69 GB/h together, and outran worldgen on 2 cores.
- **Disk is about 10.4 KB per overworld chunk**, linear up to 66k chunks. Backups compress to about 0.66×.
- **Bandwidth is negligible cost:** about 0.5 MB/min per idle player, about 10 MB/min exploring.
- **Mod count predicts nothing.**
  - A 13-mod pack (Pixelmon) out-cost a 115-mod pack.
  - 2 of 5 Modrinth packs could not boot as dedicated servers.
  - Modded servers need a measured first boot.

The final table is under Representative profiles at the end. The sizing function is under Proposed sizing model. Topic sections come first (versions, memory, CPU, players, distance, disk, mods, network), then methodology and raw data.

## Versions, Java and server implementations

The Java requirement changes by version and is well documented. What those versions cost to run is not: no source measures memory or generation cost across versions, so that comparison comes from our benchmarks. All sources accessed 2026-09-19.

| Minecraft | Required Java | Changes that matter for cost | itzg tag |
| --- | --- | --- | --- |
| 1.16.x | 8+ | Worldgen pool capped at 7 threads; world height 0–255 | java8 / java17 |
| 1.18.x | 17+ ([1.18](https://minecraft.wiki/w/Java_Edition_1.18)) | Height -64..319 (24 sections vs 16); noise terrain and 3D caves; pool = threads − 1, cap 255 ([21w38a](https://www.minecraft.net/en-us/article/minecraft-snapshot-21w38a)); simulation-distance added | java17 |
| 1.20.x | 17+, then 21+ from 1.20.5 ([1.20.5](https://minecraft.wiki/w/Java_Edition_1.20.5)) | 1.20.2 client-paced chunk sending; 1.20.5 spawn chunks 19×19 → 3×3 and `region-file-compression` | java17 / java21 |
| 1.21.x | 21+ | 1.21.2: “improved server performance when render distance is high” (no numbers); 1.21.9 removed spawn chunks | java21 |
| 26.1–26.3 (Blockly default 26.3) | 25+ ([26.1 changelog](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1)) | New save layout `dimensions/minecraft/*`, no downgrade; no stated server perf changes in 26.2/26.3 | java25 |

- **26.1's ZGC and 4 GB defaults are client-launcher defaults.** Mojang's note ties them to “a more stable framerate”. Nothing says the dedicated server changed GC. The itzg image still gets G1, plus Aikar's flags when Blockly asks for them.
- **Blockly's `javaFor()` in `minecraft/versions.ts` matches the sources.** 1.17 needs Java 16 and is mapped to 17, which is fine because Java 17 runs it.

**Implementations**

| Loader | Tick model | Chunk gen/load threads | Notes |
| --- | --- | --- | --- |
| Vanilla | One main tick thread | Worker pool = logical CPUs − 1 | No per-player gen limit |
| Paper | One main tick thread ([Folia README](https://github.com/PaperMC/Folia) contrasts this) | Moonrise chunk system; auto workers ≈ cores/2, halved again above 8 cores ([MoonriseCommon.java](https://github.com/PaperMC/Paper/blob/main/paper-server/src/main/java/ca/spottedleaf/moonrise/common/util/MoonriseCommon.java)); docs say “half of physical cores” | Per-player send/load/generate rate limits; many entity/hopper knobs |
| Fabric | Vanilla | Vanilla, or parallel with C2ME | Lithium (tick), FerriteCore (memory), ScalableLux (light), C2ME (gen) all ship for 26.3 |
| Forge / NeoForge | Vanilla | Vanilla | Cost dominated by the modpack; NeoForge 26.3 builds are beta (26.3.0.x-beta) |

**Chunk generation scaling** ([C2ME's own benchmark](https://modrinth.com/mod/c2me-fabric), 26.2 with terrain mods, Xeon at 3.2 GHz)

- Vanilla barely scales: about 13 chunks/s on 1 thread, 41–42 by 16 threads.
- Paper is near-linear to about 7 threads and stops at about 20 (roughly 170 chunks/s).
- C2ME is linear to 16 threads.
- This covers generation only, not tick time.

Single-core speed dominates. [nemez's 2024 tests](https://nemez.net/posts/20240414-minecraft-cpu-performance-testing/page-8/) on Paper 1.20.4 ranged from 50 chunks/s on an FX-8350 to 183 on a 7900X3D.

## Memory

Memory follows loaded chunks, not player count. On 26.3, vanilla/Fabric live heap is about 150 MB plus about 80–120 KB per loaded chunk. The heap should be at least 1.6× that live set. The machine needs heap plus about 400 MB of JVM native memory plus OS headroom.

Blockly's current rule, heap = 75% of machine RAM with Aikar's `AlwaysPreTouch`, was OOM-killed on a Fly 2 GB machine and left only 90–230 MB free on 4 GB machines.

**Heap live set** (after a forced full GC; runs `dist-*`, `players*`, `ver-*`, `base-*`)

| Workload (26.3, vd 10) | Loaded full chunks | Live heap |
| --- | --- | --- |
| Empty vanilla server | 0 | 132 MB |
| Empty Fabric (fabric-api, carpet, chunky) | 0 | 145–155 MB |
| Empty Paper | 0 | 240 MB |
| 1 player | 729 | 214 MB |
| 5 or 10 together | 756–783 | 222–226 MB |
| 5 spread | 3,645 | 497 MB |
| 10 spread | 7,293 | 758 MB |
| 5 exploring apart | 2,276 + 5,449 in-progress | 548 MB |
| COBBLEVERSE modpack, empty (Fly) | 0 | 987 MB |

Older versions, empty server: 1.16.5 at 249 MB and 1.18.2 at 352 MB. Both have 19×19 spawn chunks always loaded, which 26.x no longer has.

**Is `base + players × X` valid?** No. “Per player” cost ranged from about 1 MB (players grouped) to about 60 MB (spread at vd 10) to about 125 MB (spread at vd 16). What is linear is live heap against loaded chunks. Fitting all spread and distance runs gives about 150 MB + 80–120 KB × chunks.

- Loaded chunks = the union of (2·vd + 7)² squares per player: 361 at vd 6, 729 at vd 10, 1,521 at vd 16.
- Worst case, everyone spread out: 150 MB + players × (2·vd+7)² × 0.1 MB.
- At vd 10 that is about 220 MB for 1 player, 520 MB for 5 and 880 MB for 10.
- At vd 6 it is 330 MB for 5 and 510 MB for 10.

**Memory floor** (same workload each time: 3 bots spread and 2 exploring at vd 10, Fabric 26.3, 2 CPUs; runs `floor-*`)

| Heap | Container | Live set | GC | MSPT median / max | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1,024 MB | 2,048 MB | 642 MB | 1.3 pauses/s, 1.7% of time paused | 10.4 / 22 ms | Comfortable |
| 768 MB | 1,792 MB | 563 MB | 2.1 pauses/s; concurrent GC used 34 s of CPU | 9.8 / 14 ms | Degraded GC; ticks still OK on M4 |
| 512 MB | 1,536 MB | full | continuous | 27 / 94 ms, then 10.8 s behind | `OutOfMemoryError: Java heap space`, crash |
| 1,024 MB (10 spread) | 2,048 MB | 729 MB | 1.7 pauses/s | 19 / 53 ms | Usable, heap 71% full |

On a single Fly core, the same GC pressure competes with the tick thread. performance-1x with a 1 GB heap had 507 GC pauses (max 3.4 s) and 5-spread MSPT of 50 ms. With a 3 GB heap: 147 pauses and 31 ms. Heap headroom matters more on small CPUs.

**Native memory outside the heap** (NMT plus cgroup and RSS)

| Heap | Process RSS under load | RSS − heap | NMT non-heap (committed) |
| --- | --- | --- | --- |
| 512 MB | 853 MB | 341 MB | 233 MB |
| 768 MB | 1,114 MB | 346 MB | 281 MB |
| 1,024 MB | 1,387 MB | 363 MB | 299 MB |
| 3,072 MB | 3,450–3,580 MB | 380–510 MB | 300–440 MB (GC structures scale with heap) |

Container-limit floor with a 1 GB heap:

- 1,152 MB was OOM-killed during boot.
- 1,280 MB was OOM-killed at idle.
- 2,048 MB peaked at 1,556 MB, including page cache.
- On Fly, 2 GB with a 1.5 GB heap was OOM-killed by the kernel.

**The rule:**

```latex
\text{machine} \ge \text{heap} + 400\,\text{MB (JVM native)} + 250\,\text{MB (OS, itzg helpers, page cache)}
```

Heap should be at least 1.6× the expected live set, and at least 1 GB for vanilla. This lands close to the itzg docs' “+25%” at 2–4 GB. It is well above it at 1–2 GB and below Aikar's fixed 1–1.5 GB at large heaps.

**`AlwaysPreTouch` makes RSS equal to the heap from the first second** (3,372 MB RSS for a 132 MB live set). RSS-based autoscaling is therefore meaningless under Aikar's flags. Blockly must read JVM heap-after-GC instead.

## CPU

Blockly needs to think in CPU class first and core count second.

On Fly, shared vCPUs cannot run Minecraft at all. Every shared-CPU machine we tested was throttled to its 6.25%-per-vCPU baseline within minutes, and then MSPT exploded or the server crashed. A dedicated core, Fly `performance`, runs 1–5 grouped players comfortably. A second core does not lower tick time. It only helps exploration and GC, and only from 4 CPUs on, because vanilla sizes its worldgen pool as CPUs − 1.

**Measured on Fly (ams, AMD EPYC, 2026-09-19)**

Same script everywhere: Fabric 26.3 + Carpet bots, vd 10 / sd 10, Aikar flags.

| Machine | RAM / heap | Idle | 1 bot | 5 together | 5 spread | 5 exploring | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shared-cpu-1x | 2 GB / 1.5 GB | — | — | — | — | — | Boot took 634 s. After about 75 s of burst, steal was 92% and young GC pauses ran 5–31 s. Crashed. |
| shared-cpu-2x | 4 GB / 3 GB | 0.2 ms | 326 ms | — | — | — | Steal 76% during pregen at 2.7 chunks/s. Crashed with 1 bot. |
| shared-cpu-4x | 6 GB / 4.5 GB | 0.2 ms | 64 ms | 8.3 ms | 173 ms | 757 ms | Steal 50–75%. Crashed while exploring. |
| performance-1x | 2 GB / 1.5 GB | — | — | — | — | — | Kernel OOM kill while preparing the level (anon RSS 1.9 GB) |
| performance-1x | 2 GB / 1 GB | 0.2 ms | 9.2 ms | 9.7 ms | 50.2 ms | 15.2 ms, p99 5.8 s | Survives. 1 core pegged at 99% when spread or exploring. 507 GC pauses, max 3.4 s. |
| performance-1x | 4 GB / 3 GB | 0.2 ms | 6.7 ms | 6.8 ms | 31.4 ms | 6.7 ms, p99 3.0 s | Survives. 147 GC pauses, max 1.4 s. |
| performance-2x | 4 GB / 3 GB | 0.2 ms | 6.5 ms | 6.9 ms | 33.8 ms | 6.3 ms, p99 3.8 s | Survives. Same tick time as 1x. |

All values are median MSPT per phase.

**What the numbers show**

- **Shared CPUs fail regardless of core count.** [Fly's documentation](https://fly.io/docs/machines/cpu-performance/) gives each shared vCPU 5 ms per 80 ms period, with a 5 s initial burst balance and a 500 s cap.
  - A Minecraft server with one player needs about 0.2–0.4 of a dedicated core continuously (local and Fly measurements), which is 3–6× the shared baseline.
  - Our runs drained the burst balance during boot or pregen. After that, `/proc/stat` showed 50–92% steal.
  - Blockly's current `guestFor()` maps every tier to `cpu_kind: 'shared'`. **That has to change before launch.**
- **Tick time depends on single-core speed, not core count.**
  - Local, 10 spread bots: 46.8 / 38.0 / 36.2 ms at 1 / 2 / 4 CPUs.
  - Fly, 5 spread bots: 31.4 ms on 1 dedicated core vs 33.8 ms on 2.
  - The Server thread did about 75% of all CPU work in steady play.
- **Worldgen parallelism starts at 4 CPUs.**
  - Vanilla's worker pool is CPUs − 1 ([21w38a](https://www.minecraft.net/en-us/article/minecraft-snapshot-21w38a)), so performance-1x and -2x both got one worker. Pregen rates matched: about 28 chunks/s for 6,561 chunks in about 230 s on each.
  - Locally, Fabric Chunky throughput at 1/2/4/8 CPUs was 54 / 68 / 146 / 222 chunks/s.
  - Paper did not scale past about 1.4 cores. Moonrise gives few workers at small core counts (46 / 65 / 57 chunks/s at 1/2/4).
- **Heap size matters most on a single core.**
  - Going from a 1 GB to a 3 GB heap on performance-1x cut 5-spread MSPT from 50 to 31 ms and GC pauses from 507 to 147. G1 was competing with the tick thread for the only core.
- **M4 vs Fly EPYC.**
  - Grouped tick cost was similar: M4 at 2 CPU gave 9.2–10.3 ms, Fly gave 6.5–9.7 ms.
  - Spread was about 1.7–1.9× slower on Fly: 18.2 ms on M4 vs 31–34 ms.
  - Worldgen per worker was about 2–2.5× slower on Fly.
  - Use local numbers for curves and Fly numbers for constants.

**What is parallel** (per-thread CPU from `/proc/<pid>/task`)

- **Server thread (serial):** entity, block and chunk ticking, and mob spawning.
- **Worker-Main:** worldgen. It dominated during pregen and exploration, reaching 3:1 over the Server thread.
- **IO-Worker:** chunk reads and writes, 8–15% during generation.
- **C1/C2 compiler threads:** JIT warm-up, 10–15 s of CPU in the first minutes after boot.
- **G1 GC threads:** small, except when the heap is tight.
- **Network (Netty):** compression and I/O used 13.9 s of CPU across the 7-minute run with 5 real clients. That is about 0.03 cores, and about 3% of load while the clients explored.

## Players and behavior

Concurrent players is a weak sizing metric on its own. The cost is set by how many distinct chunks are loaded and ticked, and by how fast new chunks are generated.

We measured 10 players standing together at 9.6 ms/tick, about the same as 1 player. The same 10 players spread apart ran at 36–47 ms/tick, 4× the cost and near the 50 ms budget, and 3.4× the live heap. Neither extra cores nor a bigger heap helped the spread case.

**Measured: 10 Carpet bots, vd 10 / sd 10, Fabric 26.3, 3 GB heap, M4** (runs `players`, `players-1cpu`, `players-4cpu`)

| Scenario | Loaded full chunks | Live heap | MSPT median (1 / 2 / 4 CPU) | Cores used at 2 CPU | Main-thread share |
| --- | --- | --- | --- | --- | --- |
| Empty server | 0 | 149 MB | 0.3 / 0.7 / 0.6 | 0.06 | — |
| 10 together at spawn | 756 | 226 MB | 9.9 / 9.6 / 9.8 | 0.31 | \~75% |
| 10 spread 1,500 blocks apart | 7,293 | 758 MB | 46.8 / 38.0 / 36.2 | 1.2 | \~75% |
| 10 split across 3 dimensions | 4,242 | 544 MB | 27.8 / 23.9 / 35.6 | 0.7 | \~85% |
| 10 exploring apart at 10 blocks/s | 1,300–2,300 + 6,300–7,000 in-progress | 544–717 MB | 15.0 / 13.1 / 30.9 | 1.4 | worldgen dominates |

**Why they differ**

- **Chunk union.** A player keeps (2·vd+7)² full chunks loaded (729 at vd 10, measured exactly). Grouped players share one area: 10 together held 756 chunks. Spread players each hold their own, and 10 × 729 = 7,290 matches the measured 7,293.
- **Ticking is single-threaded.** The Server thread did about 75% of all CPU in the steady scenarios. Going from 1 to 4 CPUs changed spread MSPT only from 47 to 36 ms. The fixed cost is the main thread's per-tick work over loaded chunks: entities, block ticks, mob spawning.
- **Exploration shifts load to worldgen threads.** Worker-Main CPU exceeded the Server thread 3:1. MSPT looked fine at 1–2 CPUs only because generation fell behind: 6,300–7,000 chunks were still in-progress `ProtoChunk`s, so players see unloaded terrain rather than lag. Exploration needs more cores. Spread-out standing needs a faster single core.
- **Dimensions** act like spreading, with fewer chunks per player in the Nether and End.
- **Farms and entities** add main-thread work linearly. See the entity table in Raw benchmark results.

**Measured: 5 bots and view distance** (runs `dist-*`, 2 CPU)

| vd / sd | 1 bot | 5 together | 5 spread | Loaded chunks, 5 spread | Live heap, 5 spread |
| --- | --- | --- | --- | --- | --- |
| 6 / 4 | 6.0 ms | 6.0 ms | 13.3 ms | 1,805 | 361 MB |
| 8 / 6 | 7.7 ms | 8.1 ms | 16.5 ms | 2,647 | 438 MB |
| 10 / 10 | 9.2 ms | 10.3 ms | 18.2 ms | 3,645 | 497 MB |
| 12 / 12 | 9.2 ms | 9.9 ms | 22.4 ms | 4,805 | 592 MB |
| 16 / 16 | 9.7 ms | 10.2 ms | 27.2 ms | 7,605 | 777 MB |

**What Blockly should do with player count**

- Treat `maxPlayers` as a guidance cap that bounds the worst case: everyone spread out. Do not use it as the sizing input on its own.
- Size from the worst case: players × (2·vd+7)² chunks. Then correct from telemetry: loaded chunks, MSPT, generation backlog.
- Keep enforcing `max-players`, as Blockly already sets `MAX_PLAYERS`. It is the only hard bound on the spread-out worst case. Raising it should require a tier that fits players × chunks.

## View and simulation distance

Simulation distance decides what the CPU ticks. View distance mostly decides how many chunks are sent and kept loaded. Our own measurements are in Raw benchmark results.

**Definitions and loaded area** (sources accessed 2026-09-19)

- `view-distance` and `simulation-distance` are radii in chunks, from 3 to 32, both defaulting to 10. Simulation distance was added in 1.18. ([Server.properties](https://minecraft.wiki/w/Server.properties), [Java Edition 1.18](https://minecraft.wiki/w/Java_Edition_1.18))
- Around each player, entity ticking covers a (2s+1)² square. Block ticking covers (2s+3)², one ring further out. Chunks outside that are loaded but not ticked. ([Chunk](https://minecraft.wiki/w/Chunk))
- When several tickets cover the same chunk, only the lowest level counts. Players standing together share chunks, so their costs don't add up.
- 1.20.2 changed chunk sending: the server sends only chunks inside the client's render distance, paced by client acknowledgements. The server's view-distance is a ceiling. ([Java Edition 1.20.2](https://minecraft.wiki/w/Java_Edition_1.20.2))
- Spawn chunks were removed in 1.21.9. On 26.x, an empty server with nothing forceloaded ticks no chunks. ([Spawn chunk](https://minecraft.wiki/w/Spawn_chunk))

**Chunks per isolated player** (square upper bound; the client-side area has been circular since 21w37a, and the server-side shape is unverified)

| Radius r | Chunks in view, (2r+1)² | Entity-ticking at s = r | Block-ticking, (2r+3)² |
| --- | --- | --- | --- |
| 4 | 81 | 81 | 121 |
| 6 | 169 | 169 | 225 |
| 8 | 289 | 289 | 361 |
| 10 | 441 | 441 | 529 |
| 12 | 625 | 625 | 729 |
| 16 | 1,089 | 1,089 | 1,225 |

Raising view distance from 10 to 16 about 2.5× the chunks each isolated player holds. Going from 10 to 6 cuts it to about 0.38×.

**Paper-specific knobs** ([global config](https://docs.papermc.io/paper/reference/global-configuration/))

- `player-max-chunk-send-rate` is 75 chunks/s by default and `player-max-chunk-load-rate` is 100. A full view-distance-10 join is about 441 chunks, roughly 6 s at the send cap.
- `player-max-chunk-generate-rate` defaults to unlimited. It is the main lever for bounding exploration cost on Paper.

**Recommendations from sources**

- The wiki calls 10 the recommended default and says to lower it if the server lags.
- The [YouHaveTrouble optimization guide](https://github.com/YouHaveTrouble/minecraft-optimization) (26.3 branch, updated 2026-09-17) suggests starting at simulation 4 / view 7.
- No source gives a controlled CPU/RAM curve against distance. Our benchmarks fill that gap.

## World size and disk

On 26.3 a freshly generated overworld costs about 10.4 KB per chunk on disk with default compression. We measured that across 1,089 to 66,049 chunks, and it stays linear in the number of chunks generated. Disk growth is therefore driven by how much new terrain players reach, not by time or player count. A brand-new world is about 14 MB.

**Measured: Chunky square pregeneration around 0,0** (Fabric 26.3, `region-file-compression=deflate`, 4 CPUs, run `growth`)

| Radius (blocks) | Chunks | Overworld total | Per chunk | Gen time | Chunks/s | CPU cores used |
| --- | --- | --- | --- | --- | --- | --- |
| fresh world | \~650 full + protos | 14 MB | — | — | — | — |
| 256 | 1,089 | 14 MB | (spawn area dominated) | 11 s | 99 | 3.5 |
| 512 | 4,225 | 47 MB | 11.0 KB | 31 s | 136 | 3.4 |
| 1,024 | 16,641 | 173 MB | 10.4 KB | 127 s | 131 | 3.1 |
| 2,048 | 66,049 | 687 MB (region 667, entities 15.3, poi 4.7) | 10.4 KB | 496 s | 133 | 3.2 |

Other dimensions, 4,225 chunks each (512-block radius):

- **Nether:** 39.4 MB, 9.3 KB/chunk.
- **End:** 31.1 MB, 7.4 KB/chunk. Void chunks are still stored.
- **Whole test world:** 758 MB for 66k overworld chunks plus 8.4k nether/end chunks.

**Measured: region compression** (4,225 fresh chunks, separate fresh servers)

| `region-file-compression` | Overworld region bytes | vs deflate | Gen time |
| --- | --- | --- | --- |
| deflate (default) | 48.0 MB | 1.0× | 33 s |
| lz4 | 64.3 MB | 1.34× | 34 s |
| none | 207 MB | 4.3× | 37 s |

LZ4 saved no measurable generation time here, and on the M4 compression is not the bottleneck. Blockly should keep deflate. On a slow shared CPU LZ4 may pay off, but that is unmeasured.

**Measured: backups of the 758 MB world**

| Method | Size | Ratio |
| --- | --- | --- |
| raw | 760 MB | 1.00 |
| tar + gzip -6 | 503 MB | 0.66 |
| tar + zstd -3 | 500 MB | 0.66 |
| tar + zstd -19 | 495 MB | 0.65 |

The roughly one-third saving is mostly the zero padding in 4 KiB region sectors ([PaperMC SectorTool](https://github.com/PaperMC/SectorTool/blob/master/SPECIFICATION.MD) measured 26–42% padding). The chunk payloads are already zlib-compressed. Plan backup storage at about 0.66× world size per full copy, and use zstd -3, which is as good as -19 and much faster.

**Format facts** ([Region file format](https://minecraft.wiki/w/Region_file_format), [26.1 level format](https://minecraft.wiki/w/Java_Edition_level_format))

- One `.mca` file holds 32×32 chunks, with 4 KiB sectors and an 8 KiB header.
- `entities/` and `poi/` use the same container format. On 26.x they live under `dimensions/minecraft/<dim>/`.
- Player data moved to `players/`.
- Chunks are not recompressed when the setting changes.
- No primary source says region files ever shrink. Treat world bytes as monotonic unless a trim tool runs.

**How fast worlds reach budget sizes** (derived from 10.4 KB/chunk overworld; Nether/End add roughly 5–15% for typical play)

| World size | Overworld chunks | Square radius around spawn |
| --- | --- | --- |
| 1 GB | \~96,000 | \~2,500 blocks |
| 5 GB | \~480,000 | \~5,500 blocks |
| 10 GB | \~960,000 | \~7,800 blocks |
| 25 GB | \~2.4 million | \~12,400 blocks |

Measured exploration rates are in Raw benchmark results. At view distance 10, one player flying in a straight line through fresh terrain uncovers roughly 21 new chunks per 16 blocks travelled.

**Pre-generation**

- Pre-generating radius 2,048 cost 8.3 minutes of about 3.2 cores and 687 MB of disk.
- It moves generation CPU out of play time but commits disk that players may never visit.
- Current guidance ([YouHaveTrouble, 26.3 branch](https://github.com/YouHaveTrouble/minecraft-optimization)) says it only matters on weak CPUs. That is exactly Blockly's small-machine case, which argues for a small pre-generated spawn area (about 1,000 blocks, 173 MB) on the lowest tiers.
- Always set a world border so treasure-map searches stay bounded.

**Restart.** Stopping took under 1 s and booting on the 758 MB world took 14 s wall-clock (server `Done` in 0.2 s). On 26.x, world size does not slow restarts: spawn chunks are gone and chunks load lazily.

## Mods and modpacks

There is no evidence for a “RAM per mod” formula, and Blockly should not invent one. Memory follows registered block states, models, world-generation features and entity count. Mod count is a weak proxy for all of these. Our modpack measurements are in Raw benchmark results.

**Evidence**

- **FerriteCore** measured where modded memory goes, on 2020-era Forge packs ([summary.md](https://github.com/malte0811/FerriteCore/blob/main/summary.md)). The big items are about 600 MB for blockstate neighbour tables, about 200 MB for the shape cache and about 170 MB for property maps. All of these scale with block-state count, not with the number of jars.
- **FerriteCore's own before/after** ([Modrinth](https://modrinth.com/mod/ferrite-core)): in All Of Fabric 3, heap after worldgen went from 1,792 MB to 984 MB. The same mod list can nearly halve its memory with one optimisation mod.
- **Pack authors give flat figures, not formulas.**
  - All The Mods: “at least 6GB+ allocated”; the ATM9 example config uses 4 GB min / 8 GB max ([ATM guides](https://allthemods.github.io/alltheguides/help/server/)).
  - FTB: “Most FTB modpacks recommend at least 4GB-6GB” ([FTB docs](https://docs.feed-the-beast.com/docs/support/Guides/Server/)).
  - Hosting blogs suggest 10–16 GB for ATM10. They give no methodology, so these are supporting evidence only.
- **Chunky's FAQ** says modded world generation is slower ([FAQ](https://github.com/pop4959/Chunky/wiki/FAQ)). C2ME's benchmark with terrain mods shows vanilla at about 13 chunks/s on one thread.

**Known before launch (from metadata)**

| Source | Fields useful for sizing |
| --- | --- |
| Modrinth project/version API | loader, game versions, `environment` / `server_side`, dependencies, file `size` |
| `.mrpack` `modrinth.index.json` | file list with `env.server`, `fileSize`, loader and Minecraft version pins |
| CurseForge API (needs a key) | `fileLength`, dependencies, `serverPackFileId`, `modLoader` |
| `fabric.mod.json` / `neoforge.mods.toml` | declared side (client/server/both), dependencies |

- Pack metadata is not fully trustworthy. The itzg image ships `MODRINTH_EXCLUDE_FILES` to strip client mods that packs wrongly declare as server-side.
- Pre-launch signals Blockly can use: loader, number of server-side jars, total jar bytes, whether known worldgen mods are present (Terralith, Tectonic and similar), whether known optimisation mods are present (Lithium, FerriteCore, ModernFix, C2ME), and a pack author's stated RAM. These give a starting tier, not a final size.

**Only known at runtime**

- Heap live-set after boot and after worldgen
- Boot time
- MSPT under load
- Entity and block-entity counts
- Bytes per generated chunk
- Join payload size (registry sync)

Blockly should record these on first boot and resize from them.

## Network

Outbound traffic is almost all chunk data. It spikes on join and when players reach new terrain, and is small while players stand still. No modern source gives a rigorous per-player figure, so our measured numbers are in Raw benchmark results.

**Mechanics**

- `network-compression-threshold` defaults to 256 bytes and compresses with zlib. -1 disables compression. ([Server.properties](https://minecraft.wiki/w/Server.properties))
- Since 1.20.2 the client asks for a chunk rate at about half its measured bandwidth. The server waits for batch acknowledgements, so chunk bursts are self-throttled. The same release also batches small packets into larger TCP writes. ([Protocol](https://minecraft.wiki/w/Java_Edition_protocol/Packets), [1.20.2](https://minecraft.wiki/w/Java_Edition_1.20.2))
- Paper additionally caps sending at 75 chunks/s per player by default.
- Modded servers sync registries during the configuration phase, which makes joins larger. No measured byte counts exist.

**Evidence on volume**

- [Yardstick](https://atlarge-research.com/pdfs/jvdsar-yardstick-benchmark-icpe-2019.pdf) (ICPE 2019, peer-reviewed, Minecraft 1.11.2):
  - Chunk data was 93% of server-sent bytes.
  - Traffic grew linearly with player count.
- [Meterstick](https://arxiv.org/html/2112.06963v2) (ICPE 2023): entity messages were most packets but only 1.2–17.4% of bytes.
- Operator anecdotes give about 100 MB per player-hour, and 100–500 GB/month for 50–100 slot servers. These are supporting evidence only. [GameTeam's](https://gameteam.io/blog/minecraft-server-networking-bandwidth-requirements/) hosting figures contradict themselves (0.02 Mbps vs 50–100 MB per hour).

**What this means for hosting**

- Egress is small next to compute. It scales with players who explore, not with how long the server is up.
- The practical risks are join bursts through the edge router and heavy exploration, not steady state.
- Compression trades CPU for bytes. Setting -1 only makes sense on a LAN or behind a proxy that re-compresses, which Blockly's mc-router edge does not.

## Benchmark methodology

Every run started a disposable `itzg/minecraft-server:2026.9.1-java{17,21,25}` container. That is the image release Blockly pins in `runtime-spec.ts`. Each run got its own `mcb-*` container and volume, and runs went strictly one at a time. No Blockly or user servers were touched.

**Host.** Apple M4 (10 cores), Docker Desktop 29.8 Linux VM (10 vCPU, 7.75 GB), arm64. Limits were set per container with `--cpus` (a CFS quota) and `-m` (a cgroup v2 memory limit, no swap).

**Server config** (mirrors Blockly's `toRuntimeSpec`)

- `USE_AIKAR_FLAGS=TRUE` and `MEMORY=<heap>`, so Xms = Xmx.
- `ENABLE_AUTOPAUSE=FALSE`, RCON on, `ONLINE_MODE=FALSE` so bots can join.
- Fixed seed `blockly-bench`, default difficulty.
- Added for measurement: `-XX:NativeMemoryTracking=summary` and `-Xlog:gc`.

**Workloads**

| Need | Tool | Why this tool |
| --- | --- | --- |
| Server-side player equivalents | [Carpet](https://modrinth.com/mod/carpet) `/player <name> spawn` (Fabric 26.3) | Carpet bots are real `ServerPlayer`s: they hold chunk tickets, count for mob spawning and are simulated like players. They have no network socket. |
| Movement / exploration | RCON `tp` once per second, at 10 or 20 blocks/s | Repeatable. Every exploring run starts in its own never-generated area. |
| Controlled world generation | [Chunky](https://modrinth.com/plugin/chunky) square radius around 0,0 | Standard pregenerator. Reports chunks and time itself. |
| Real network clients | [mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39 bots on vanilla 1.21.11, the newest version it supports well | Speaks the real protocol, so we can measure bytes on the wire. |
| Modpacks | itzg `TYPE=MODRINTH` with `MODRINTH_MODPACK` | Same install path Blockly would use. |

**Metrics**

| Metric | Source | When |
| --- | --- | --- |
| Container memory, anon/file | cgroup `memory.current`, `memory.stat` | every 5 s |
| Java process RSS, thread count | `/proc/<pid>/status`, `/proc/<pid>/task` | every 5 s |
| CPU cores used, CFS throttling | cgroup `cpu.stat` | every 5 s |
| Disk write throughput | cgroup `io.stat` | every 5 s |
| Network RX/TX | container `/proc/net/dev` | every 5 s |
| MSPT avg, P50/P95/P99 | vanilla `/tick query` over RCON (1.20.3+; not on 1.16/1.18) | every 5 s |
| Heap used/committed | `jcmd GC.heap_info`, from a JDK mounted read-only (the image ships only a JRE) | every 5 s |
| Live set | `jcmd GC.class_histogram`, which forces a full GC; heap used after it | end of each phase |
| Loaded chunks | instance counts of `LevelChunk` / `ProtoChunk` in the same histogram (26.x jars are unobfuscated) | end of each phase |
| Native memory by category | `jcmd VM.native_memory summary` | end of each phase |
| GC pauses | `-Xlog:gc` log lines per phase | end of each phase |
| CPU per thread family | `/proc/<pid>/task/*/stat` utime + stime, grouped by thread name | per phase |
| World bytes | `du -sb` per dimension and folder | end of each phase |

**What “acceptable” means here.** Median MSPT ≤ 25 ms, which leaves half the 50 ms tick budget as headroom. P99 tick ≤ 50 ms outside of GC pauses. No “Can't keep up” lines. No OOM kill.

Harness source (`mcb.py`, `suite1-6.py`, `net/bots.ts`, `fly/bench.sh`) is in [`docs/research/minecraft-capacity/harness`](research/minecraft-capacity/harness). Every Python script runs with `uv run`, and the bots run with `bun run`. Raw per-run JSON (about 1.6 MB) was not committed; the tables in this doc carry its numbers.

## Raw benchmark results

This section holds the results not already tabled in the topic sections above: players, CPU/Fly, memory floor, disk. Unless stated otherwise, runs are local M4, Fabric 26.3, vd 10 / sd 10, 3 GB heap in a 4 GB container, Aikar flags. MSPT is median per phase. “Live” is heap after a forced full GC.

**Versions and loaders at idle, plus Chunky 4,225-chunk pregen** (4 CPUs unless noted; runs `ver-*`, `impl-*`, `cpu-*`, `base-*`)

| Run | Server `Done` | Live idle | Non-heap (NMT) | Pregen | Cores during pregen | Disk per chunk |
| --- | --- | --- | --- | --- | --- | --- |
| Vanilla 1.16.5 | 13.9 s | 249 MB | 388 MB | — | — | — |
| Fabric 1.16.5 | 16.9 s | 279 MB | 441 MB | 28 s (151/s) | 2.8 | 7.2 KB |
| Vanilla 1.18.2 | 24.0 s | 352 MB | 425 MB | — | — | — |
| Fabric 1.18.2 | 24.3 s | — | — | stalled at 22% (Chunky 1.2.164 bug) | — | — |
| Vanilla 26.3 (2 CPU) | first boot 34 s wall; restart 11 s wall | 132 MB | 25k classes | — | — | — |
| Fabric 26.3 | 0.2–2 s | 145–155 MB | 300–310 MB | 29 s (146/s) | 3.3 | 11.5 KB |
| Fabric 26.3 + Lithium + FerriteCore | 2.0 s | 149 MB | 306 MB | 25 s (169/s) | 3.3 | 8.9 KB |
| Paper 26.3 | 38.8 s wall | 240 MB | 356 MB | 74 s (57/s) | 1.4 | 12.8 KB |

1.16→1.18 raised both idle memory and disk per chunk, which fits the taller world. 26.x idle is lowest because spawn chunks are gone.

**Worldgen vs CPU limit** (4,225 chunks)

| CPUs | Fabric 26.3 | Paper 26.3 |
| --- | --- | --- |
| 1 | 78 s, 54/s | 92 s, 46/s |
| 2 | 62 s, 68/s | 65 s, 65/s |
| 4 | 29 s, 146/s | 74 s, 57/s |
| 8 | 19 s, 222/s | — |

**Entities** (1 bot inside an 80×80 glass pen, mob spawning off, 2 CPUs; run `entities`)

| Entities (`@e`) | Live | MSPT | Server-thread CPU |
| --- | --- | --- | --- |
| 80 (baseline) | 205 MB | 6.3 ms | 7 s/60 s |
| 312 (250 cows) | 233 MB | 10.5 ms | 18 s/90 s |
| 562 (500 cows) | 232 MB | 11.3 ms | 20 s/90 s |
| 1,057 (1,000 cows) | 249 MB | 15.1 ms | 28 s/90 s |
| 2,037 (2,000 cows) | 263 MB | 24.4 ms | 46 s/90 s |
| about 100 / 250 / 500 villagers added (many were lost to cramming) | 244 / 290 / 324 MB | 12.6 / 15.7 / 18.9 ms | 23 / 28 / 38 s |

Cows cost about 9 µs per entity per tick on M4, about 17 µs on Fly-class cores. Villagers cost roughly 3× a cow. A 2,000-mob farm alone uses half the tick budget on Fly hardware.

**Exploration, grouped vs apart** (5 bots at 10 blocks/s, 2 CPUs, 180 s; runs `exp-*`)

| Run | World growth | CPU | Terrain ahead ready | Live | GC |
| --- | --- | --- | --- | --- | --- |
| 5 apart | 126 MB (2.5 GB/h) | 1.37 cores | 68% of samples | 548 MB | 103 pauses, max 216 ms |
| 5 together | 34 MB (0.69 GB/h) | 0.52 cores | 99% | 306 MB | 45 pauses, max 67 ms |
| 1 bot at 20 blocks/s (`dist-10-10`) | 53 MB in 170 s (1.1 GB/h) | 0.64 cores | — | 314 MB | — |

**Network, real clients** (5 mineflayer bots, vanilla 1.21.11, vd 10, compression 256, 2 CPUs; run `net-5-vd10-b`)

| Phase | Egress (server → clients) | Ingress | Per player per minute (egress) | MSPT |
| --- | --- | --- | --- | --- |
| Empty server, 30 s | 344 B | 132 B | — | 0.7 ms |
| Join, 5 players | 13.0 MB | 358 KB | 2.6 MB per join | 7.2 ms |
| Idle, grouped | 2.4 MB/60 s | 420 KB | 0.48 MB (about 64 kbit/s) | 10.0 ms |
| Walking 4 blocks/s in generated terrain | 19.2 MB/60 s | 2.1 MB | 3.8 MB (about 0.5 Mbit/s) | 8.4 ms |
| Exploring together at 20 blocks/s | 72.8 MB/90 s | 3.4 MB | 9.7 MB (about 1.3 Mbit/s) | 5.4 ms |
| Exploring apart at 20 blocks/s | 6.1 MB/90 s | 0.9 MB | 0.8 MB\* | 4.5 ms |

\*Exploring apart was generation-bound on 2 CPUs. Few chunks were ready to send, so this is lower than what players would receive on a faster machine.

The first run (`net-5-vd10`) was invalid for both exploration phases: the bots were kicked for “flying”. It was fixed with `allow-flight` and creative mode.

**Modpacks** (heap and container as listed; Chunky 1,089 chunks)

| Pack | Loader / MC | Server mods, jar size | Heap / box | Boot (`Done`, wall) | Live idle | Classes | Idle CPU | Pregen | Live after gen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vanilla reference | — / 26.3 | 0 | 3 / 4 GB | 0.2 s, 34 s | 132 MB | 25k | 0.05 | 146/s (4 CPU) | \~180 MB |
| Cobblemon (light) | Fabric / 1.21.1 | 32, 158 MB | 3 / 4 GB | 5.8 s, 89 s | 567 MB | 39k | 0.09 | 60/s (3 cores) | 639 MB |
| Pixelmon (medium by count, heavy by load) | NeoForge / 1.21.1 | 13, 461 MB | 3 / 4 GB | 29.4 s, 180 s | 696 MB | 39k | 0.33 | 10.7/s | 971 MB |
| COBBLEVERSE (heavy), Fly performance-2x | Fabric / 1.21.1 | 115, 344 MB | 6 / 8 GB | 20.4 s, 116 s | 987 MB | 54k | 0.26 | \~13/s | 1,136 MB |
| Create+ | NeoForge / 1.21.1 | \~133 | 3 / 4 GB | failed: client class on dedicated server | — | — | — | — | — |
| Prominence II | Fabric / 1.20.1 | 339 | 6 / 8 GB (Fly) | failed: `s_lib` required but absent from pack | — | — | — | — | — |

Mod count did not predict cost. 13 Pixelmon mods out-cost 115 COBBLEVERSE mods on worldgen and idle CPU. Two of five packs could not boot as dedicated servers from their published metadata.

## Limitations

These results are strong on relative behaviour: chunk and memory curves, CPU shape, disk growth. They are weaker on absolute CPU constants, which come from a handful of Fly runs.

| Limitation | Effect | How much to trust affected numbers |
| --- | --- | --- |
| Local host is an Apple M4 under Docker Desktop (arm64 Linux VM), with other desktop workloads running | Absolute MSPT and chunks/s are 1.7–2.5× better than Fly EPYC for spread and worldgen. Background load adds noise (±20% seen between repeats). | Use for curves only |
| Fly calibration is 1 run per machine class, one region (ams), one day | No variance estimate; noisy-neighbour effects are unmeasured | Medium |
| Carpet bots are server-side players with no network, no client chunk acks and no real inputs | They load and tick chunks like players but never build, fight or use redstone. They are creative-mode, so mobs ignore them. | Good for chunk/memory/tick; optimistic for real survival play |
| Exploration is scripted teleport at 10–20 blocks/s in straight lines | Straight lines are the worst case for new chunks per second. Real players wander and revisit. | Upper bound |
| Entity tests used cows and villagers in one 80×80 pen | Villager counts are approximate (cramming and deaths), and farms with hoppers or redstone were not built | Cows: good. Villagers: indicative. Redstone: not measured |
| Modpacks: 3 packs, idle + short pregen, no bots | Modded player load was not measured, and modded clients cannot join mineflayer bots | Boot, heap and class counts: good. Per-player modded cost: unknown |
| Network: one mineflayer run on 1.21.11 vanilla (mineflayer lacks 26.3) | Protocol is close, but not identical to 26.3 | Medium |
| NMT and `-Xlog:gc` were enabled in every run | NMT costs a few MB and a small amount of CPU | Negligible |
| Several harness bugs were found and fixed mid-run: Chunky completion detection, heap parser on JDK 17/21, entity counter, zsh word-splitting, a `MODE` env collision | Runs affected by each bug were discarded and re-run. Entity counts are missing for runs before the fix. | Noted per table |

## Practical sizing conclusions

The smallest safe Fly machine for 1–5 vanilla/Paper players is performance-1x with 3 GB of RAM and a 2 GB heap. No shared-CPU size is safe. Memory follows loaded chunks, and CPU is a single-core ceiling that player spread and view distance consume.

**Answers to the sizing questions**

| Question | Answer | Evidence |
| --- | --- | --- |
| Smallest safe machine, 1–5 vanilla/Paper players | performance-1x, 3 GB, heap 2 GB, vd 10/sd 10 while grouped (vd 8/sd 6 if they spread). 2 GB with a 1 GB heap boots and runs, but GC-thrashes at 5 spread players (50 ms MSPT, 3.4 s pauses). | Fly `perf1x-2g-h1024`, `perf1x-4g`; local floor |
| 5–10 players | performance-2x, 4 GB, heap 2.5 GB, vd 8/sd 6. The second core is for GC, JIT, Netty and IO, not ticks. | Fly `perf2x-4g`; local `players*`, `dist-*` |
| 10–20 players | performance-4x, 6–8 GB, heap 4 GB, vd 8/sd 6 or lower. This is only playable if players cluster: 10 spread players at vd 10 would be about 70 ms/tick on Fly cores (38 ms on M4 × 1.85). | Local `players*`, Fly M4-to-EPYC ratio. Low confidence. |
| RAM outside `-Xmx` | About 400 MB JVM native (NMT 230–440 MB, RSS − heap 340–510 MB), plus about 250 MB for OS and page cache. At least 650 MB total; use \~25% above 3 GB heaps. Blockly's flat 25% is too little at 2 GB: 512 MB gave an OOM kill. | Local `floor-h1024-m1280/m1152`; Fly `perf1x-2g` |
| CPU class and count | Class: Fly `performance` only, since shared was throttled to 50–92% steal and crashed in every size. Count: 1 core up to about 4 spread players; 2 cores to absorb GC/IO and exploration spikes; 4+ only for heavy worldgen, pregen or modpacks, because vanilla uses CPUs − 1 worldgen workers. | Fly matrix; local CPU scaling |
| When does lowering vd/sd save cost? | Memory: always, since chunks per player go (2·vd+7)² from 729 at vd 10 to 361 at vd 6, halving spread-player memory. Tick: from vd/sd 16→10 the extra spread-player cost halves; from 10→6/4 it only drops about 20%. Reducing below 8/6 buys memory, not CPU. | `dist-*` |
| Exploring apart vs together | 5 apart vs together: 3.7× disk growth (2.5 vs 0.69 GB/h), 2.6× CPU (1.37 vs 0.52 cores), 1.8× live heap. Generation fell behind (68% of samples had terrain ready vs 99%). Standing spread: 10 apart cost 4× the tick time of 10 together. | `exp-*`, `players` |
| Classifying modded servers before launch | Use loader, server-side jar bytes, class-heavy or worldgen mods present, and the pack's stated RAM. Not mod count. Pixelmon (13 mods) out-cost COBBLEVERSE (115). Treat every modpack as “unverified” until a first boot records live heap and pregen rate. 2 of 5 packs could not boot at all. | Modpack table |
| When to resize from telemetry | See Runtime signals: live set > 60% of heap for 30 min, GC > 5% of time, any OOM, MSPT > 30 ms for 10 min, steal > 20%. | Floor boundaries; Fly runs |

**Bandwidth is not a cost driver.** 5 real clients used 0.48 MB/min each idle, 3.8 MB/min walking and about 9.7 MB/min exploring. A player exploring nonstop for an hour sends about 0.6 GB, roughly $0.012 at Fly's $0.02/GB. A 10-player server with 4 hours a day of mixed play, at about 2 MB/min per player, is roughly 150 GB/month, about $3. Compute dominates, at $32–64+/month per performance machine.

**Disk grows with exploration, not time.**

- A new world is 14 MB. It grows 0.7–2.5 GB per hour of 5-player exploration, and about 10.4 KB per new overworld chunk.
- 5 GB covers about a 5,500-block-radius overworld.
- Blockly should default a world border (5,000–10,000 blocks) so disk use is bounded and projectable.

**Changes to Blockly's current runtime spec that the evidence requires**

1. `guestFor()` must use `cpu_kind: 'performance'`. Shared CPUs failed every test.
2. The heap must stop being 75% of machine RAM. Use `heap = machine − max(650 MB, 20%)`. At 2 GB that is a 1.25–1.4 GB heap, not 1.5 GB.
3. The 2 GB tier should be sold only for 1–3 grouped players at vd ≤ 8, or dropped. 3 GB is the first comfortable size.
4. The Blockly default of vd 10/sd 10 is fine for grouped small servers. Default to 8/6 when the expected player count is above 5.

## Proposed sizing model

The model is a function of static inputs, corrected by runtime telemetry. It is not a tier table. Every constant below comes from a measured run named in this doc, and each has an owner in telemetry that can overrule it.

**Inputs and when Blockly knows them**

| Input | Known | Source |
| --- | --- | --- |
| `version`, `loader`, `viewDistance`, `simulationDistance`, `maxPlayers` | before launch | revision |
| `modProfile`: jar bytes, count, known worldgen or optimisation mods, pack author RAM | before launch | Modrinth / mrpack metadata |
| `worldSizeBytes` | before launch (import) and continuously | volume |
| live set after GC, MSPT, steal, loaded chunks, GC pause %, world growth | runtime only | telemetry |

```typescript
type ModProfile =
  | { kind: 'none' }                                      // vanilla, Paper, or Fabric with a few server-side mods
  | { kind: 'pack'; serverJarBytes: number; classHeavy: boolean; worldgenMods: boolean; authorRamMb?: number }

interface RuntimeTelemetry {
  liveSetMb: number          // heap after GC, p95 over 7 days
  msptP50: number            // median over busy hours
  stealPct: number
  peakPlayers: number
  worldGrowthMbPerDay: number
}

// Constants measured on 26.3 (Fly = performance cores, ams, 2026-09-19).
const BASE_LIVE_MB = { vanilla: 150, fabric: 155, paper: 240 }  // empty server, after GC
const MB_PER_LOADED_CHUNK = 0.1                                 // 80–120 KB measured
const JVM_NATIVE_MB = 400                                       // RSS − heap was 340–510 MB
const OS_MB = 250
const FLY_MS_FIRST_PLAYER = 6.5, FLY_MS_PER_SPREAD_PLAYER = 6.8  // vd 10 / sd 10
const roundUp = (mb: number, step: number) => Math.ceil(mb / step) * step

function recommendRuntime(w: {
  version: string; loader: 'vanilla' | 'paper' | 'fabric' | 'neoforge' | 'forge'
  expectedPlayers: number; viewDistance: number; simulationDistance: number
  modProfile: ModProfile; worldSizeBytes: number; runtimeTelemetry?: RuntimeTelemetry
}) {
  const reasons: string[] = []
  const chunksPerPlayer = (2 * w.viewDistance + 7) ** 2       // measured exactly
  // Assume at most half the players are apart beyond 2; telemetry replaces this guess.
  const spreadGroups = Math.min(w.expectedPlayers, Math.max(2, Math.ceil(w.expectedPlayers / 2)))

  let baseLive = w.loader === 'paper' ? BASE_LIVE_MB.paper : BASE_LIVE_MB.vanilla
  if (w.modProfile.kind === 'pack') {
    // Measured: light pack 570 MB, class-heavy or worldgen packs 700–1,000 MB empty.
    baseLive = w.modProfile.classHeavy || w.modProfile.worldgenMods ? 1000 : 600
    reasons.push('modpack: base live set assumed until first boot is measured')
  }
  let liveSet = baseLive + spreadGroups * chunksPerPlayer * MB_PER_LOADED_CHUNK
  if (w.runtimeTelemetry) {
    liveSet = Math.max(liveSet * 0.5, w.runtimeTelemetry.liveSetMb)
    reasons.push('live set from telemetry')
  }

  const heapMb = roundUp(Math.max(1024, liveSet * 1.6, w.modProfile.kind === 'pack' ? (w.modProfile.authorRamMb ?? 0) : 0), 256)
  const machineMemoryMb = roundUp(heapMb + Math.max(JVM_NATIVE_MB + OS_MB, heapMb * 0.2), 256)
  const minMachineMemoryMb = roundUp(Math.max(1024, liveSet * 1.25) + JVM_NATIVE_MB + OS_MB, 256)

  // CPU: tick cost is single-threaded; the budget is 25 ms (half the tick) at expected spread.
  const distanceFactor = w.viewDistance <= 6 ? 0.8 : w.viewDistance >= 16 ? 1.9 : 1
  const estMspt = FLY_MS_FIRST_PLAYER + (spreadGroups - 1) * FLY_MS_PER_SPREAD_PLAYER * distanceFactor
  if (estMspt > 25) reasons.push(`estimated ${estMspt.toFixed(0)} ms/tick at this spread: lower vd/sd or expect lag`)
  let cpuCount = w.expectedPlayers <= 3 ? 1 : w.expectedPlayers <= 10 ? 2 : 4
  if (w.modProfile.kind === 'pack' && w.modProfile.worldgenMods) cpuCount = Math.max(cpuCount, 4)
  if (w.runtimeTelemetry && w.runtimeTelemetry.msptP50 > 30) reasons.push('MSPT high: needs faster cores, not more')

  const diskBudgetGb = Math.max(5, Math.ceil((w.worldSizeBytes / 2 ** 30) * 1.5 + (w.modProfile.kind === 'pack' ? 2 : 0) + w.expectedPlayers * 0.5))

  const confidence = w.modProfile.kind === 'pack' && !w.runtimeTelemetry ? 'low' : w.expectedPlayers > 10 ? 'low' : 'medium'
  return { machineMemoryMb, minMachineMemoryMb, jvmHeapMb: heapMb, cpuClass: 'performance', cpuCount, diskBudgetGb, estMspt, confidence, reasons }
}
```

**What changes at runtime**

- **Heap:** the first boot plus 24 hours of play replaces the assumed live set.
- **CPU:** measured MSPT and steal replace the tick estimate.
- **Disk:** world growth per day replaces the disk budget.
- **Distance:** vd/sd are the cheapest knobs, because they need no machine change. Blockly should offer them first when MSPT is high but the live set is fine.

**Blockly defaults this evidence supports**

| Setting | Current | Recommended |
| --- | --- | --- |
| CPU kind | shared | performance |
| Heap | 75% of RAM | RAM − max(650 MB, 20%) |
| JVM flags | Aikar G1 + AlwaysPreTouch | Keep G1/Aikar. PreTouch is fine because the budget already reserves the full heap, but never read RSS as usage. |
| vd / sd | 10 / 10 | 10 / 10 for up to 5 expected players; 8 / 6 above 5; 6 / 4 for 15+ |
| World border | none | 10,000 blocks by default so disk is projectable (about 4 GB fully explored overworld at radius 5k; 16 GB at 10k) |
| Disk | 5/10/15/20 GB tied to RAM | 5 GB for vanilla, 10 GB for modpacks, plus growth-based expansion |
| Modpacks | trusted metadata | first boot is a verification step that records live set and boot success before the server is shown as ready |

## Runtime signals and resize rules

Blockly should resize from JVM and tick telemetry, never from container RSS. With `AlwaysPreTouch`, RSS equals the heap from boot.

Every signal below was available in our harness through supported tooling: `/tick query` over RCON, `jcmd`, `/proc`, and the G1 GC log. Every rule needs a sustained window, never a single sample. Tick and GC spikes of 100 ms–7 s appeared in every run after boot, JIT warm-up and world saves.

**Signals to collect**

| Signal | Source | Cadence | Why |
| --- | --- | --- | --- |
| MSPT median and P95 | `/tick query` (1.20.3+) or spark | 30 s | Direct measure of lag |
| Heap used after GC, i.e. live set | GC log `A->B(C)` after-values, or `jcmd GC.heap_info` | per GC / 60 s | The memory signal that actually matters |
| GC pause rate and total pause % | GC log | 60 s | Early warning before OOM |
| CPU steal % | `/proc/stat` field 8 | 30 s | Detects shared-CPU throttling |
| CPU busy % per core | `/proc/stat` | 30 s | Is the tick thread the bottleneck (1 core full) or worldgen (all cores)? |
| Loaded chunks | spark or a small mod; `LevelChunk` count from a class histogram is a lab-only method | 5 min | Explains memory and tick load |
| Online players and their spread | RCON `list`, player positions | 60 s | Grouped vs spread |
| World bytes per dimension | `du` on the volume | 15 min | Disk budget |
| “Can't keep up” log lines | server log | event | Hard overload signal |
| OOM kill / exit code 137 | runtime provider | event | Immediate resize |

**Resize rules** (thresholds from the benchmark boundaries; tune after production data)

1. **Scale memory up:** live set after GC > 60% of heap for 30 min, GC pause time > 5% over 10 min, or any Java `OutOfMemoryError`. The floor runs degraded at 73% occupancy and failed at 100%.
2. **Emergency memory resize:** any OOM kill of the container. Set the new heap to at least 2× the last observed live set.
3. **Scale CPU class or count up:**
   - MSPT median > 30 ms for 10 min with one core near 100%: move to faster single-core hardware. More cores don't fix this.
   - All cores busy while players explore and chunks fall behind: add cores, 4 minimum for worldgen parallelism.
4. **Throttling alarm:** steal > 20% sustained means the machine is on the wrong CPU kind. This must never happen on `performance` CPUs.
5. **Scale down:** only after 7 days with MSPT median < 10 ms, live set < 35% of heap and peak players below the tier's grouped capacity. Never below the loader's floor.
6. **Disk:** warn at 70% of volume, grow at 85%. Project growth from the last 7 days of world-bytes deltas, since exploration can add 0.7–2.5 GB/hour.
7. **Soft mitigations before resizing:** Blockly controls view and simulation distance. Offer lower vd/sd when MSPT is high but memory is fine, because distance cuts both chunk count and tick work.

## Where evidence is insufficient, and the benchmark ledger

The remaining gaps are all about real player behaviour under load: survival play, farms, redstone and modded players. None of them changes the core decisions (performance CPU, the heap/native budget, chunk-based memory, distance defaults). They affect how far each machine stretches.

**Still uncertain**

- **10–20 players on Fly.** No 10-player Fly run exists. The estimate extrapolates the M4-to-Fly ratio (about 1.85× for spread ticks). Next test: a performance-2x with 10 Carpet bots at vd 8/sd 6.
- **Paper under player load.** Only idle and pregen were measured. Paper's entity and chunk optimisations probably raise capacity, but that is unquantified.
- **Redstone and hopper farms.** Not built. Entity cost is measured only for cows and villagers.
- **Modded per-player cost.** Modpacks were measured empty plus pregen. Heavy packs like ATM, with 300+ mods, were not tested, so pack-author guidance of 6–10 GB stands unverified.
- **Network on 26.3.** mineflayer lacks 26.3, so 1.21.11 was used. There is also only one network run.
- **Fly variance.** One run per machine class. The shared-CPU verdict is unambiguous, but performance-core MSPT may vary ±20% across hosts.
- **Survival real players.** Mob AI targeting players, combat and building are absent in creative-mode bots.

**Ledger**

| Benchmark | Priority | Where | Status |
| --- | --- | --- | --- |
| 26.3 vanilla baseline: boot, idle, restart | REQUIRED | local | done |
| Fabric / Paper / optimised Fabric 26.3 idle + pregen | REQUIRED | local | done |
| Worldgen vs CPU limit (1–8) | REQUIRED | local | done |
| World growth to 66k chunks, compression, backups, restart | REQUIRED | local | done (re-run once after a Chunky wait bug) |
| View distance 6/4 → 16/16 with 1/5 bots | REQUIRED | local | done |
| 10 bots together / spread / dimensions / exploring at 1, 2, 4 CPUs | REQUIRED | local | done |
| 5 exploring apart vs together | REQUIRED | local | done |
| Entities: cows and villagers | USEFUL | local | done |
| Memory floor: heap 1,024 → 512 and container 1,280/1,152; 10-spread at 1 GB | REQUIRED | local | done |
| Fly calibration: shared-1x/2x/4x, performance-1x (2 GB × 2 heaps, 4 GB), performance-2x | REQUIRED | Fly (a throwaway app, auto-destroyed) | done |
| Network with real clients, 5 players | REQUIRED | local | done (first run invalid, fixed) |
| Modpacks light / medium / heavy | REQUIRED | local + Fly | done: Cobblemon, Pixelmon, COBBLEVERSE. Create+ and Prominence II failed to boot, which is recorded as a finding. |
| 1.20.6 / 1.21.11 vanilla idle; 1.18.2 Fabric pregen | OPTIONAL | — | skipped: 1.16/1.18/26.3 already bracket the version effect, and Blockly offers only 1.21.8+ and 26.x |
| NeoForge 26.3 bare; C2ME scaling | OPTIONAL | — | skipped: NeoForge 26.3 is beta only; C2ME's own published curve covers it |
| Network permutations (vd 6/16, compression -1/64, 1/10 players, Paper) | OPTIONAL | — | skipped: bandwidth is not a cost driver, so these would not change a decision |
| CPU floor at 0.5/1 local CPUs; second 10-spread floor; 10-bot explore variants | USEFUL | — | skipped: superseded by the Fly runs, which answered CPU class on real hardware |
| Carpet bots on Paper; 10 bots on Fly | USEFUL | — | not run: Carpet is Fabric-only; 10-on-Fly is the top follow-up above |

**Resource hygiene.** In the second half of the study, local runs used at most 2 CPUs (4 for pack pregen) and a 4 GB container, one at a time, with load and memory-pressure back-off. All `mcb-*` containers and volumes and 4 pulled images were removed afterwards. The throwaway Fly app and every machine in it were destroyed after results were pulled.

## Representative profiles

All on Fly `performance` CPUs; no shared-CPU size is usable. Machine RAM = heap + at least 650 MB. MSPT is the median; TPS stays 20 whenever MSPT < 50 ms. “Measured” means a Fly run; “M4” means local only; “est.” means extrapolated.

| Profile | MC / loader | Players | vd / sd default | Min usable RAM (heap) | Recommended RAM (heap) | CPU | Starting disk | Observed MSPT | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–5 vanilla/Paper | 26.3 vanilla, Fabric-equivalent; Paper idle only | 1–5 | 10 / 10 | 2 GB (1 GB), grouped players only | 3 GB (2 GB) | 1 performance core; 2 if players explore | 5 GB | Measured perf-1x: 1 bot 6.7–9.2 ms; 5 together 6.8–9.7 ms; 5 spread 31 ms (3 GB heap) / 50 ms (1 GB heap) | Medium–high |
| 5–10 vanilla/Paper | same | 5–10 | 8 / 6 | 3 GB (2 GB) | 4 GB (2.5–3 GB) | 2 performance cores | 10 GB | Measured perf-2x: 5 spread 33.8 ms at vd 10. Est. 10 spread about 60+ ms, so it needs grouping or vd 8/6. | Medium |
| 10–20 vanilla/Paper | same | 10–20 | 6–8 / 4–6 | 4 GB (3 GB) | 6 GB (4 GB) | 2–4 performance cores (ticks stay single-core) | 10–15 GB | M4: 10 together 9.6 ms, 10 spread 38 ms. Fly est. about 70 ms spread at vd 10. | Low |
| Light Fabric pack (Cobblemon-class, \~30 mods, <200 MB jars) | 1.21.1 Fabric | 1–5 | 10 / 8 | 3 GB (2 GB) | 4 GB (3 GB) | 2 performance cores | 10 GB | M4: idle 0.3 ms; live 567 → 639 MB after gen | Medium |
| Medium pack (Pixelmon-class, heavy mods or >400 MB jars) | 1.21.1 NeoForge | 1–5 | 8 / 6 | 4 GB (3 GB) | 6 GB (4.5 GB) | 4 performance cores (worldgen about 10× slower than vanilla) | 10 GB | M4: idle 1.4 ms, 0.33 cores idle, 3 s startup stall; live 696 → 971 MB | Low–medium |
| Heavy pack (COBBLEVERSE-class, 100+ mods) | 1.21.1 Fabric | 1–5 | 8 / 6 | 5 GB (3.5 GB), est. | 8 GB (6 GB) | 4 performance cores | 15 GB | Measured perf-2x 8 GB: idle 0.4 ms after a 7.5 s startup stall; live 987 → 1,136 MB; GC max 2.6 s | Low |

World storage for every profile starts at about 14 MB. It grows about 10.4 KB per new overworld chunk, 0.7–2.5 GB per hour of 5-player exploration, and about 0.66× world size per compressed backup.

**Next calibration runs that would raise confidence**, each a short run on Fly:

- 10 Carpet bots on performance-2x at vd 8/sd 6
- Paper with real clients on performance-1x
- COBBLEVERSE at 4–5 GB
