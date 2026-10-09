#import "../style.typ": *

#part("Runtimes", [The one port every way of running a server goes through, how several run at once,
  the fleet runtime and its node daemon, what one machine holds, and how a node is chosen.])

= The MinecraftRuntime abstraction <s-runtime-port>

Everything above the port speaks Minecraft and product: servers, plans, worlds, players. Everything
below speaks containers, volumes and machines, and knows nothing about Minecraft
(#src("apps/control/src/app/ports/runtime.ts:1")). A provider is an adapter, not an application
change. #implemented

#fig(draw(
  spacing: (8mm, 9mm),
  cp((2, 0), [Application\ #text(size: 6.4pt)[servers, operations, schedules, edge service]], name: <app>),
  cp((2, 1), [`Runtimes` port: `RuntimeRouter`\ #text(size: 6.4pt)[dispatches by `owns(handle)`]], name: <router>),
  cp((0, 2), [FlyRuntime], name: <fly>),
  cp((1, 2), [BoatRuntime], name: <boat>),
  cp((2, 2), [FleetRuntime], name: <fleet>),
  cp((3, 2), [DockerRuntime], name: <docker>),
  cp((4, 2), [FakeRuntime], name: <fake>),
  ext((0, 3), [Fly Machines API], name: <flyapi>),
  ext((1, 3), [Boat API], name: <boatapi>),
  rt((2, 3), [blocklyd nodes], name: <nodes>),
  rt((3, 3), [local Docker], name: <dock>),
  node((4, 3), text(size: 6.4pt)[in-process,\ for tests], stroke: none),
  edge(<app>, <router>, "-|>", lbl[MinecraftRuntime calls]),
  edge(<router>, <fly>, "-|>"), edge(<router>, <boat>, "-|>"), edge(<router>, <fleet>, "-|>"),
  edge(<router>, <docker>, "-|>"), edge(<router>, <fake>, "-|>"),
  edge(<fly>, <flyapi>, "-|>"), edge(<boat>, <boatapi>, "-|>"),
  edge(<fleet>, <nodes>, "-|>", lbl[mTLS]), edge(<docker>, <dock>, "-|>"),
), caption: [One port, five adapters. The router is in the path even with one runtime. #src("apps/control/src/app/runtimes/router.ts:131"), #src("apps/control/src/main.node.ts:105").], name: "fig-port")

The contract, in the parts that shape everything else:

- *Handles are opaque.* A runtime issues a branded string (`fly:v1:…`, `boat:v1:…`,
  `fleet:v1:…`, `docker:v1:…`); the application stores and passes it but never reads it. The
  binding row records the provider beside it, and `scripts/check-boundaries.ts` bans provider
  names above the port, so nothing up there can branch on where a server runs.
- *Intent, not steps.* `ensureProvisioned(key, placement, spec, progress)` is idempotent and
  convergent: called again after a crash, it finishes what exists and leaves the server started.
  `ProgressSink.handle()` persists a handle the moment one exists, so a crash never orphans compute.
- *Endpoints name an audience.* `endpoint(handle, port, 'edge' | 'control')`: who can reach what
  depends on the caller's network. `stableEndpoints` says whether a stopped server's address still
  reaches only it (Fly's Flycast: yes; Boat's per-run IPv6: no).
- *Declining is explicit.* A runtime may refuse `deleteSnapshot` (`RuntimeUnsupported`), leave
  limits null, ignore an install seed, or treat a move as a no-op where it has one place.
  `RuntimeFull` means "no room just then"; the owner is told that, not the provider's words.

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Group][Members (full signatures: @a-interfaces)],
    [Lifecycle], [`ensureProvisioned`, `apply`, `start` (may return a new handle), `restart` (same compute), `stop`, `forceStop`, `waitRunning`, `decommission`, `release`, `adopt`, `destroy`],
    [World], [`snapshot`, `goneSnapshots`, `deleteSnapshot`, `restore` (from a snapshot or an archive URL), `relocate` (region move, or rebuild after a lost host), `exportSnapshot`, `snapshotLifetimeDays`],
    [Seeing], [`observe`, `observeChanged` (one listing per pass), `inventory`, `isPlaced`, `sameCompute`, `exec`],
    [Reaching], [`endpoint`, `stableEndpoints`],
    [Room and money], [`serverCeiling`, `hasRoom`, `capacity`, `prices`, `tag`, `locate`],
    [Routing], [`provider`, `owns`, `ownsSnapshot`],
  ),
  caption: [The port's members. #src("apps/control/src/app/ports/runtime.ts:192").],
  kind: table,
)

#why[Providers differ in how they start, stop, snapshot and fail, and in what an hour of running
costs. Keeping the provider behind one port is what made Boat and the fleet
possible without touching the application, and what lets them run side by side. The price is a
lowest-common-denominator contract, paid for with the explicit "decline" clauses above.]

#mismatch[`docs/architecture.md` is the design the code cites by section; it was brought up to date
alongside this document. Where either disagrees with the code, the code decides.]

= Several runtimes in one deployment <s-hybrid>

A deployment runs one or more runtimes at once (`RUNTIME_PROVIDERS`); every server is on exactly
one, named by its binding. #implemented. *Configured nowhere yet:* production and staging set
`RUNTIME_PROVIDER=fly` only, local development `docker`
(#src("infra/terraform/environments/production/config.auto.tfvars.example.json")).

#fig(draw(
  spacing: (17mm, 10mm),
  who((0, 0), [new server]),
  cp((1, 0), [Placement rules\ #text(size: 6.4pt)[first match wins:\ accounts · regions · plans · percent]], name: <rules>),
  cp((2, 0), [Runtime chosen\ #text(size: 6.4pt)[decision recorded\ with what was considered]], name: <chosen>),
  cp((1, 1), [Default runtime\ #text(size: 6.4pt)[`RUNTIME_PROVIDER`; at its limit,\ the next one with room]], name: <def>),
  cp((2, 1), [Binding\ #text(size: 6.4pt)[`server_runtimes`:\ provider + handle]], name: <bind>),
  cp((3, 1), [RuntimeRouter\ #text(size: 6.4pt)[every later call\ by `owns(handle)`]], name: <router>),
  edge((0, 0), <rules>, "-|>"),
  edge(<rules>, <chosen>, "-|>", lbl[a rule matches\ and has room], label-side: left),
  edge(<rules>, <def>, "-|>", lbl[no rule], label-side: right),
  edge(<def>, <chosen>, "-|>"),
  edge(<chosen>, <bind>, "-|>"),
  edge(<bind>, <router>, "-|>"),
), caption: [Placement across runtimes decides once, when a server is made. #src("apps/control/src/app/runtimes/placement.ts:76"), #src("apps/control/src/app/runtimes/service.ts:42").], name: "fig-hybrid")

- *Rules* (`runtime_rules`) are read in creation order; the first enabled rule that matches the
  owner (an allowlist of accounts), the region, the plan, and the server's share wins. The share is
  stable: the first four bytes of `sha256(ruleId:serverId)`, as a number from 0 to 100 in steps of
  0.01, against the rule's percent. A rule whose runtime is at its provider's server limit, or says
  it has no room, is skipped. Nothing else is weighed: no prices, no optimiser
  (#src("app/runtimes/placement.ts:10")).
- *Overflow.* If the default runtime is at its provider's limit, a new server goes to the next
  runtime in `RUNTIME_PROVIDERS` with room (`overflow: …`).
- *First-start fallback.* A server a rule sent to another runtime, that never started, whose
  runtime says `RuntimeFull`, moves once to the default runtime (`fell_back`), and what the first
  runtime began is destroyed (#src("apps/control/src/app/runtimes/service.ts:109")). One the default
  overflowed has no fallback, since the default is full. After a first start there is no fallback:
  a start without room puts the server back to sleep.
- *Region maps.* `RUNTIME_REGION_MAP` is the default runtime's. Every other runtime places only the
  regions its own `<NAME>_REGION_MAP` names, and boot refuses one without
  (#src("apps/control/src/config/schema.ts:288")).
- *Moves between runtimes* are only an operator's (`bun scripts/runtimes.ts move <id> --to fly`).
  The relocation sweep makes them at the server's next quiet moment, through the archive store:
  stop, archive copy (size checked, `level.dat` found), `adopt` on the target, restore, rebind in
  one transaction, then the old runtime's copy is destroyed. A failed move leaves the server where
  it was (`move_failed`). A resting server moves by its binding alone.
- *Foreign bindings.* Dropping a runtime from `RUNTIME_PROVIDERS` makes its servers `foreign`:
  refused by every handler, not migrated. It is not an off-switch.

#why[Decide once, record why, never move a server because a rule changed: turning a canary off
strands nothing, and where a server runs is explained in one place
(#src("apps/control/src/app/runtimes/service.ts:42")). Owners are never asked: where a server runs
is Blockly's decision (AGENTS.md's core rule), and it is visible to operators in
`runtime_decisions`.]

= FleetRuntime <s-fleet-runtime>

The fleet is Blockly's own runtime: Minecraft servers on Linux machines Blockly rents, each running
blocklyd. There is no cluster: no quorum, no consensus store, no Kubernetes or Nomad, no service
mesh, no distributed filesystem, no live migration, and no automatic failover
(#src("docs/fleet.md:3")). #implemented in code; #canary in use: reached only when an operator adds
`fleet` to `RUNTIME_PROVIDERS` and sends servers there. Never run on independent real hosts.

*One machine is a whole fleet.* The same runtime, tables and code paths serve one node or many.

#fig(grid(
  columns: (1fr, 1fr), column-gutter: 3mm,
  draw(
    spacing: (8mm, 12mm),
    cp((1, 0), [Control plane\ #text(size: 6.4pt)[FleetRuntime · Postgres]], name: <cp>),
    rt((0, 0), [Edge], name: <edge>),
    ext((2, 0), [Archive\ store], name: <s3>),
    rt((1, 1), [blocklyd + Docker\ #text(size: 6.4pt)[server 1 · server 2 · … · server N]], name: <node>),
    ..zone((<node>,), [the one machine], name: "one", side: "south"),
    edge(<cp>, <node>, "<|-|>", lbl[mTLS: calls,\ heartbeats], label-side: left),
    edge(<edge>, <node>, "-|>", lbl[game\ ports], label-side: right),
    edge(<node>, <s3>, "--|>", lbl[archives], label-side: right),
  ),
  draw(
    spacing: (6.2mm, 12mm),
    cp((1, 0), [Control plane\ #text(size: 6.4pt)[FleetRuntime · Postgres]], name: <cp>),
    rt((0, 0), [Edge], name: <edge>),
    ext((2, 0), [Archive\ store], name: <s3>),
    rt((0, 1), [Node A\ #text(size: 6.4pt)[servers]], name: <a>),
    rt((1, 1), [Node B\ #text(size: 6.4pt)[servers]], name: <b>),
    rt((2, 1), [Node C\ #text(size: 6.4pt)[servers]], name: <c>),
    ..zone((<a>, <b>, <c>), [a region, on a private network], name: "many", side: "south"),
    edge(<cp>, <a>, "<|-|>"), edge(<cp>, <b>, "<|-|>"), edge(<cp>, <c>, "<|-|>"),
    edge(<edge>, <a>, "-|>"),
    edge(<c>, <s3>, "--|>"),
  ),
), caption: [The fleet with one node (left) and with several (right). Nodes never talk to each other; worlds move only through the archive store.], name: "fig-fleet")

#figure(
  table(
    columns: (1.2fr, 1.4fr, 1.4fr),
    table.header[][One node][Several nodes],
    [Placement], [One choice: the node, or `RuntimeFull`.], [Filter and score every node (@s-placement).],
    [A full node], [A start waits for room (`RuntimeFull`, back to sleep).], [A sleeping server moves to a node with room, then starts.],
    [Operator moves, drains], [Refused as `RuntimeFull` before anything stops: the server stays where it is, running if it ran.], [Work: through the archive store, with a new epoch.],
    [The host is lost], [Servers wait, or are rebuilt from the archive store once another node exists.], [Rebuilt on other nodes from their last uploaded snapshots (@s-node-loss).],
    [Backups], [Still leave the machine (archive store): a lost host loses at most the play since the last upload.], [The same.],
  ),
  caption: [What a second node changes. Nothing else does.],
  kind: table,
)

What FleetRuntime owns, beside the port's methods:

- *The ledger* (`fleet_placements`): per server, its node, epoch, state (`placing`, `placed`,
  `displaced`, `released`), size, desired power and when it last changed (#src("docs/fleet.md:152")).
- *Epochs and fences* (@s-epochs), *moves and rebuilds* (@s-relocation, @s-node-loss), *two-step
  snapshots* (@s-backup), and *running admission*: only servers that run, start or are being made
  hold memory (@s-capacity).
- *The node endpoint* (`FLEET_NODE_LISTEN`, 8443, on the `api` role): enrollment, heartbeats,
  renewal; and *upkeep* on the `worker` role each minute.
- *Cost*: a node may carry its monthly price as a label (`monthly_cost_cents`); a server's share by
  memory is reported as its storage-month price (running hours cost 0: the node is paid for either
  way).

= blocklyd <s-blocklyd>

One static Rust binary per node (about 11,400 lines; `cubepals/blocklyd`, under FSL-1.1-ALv2), running as
root beside Docker. It owns what exists on its host and decides almost nothing.
#implemented

#fig(draw(
  spacing: (13mm, 10mm),
  cp((0, 0), [Control plane], name: <cp>),
  rt((1, 0), [mTLS API\ #text(size: 6.4pt)[`api.listen` :7443 · TLS 1.3]], name: <api>),
  rt((2, 0), [Manager\ #text(size: 6.4pt)[records · locks · epochs\ restarts · lease · reconcile]], name: <mgr>),
  rt((3, 0), [Docker\ #text(size: 6.4pt)[via socket]], name: <dk>),
  rt((1, 1), [fleet: enroll,\ heartbeat, renew], name: <fleet>),
  st((2, 1), [State dir\ #text(size: 6.4pt)[`/var/lib/blocklyd`]], name: <store>),
  rt((3, 1), [ops :7070\ #text(size: 6.4pt)[healthz · readyz · metrics]], name: <ops>),
  edge(<cp>, <api>, "-|>", lbl[workload\ API], label-side: left),
  edge(<api>, <mgr>, "-|>"),
  edge(<mgr>, <dk>, "-|>"),
  edge(<fleet>, <cp>, "--|>", lbl[every 5 s], label-side: left),
  edge(<mgr>, <fleet>, "-|>"),
  edge(<mgr>, <store>, "-|>", lbl[record first,\ then memory], label-side: left),
  edge(<mgr>, <ops>, "-"),
), caption: [blocklyd's parts. #src("blocklyd/src/manager.rs") (3,296 lines) is the core; #src("blocklyd/src/api/mod.rs:460") the routes; #src("blocklyd/src/fleet/heartbeat.rs").], name: "fig-blocklyd")

#figure(
  table(
    columns: (1fr, 1fr),
    table.header[blocklyd owns][blocklyd does not own (and who does)],
    [Containers it made, labelled with its deployment and node; it never touches others.], [Where anything runs: the control plane's placement. It "never chooses where anything runs".],
    [Host ports (42000–42999, quarantined 600 s after release).], [Whether a server should run: only requests and its lease-gated restarts move power.],
    [Data directories, local snapshots, trash, the spool.], [Backup schedules, uploads' retries, retention: FleetRuntime's upkeep.],
    [Its records (`workload.json`, written before memory) and a copy in each container's labels.], [The desired state: Postgres.],
    [Restarting a failed workload (on-failure, 3 tries, backoff 0.5 s doubling to 10 s), only under a lease; resuming after a reboot.], [Declaring a host lost, failover: an operator.],
    [Its identity: its own key; certificates from the control plane's CA.], [Issuing certificates; DNS and routes (the edge); billing; provisioning machines; the firewall.],
    [Enforcing host policy on every spec: image allowlist, non-root user, limits.], [Anything Minecraft: quiescing (`save-off`), RCON, what to exclude from a move are the caller's.],
  ),
  caption: [What blocklyd owns. #src("blocklyd/README.md:15"), #src("blocklyd/src/manager.rs:4").],
  kind: table,
)

- *Protocol.* HTTP/JSON over mutual TLS (TLS 1.3 only, client certificates with `clientAuth`, the
  client's DNS name in an allowlist, no 0-RTT), 19 operations on 16 paths, one error shape, features announced
  instead of versions (@a-protocol). Mutating verbs run detached, so a dropped connection never
  leaves half a change.
- *Every verb is idempotent and checks an epoch rule*: `Exact` to run or copy the current copy,
  `Teardown` to stop or delete any copy, `Place` to create or replace (#src("manager.rs:122")).
- *Startup.* Lock the state dir, check it can give data to the workloads' user (refusing to start
  otherwise, since `105f647`), enroll if needed, reconcile against Docker, then serve and beat.

#why[*Why a daemon at all*, rather than the control plane driving Docker remotely: Docker's API
over TCP is root on the host for whoever holds the credential, and it knows nothing of epochs,
leases or link-proof walks. A small daemon with a narrow protocol is the security boundary and the
place where safety rules (epochs, the lease, the walk) are enforced next to the data. *Why Rust:*
one static binary, about 9 MB resident, nothing to install on a host but a kernel and Docker.]

= One machine, many servers <s-capacity>

How much of a node servers may use, and why "20 servers on a 64 GB machine" is a ceiling, not a
promise. #implemented (the ledger); density #research (never measured).

#let bar(label, total, segments) = grid(
  columns: (27mm, 1fr), column-gutter: 2mm,
  align(right + horizon, text(size: 6.8pt, fill: muted, label)),
  stack(dir: ltr, ..segments.map(s => box(width: s.at(0) / total * 100%, height: 4.6mm,
    fill: s.at(1), stroke: 0.4pt + hairline.darken(25%), inset: (x: 2pt), clip: true,
    align(horizon, text(size: 6.1pt, s.at(2)))))),
)
#fig({
  set block(spacing: 1.4mm)
  bar([memory, 64 GB], 65536, ((2048, tint, []), (58368, runtime-fill, [19 running servers × 3 GB = 57 GB]), (5120, surface, [5 GB free])))
  bar([CPU, 16 threads], 16000, ((1000, tint, []), (14592, runtime-fill, [19 × 768 m = 14.6 threads]), (408, surface, [])))
  bar([placed, ×4], 253952, ((58368, runtime-fill, [19 running]), (195584, control-fill, [up to 63 more placed but asleep: only their disks count])))
  bar([disk], 100, ((2, tint, []), (98, storage-fill, [every placed world's promised size (3–20 GB each) must fit: often the first limit])))
  grid(
    columns: (27mm, 1fr), column-gutter: 2mm, [],
    text(size: 6.1pt, fill: muted)[#box(width: 3mm, height: 2mm, fill: tint,
      stroke: 0.4pt + hairline.darken(25%)) the host's own: 2 GB and 1 core reserved for the
      system and blocklyd, and the 5 GB disk floor blocklyd keeps free],
  )
}, caption: [A 64 GB, 8-core/16-thread node (an OVH RISE-S) with 3 GB servers, at the defaults: host reserve 2 GB and 1 core (blocklyd), 250 m of CPU per GB, placed memory ≤ 4 × allocatable. Memory alone fits 20 running; the CPU ledger stops at 19. #src("apps/control/src/infra/fleet/placement.test.ts:191") checks the same arithmetic: 19 running, 78 asleep on a 60,000 MB node.], name: "fig-capacity")

- *Running memory is never overcommitted.* A JVM with a pre-touched heap (`AlwaysPreTouch`) uses
  what it is given from boot; the node refuses a start past allocatable × `memory_overcommit` (1.0).
  A 3 GB server is a 3 GB container: a 2 GB heap plus about 650 MB the JVM needs outside it, plus
  page cache (#src("apps/control/src/minecraft/runtime-spec.ts:78")).
- *Sleeping servers hold no memory* (running admission): placed servers may total
  `FLEET_MEMORY_OVERCOMMIT` (4) × allocatable, because plans let a server run 3–8% of a month. A
  waking server on a full node moves first. Setting the overcommit to 1 restores the old ledger,
  where every placed server held its memory.
- *CPU is bookkeeping, not a quota.* The ledger counts 250 m per GB, but the control plane sends no
  CPU limit (`cpuMillis` is unset, #src("apps/control/src/infra/fleet/fleet-runtime.ts:223")):
  containers get a CPU *weight* by size, so a busy server can take an idle neighbour's CPU, and
  neighbours share the pain under contention.

#caveat[*Why "20 servers" is not guaranteed.* (1) The host reserve is a default, not a measurement:
2 GB, where kernel, page cache, Docker and local snapshots may take 4–8% of RAM.
(2) A 16-thread box binds on CPU before memory, a box with fewer threads much sooner (64 GB on 8
threads: 9 servers). (3) Disk often fills first: placed worlds keep their promised size. (4)
Minecraft's tick is single-threaded and players, plugins and exploration vary by an order of
magnitude; no density test (MSPT, steal, throttling with many containers) has been run on a
candidate machine. (5) Running admission is statistical: a
busy evening can find the node full and move a waking server.]

= Placement <s-placement>

#block(sticky: true)[Choosing a node: deterministic and pure
(#src("apps/control/src/infra/fleet/placement.ts")), on the ledger, never on what nodes report,
under a Postgres advisory lock per region so two placements can't take the last room.
#implemented]

#fig(draw(
  spacing: (11mm, 9mm),
  cp((0, 0), [Request\ #text(size: 6.4pt)[memory · CPU (250 m/GB)\ disk · 2 ports · region]], name: <req>),
  cp((1, 0), [Filters, in order\ #text(size: 6.4pt)[every node gets a reason]], name: <f>),
  cp((2, 0), [Score\ #text(size: 6.4pt)[`balanced` · `binpack`\ `spread`]], name: <s>),
  cp((3, 0), [Tie: node id\ #text(size: 6.4pt)[reproducible]], name: <t>),
  cp((3, 1), [Decision\ #text(size: 6.4pt)[node, or `RuntimeFull`\ with every reason]], name: <d>),
  cp((1, 1), [Ledger row\ #text(size: 6.4pt)[new epoch, room claimed]], name: <l>),
  edge(<req>, <f>, "-|>"), edge(<f>, <s>, "-|>", lbl[fits], label-side: left), edge(<s>, <t>, "-|>"),
  edge(<t>, <d>, "-|>"), edge(<d>, <l>, "-|>", lbl[in the same transaction], label-side: right),
), caption: [Placement. A refusal reads like `memory: 900 MB free after headroom, needs 3072`.], name: "fig-placement")

#figure(
  table(
    columns: (auto, 1.7fr, 1fr),
    table.header[\#][Filter (the first that fails is the node's reason)][Refusal begins],
    [1], [Not a move's source; the one node an operator named, if any], [`excluded`, `not the node asked for`],
    [2], [Lifecycle `active`; not quarantined; health `healthy`], [`lifecycle …`, `quarantined…`, `health …`],
    [3], [In the server's fleet region; has the protocol features needed], [`region …`, `lacks …`],
    [4], [Memory to run *now*: allocatable − running − `FLEET_HEADROOM_MB` (0)], [`memory: … free after headroom`],
    [5], [Memory to *stay*: allocatable × `FLEET_MEMORY_OVERCOMMIT` (4) − placed], [`memory: … left to place servers in`],
    [6], [CPU now: (threads × 1000 − reserved) × `FLEET_CPU_OVERCOMMIT` (1) − running], [`cpu: …m free`],
    [7], [Disk free above the node's floor; disk not yet promised × `FLEET_DISK_OVERCOMMIT` (1)], [`disk: …`],
    [8], [Host ports], [`ports: …`],
  ),
  caption: [Filters. #src("apps/control/src/infra/fleet/placement.ts:102").],
  kind: table,
)

*Policies* (`FLEET_PLACEMENT`) score what is *placed*, running or not, against what may be placed,
because a placement lasts as long as its world stays while what runs changes by the hour:

- `balanced` (default): best fit on memory among nodes under the CPU pressure line
  (`FLEET_CPU_PRESSURE`, 0.8); past it, the least CPU-pressed node.
- `binpack`: the fullest node that fits. `spread`: the emptiest.

*Not built: cost-aware placement.* Nothing weighs prices: not between nodes, not between runtimes
("no prices, no optimiser", #src("apps/control/src/app/runtimes/placement.ts:10")). The pieces exist
(node prices as labels, per-runtime list prices, the canary's report), and
`docs/runtimes.md` defers price-based placement until the canary has measured real costs. Moving
servers to cheaper nodes over time (rebalancing) is likewise #deferred. Cost-aware placement is not
designed beyond being named as not built.

#why[Placement on the ledger rather than on observations means a burst of placements can't
overcommit a node between two heartbeats, and a decision can be replayed from its inputs. The node
stays the final arbiter: if it refuses a start the ledger allowed (it runs a copy the ledger doesn't
know), the claim is given back and the server moves after all.]
