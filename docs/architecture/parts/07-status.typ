#import "../style.typ": *

#part("Status", [What exists, what does not, and what comes next.])

= Status <s-status>

Every capability, its status, and where it lives. Nothing below has served paying players yet.

// Its rows a little closer than other tables', so the whole list fits on the part's first page.
#[
#set table(inset: (x: 4.5pt, y: 3pt))
#figure(
  table(
    columns: (1.6fr, auto, 2fr),
    table.header[Capability][Status][Evidence and notes],
    table.cell(colspan: 3, text(weight: "semibold")[Product and control plane]),
    [Servers, worlds, settings, revisions, rollback], [#implemented], [`apps/control/src/domain`, `app/servers`, `app/revisions`.],
    [Operations queue, per-server FIFO, retries], [#implemented], [`infra/pg/jobs.ts`, `app/operations/runner.ts`.],
    [Sleep on idle, wake on join, wake probation and quota], [#implemented], [`schedules.ts:649`, `app/edge/service.ts:93`.],
    [Resting worlds (store, unstore)], [#implemented], [Free after 14 idle days, Plus after 30.],
    [Backups: daily snapshots, weekly archives, downloads], [#implemented], [`backup-schedule`, `handlers.ts:737`.],
    [Plans, included hours, Polar billing], [#implemented], [`entitlements.ts`, `app/billing`.],
    [Paid extra hours], [#deferred], [`mayBuyMore` false on every plan until metering is end to end.],
    [Edge: routing, notices, wake], [#implemented], [`apps/edge`.],
    [Edge relay closing stale connections], [#designed], [`docs/fleet.md:426`.],
    table.cell(colspan: 3, text(weight: "semibold")[Runtimes]),
    [The runtime port], [#implemented], [`app/ports/runtime.ts`.],
    [Fly runtime], [#implemented], [The runtime staging runs and production configures.],
    [Boat runtime], [#implemented], [Configured nowhere; ready for an internal canary.],
    [Docker runtime], [#implemented], [Local development.],
    [Several runtimes in one deployment], [#implemented], [Configured nowhere.],
    [Placement rules (the canary), overflow, first-start fallback], [#implemented], [No rules exist.],
    [Moves between runtimes through archives], [#implemented], [Operator-only.],
    [Archives larger than one PUT, in parts], [#implemented], [Every runtime; tested against RustFS, never against R2.],
    [Canary report], [#implemented], [Bandwidth and per-server CPU unmeasured.],
    [Moving a waking server to the cloud when the fleet is full], [#designed], [The "hybrid"; not built.],
    [Cost-aware placement, rebalancing], [#deferred], [Until the canary measures real costs.],
    table.cell(colspan: 3, text(weight: "semibold")[Fleet]),
    [blocklyd 0.2: protocol, hardening, epochs, lease, resume, renewal], [#implemented], [142 Rust tests, and 8 more against a real Docker.],
    [Enrollment, heartbeats, health, quarantine], [#implemented], [`registry.ts`, `node-endpoint.ts`.],
    [Placement policies, running admission, moves for room], [#implemented], [`placement.ts`.],
    [Snapshots (local then uploaded), moves, rebuilds, drain], [#implemented], [One-node e2e in CI; two-node e2e local only.],
    [Fleet in any environment], [#canary], [Never configured; never run on independent machines.],
    [Private network from Fly to nodes], [#research], [Open spike; nothing built.],
    [Host provisioning from provider APIs], [#deferred], [Hosts are provisioned by hand or cloud-init.],
    [Provider power fencing; automatic failover], [#deferred], [The operator is the fence (@s-split-brain).],
    [Fleet alerts], [#designed], [A watch list in the runbook only.],
    [Reflink snapshots on a real reflink disk], [#implemented], [Never measured: the test kernel had ext4 only.],
    [ZFS], [#research], [Not adopted.],
    [gVisor, Kata or Firecracker isolation], [#designed], [`docs/fleet.md:453`.],
    [Disk quotas per world], [#deferred], [Measured, not enforced.],
  ),
  caption: [Status of everything this document describes.],
  kind: table,
)
]

= Current limitations <s-limits>

What is true today and matters before relying on the parts it touches. Each is either stated in
the code's own documents or found while writing this one.

*Product-wide*

- No production traffic has been measured, so every utilization, density and cost figure is a
  scenario.
- Nothing pages anyone: there is no metrics pipeline in the control plane and no fleet alerting.
- The realtime app holds every control-plane secret; the control API is public on `fly.dev`;
  operators share one token with self-declared names.

*Runtimes*

- Fly never starts a server on another host: one whose host is full waits for room there.
- Boat: the edge waits 25 s, Boat wakes in about 34 s; game ports are public.

*Fleet and blocklyd*

- Never run on independent machines; the network path from Fly to nodes is not built.
- Split brain is prevented only by the operator's physical fence; stale connections survive a
  route change.
- No CPU ceiling for fleet servers; density never measured; the host reserve is a default, not a
  measurement.
- Snapshot uploads are full archives every time. One larger than a PUT carries (5 GiB less
  5 MiB) goes in parts, sent one after another; an upload in parts cut short by a crash begins
  again rather than resuming, and the store drops the parts left behind (R2 after 7 days).
- A move that fails partway (an export, upload or restore error, not a refusal) leaves the server
  stopped and `failed` until its owner tries again.
- Node-side certificate renewal, resume after a real reboot, and reflink snapshots have no test on
  a real host (renewal has one through the real heartbeat loop, in process).

= Roadmap <s-roadmap>

Only what the repository's own documents already propose, in their order. Nothing here is
committed to.

+ *Before any player uses the fleet*: run
  two independent hosts on a real private network; a real reboot, an upgrade and a certificate
  renewal on a real host; a density test on the candidate CPU; build the network path from the edge
  and control plane to nodes.
+ *Keep Fly the default.*
+ *Boat for servers in Europe* once a daily wake cap exists, with the edge's wake wait above ~35 s.
+ *A small EU fleet canary*: two nodes, named servers, then an allowlist; a month of measurement;
  expand only if it beats what it replaced per played hour with no data lost.
+ *Count edge bytes*: bandwidth is the one cost nothing measures.
+ *Incremental fleet backups*: today every snapshot upload is a full archive.
+ *Later, only if the canary holds*: start-time moves to the cloud when the fleet is full (the
  hybrid), the edge relay and a real fence, then automatic failover.
