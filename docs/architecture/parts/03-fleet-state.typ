#import "../style.typ": *

#part("Fleet state and safety", [Who owns which truth, how it converges, how nodes join and are
  watched, and the three mechanisms that keep a server from running twice: epochs, fences and the
  execution lease. Then a server's life, its start, and how sleep differs between runtimes.])

= State ownership <s-ownership>

Every fact has one owner. Others hold copies, and a copy is never the reason anything
happens. #implemented

#figure(
  table(
    columns: (1.25fr, 1.35fr, 1.6fr, 1.5fr),
    table.header[Fact][Owner, and where][Copies][When they disagree],
    [What a server should be: status, plan, size, region, settings, its runtime],
    [Control plane, Postgres: `servers`, `server_runtime`, operations],
    [The runtime's spec of it; the node's workload record],
    [The control plane wins: `drift` re-applies a spec when nobody plays (@s-reconcile).],
    [Which node a fleet server lives on, and its epoch],
    [FleetRuntime, Postgres: `fleet_placements`, `fleet_placement_history`],
    [The node's record (`epoch`, `superseded_by`) and its container labels],
    [The higher epoch wins; an older copy is fenced (@s-epochs). A restored database adopts a newer node epoch for its own placement (`epoch.adopted`).],
    [What exists on a host: containers, ports, data, local snapshots],
    [blocklyd, the node's disk: `/var/lib/blocklyd/workloads/<id>/workload.json`],
    [`fleet_observations` (last report, written on change); Docker labels],
    [The node's report replaces the observation on every heartbeat. Records lost from disk are rebuilt from labels (`record_rebuilt`).],
    [Whether a node is alive],
    [Nobody: health is derived from heartbeat age in database time],
    [`fleet_nodes.last_heartbeat_at`],
    [Health is a reading, not a verdict (@s-health).],
    [Whether a host is gone],
    [The operator, by `lost --fenced-by` (`fleet_nodes.lifecycle`)],
    [—],
    [Never derived from silence. A node that returns while lost is fenced, not trusted.],
    [A world's durable copy],
    [The archive store (S3-compatible), `fleet_archives` or the runtime's snapshots],
    [The node's local snapshot copy],
    [The store's copy is the one a rebuild uses; local copies are trimmed once a newer upload lands.],
    [Who is online],
    [The server itself, read over RCON each minute (`presence-sync`)],
    [`presence` rows],
    [A server that doesn't answer is asked again; empty presence just after a restart means "not read yet" (5 min grace).],
  ),
  caption: [Who owns what. Sources: #src("docs/fleet.md:152"), #src("apps/control/src/infra/fleet/registry.ts"), #src("blocklyd/src/store.rs:1"), #src("apps/control/src/app/operations/schedules.ts:598").],
  kind: table,
)

#why[A control plane that also held "what is on each host" would have to be right about hosts it
can't see. A node that decided what should run would need the whole picture. Splitting desired
(control plane) from existing (node) lets either side rebuild itself from the other: a node from
its own records and Docker's labels, the fleet from Postgres, without a consensus system.]

= Desired state and reconciliation <s-reconcile>

Nothing is reconciled by a single loop. Three owners each converge their own part, on their own
clock. #implemented

#fig(draw(
  spacing: (14mm, 10mm),
  cp((1, 0), [Application\ #text(size: 6.4pt)[servers, operations;\ sweeps every minute]], name: <app>),
  cp((1, 1), [FleetRuntime\ #text(size: 6.4pt)[placements, epochs;\ upkeep every minute]], name: <fr>),
  rt((1, 2.6), [blocklyd\ #text(size: 6.4pt)[records on disk;\ resync every 30 s]], name: <bd>),
  rt((1, 3.6), [Docker], name: <dk>),
  st((0, 0), [Postgres], name: <pg>),
  st((0, 2.6), [Node disk], name: <disk>),
  ..zone((<app>, <fr>, <pg>), [control plane], name: "zcp"),
  ..zone((<bd>, <dk>, <disk>), [a node], name: "znode"),
  edge(<app>, <fr>, "-|>", lbl[ensureProvisioned,\ stop, snapshot], shift: -4pt, label-side: right),
  edge(<fr>, <bd>, "-|>", lbl[PUT, start, fence\ `blocklyd-epoch`], shift: -4pt, label-side: right),
  edge(<bd>, <fr>, "--|>", lbl[heartbeat every 5 s:\ all it holds], shift: -4pt, label-side: right),
  edge(<bd>, <dk>, "-|>", lbl[create, start, stop], shift: -4pt, label-side: right),
  edge(<dk>, <bd>, "--|>", lbl[events; resync], shift: -4pt, label-side: right),
  edge(<app>, <pg>, "-|>"),
  edge(<bd>, <disk>, "-|>"),
), caption: [Three owners, three loops; FleetRuntime keeps its tables in the same Postgres. Solid: calls; dashed: reports. Sweeps: #src("apps/control/src/infra/pg/jobs.ts:266"); blocklyd intervals: #src("blocklyd/src/config.rs:346").], name: "fig-loops", float: true)

- *Application* (worker role, pg-boss singletons, #src("apps/control/src/infra/pg/jobs.ts:266")):
  `reconcile` each minute reads what changed at the provider since the last pass (a full read
  hourly) and marks crashes; `drift` re-applies a spec that changed, five at a time, only while
  nobody plays; `relocations` moves misplaced or lost-host servers, three at a time; `idle-check`
  stops servers idle past their plan; `backup-schedule` hourly at :23.
- *FleetRuntime* `upkeep` each minute (#src("fleet-runtime.ts:1420")), in order: health changes,
  a probe of silent nodes, placements a report settled, placements their node never made undone,
  tidying superseded copies, uploads of local snapshots (four at a time, five tries), deleted
  copies, trimming local copies, and pruning events older than 90 days. Each failure is logged and the next task runs. No loop pushes desired specs
  to nodes: a node is only ever told something by a call the application made through the port.
- *blocklyd*: a Docker event stream plus a full resync every 30 s; disk usage every 300 s; stats
  every 15 s (#src("blocklyd/src/config.rs:354")). Its records are written to disk before
  memory, so a restart rebuilds it in about a second.

#why[Level-triggered loops forgive lost messages: a missed heartbeat or a dropped event is
repaired by the next full pass, and every pass is idempotent. The cost is latency (up to a minute
for most sweeps), which a hosting product with human-scale actions can afford.]

= Enrollment <s-enroll>

How a host becomes a node. #implemented

#fig(sequence({
  import chronos: *
  par-person("op", [Operator])
  par-control("cp", [Control plane\ operator API · node endpoint])
  par-storage("pg", [Postgres])
  par-runtime("bd", [Host: blocklyd])
  _seq("op", "cp", comment: [`fleet.ts token --region eu`])
  _seq("cp", "pg", comment: [sha256 of 32 random bytes; TTL 1 h (≤ 7 d)])
  _seq("cp", "op", comment: [token, shown once], dashed: true)
  _seq("op", "bd", comment: [provision: Docker, binary, config, CA cert, token file])
  _note("right", [makes its own P-256 key; it never leaves the host], pos: "bd")
  _seq("bd", "cp", comment: [`POST /fleet/v1/enroll` {token, CSR, facts}; TLS to the fleet CA])
  _seq("cp", "pg", comment: [token unused and unexpired? mark used; insert node; pin cert sha256])
  _seq("cp", "bd", comment: [node id, server + client certs (30 d), CA, allowed clients], dashed: true)
  _note("right", [writes its identity, deletes the token file], pos: "bd")
  _seq("bd", "cp", comment: [`POST /fleet/v1/nodes/:id/heartbeat` every 5 s (client cert, pinned)])
  _seq("cp", "bd", comment: [workload API as `control-plane.<deployment>.fleet`])
}), caption: [Enrollment. #src("apps/control/src/infra/fleet/node-endpoint.ts:17"), #src("apps/control/src/infra/fleet/registry.ts:168"), #src("blocklyd/src/fleet/enroll.rs:30").], name: "fig-enroll", float: true)

- The control plane names the node (`<node-id>.nodes.<deployment>.fleet`); the CSR's subject is
  ignored. The identity is the certificate, never an address. TLS 1.3 only, both ways.
- Two hosts with the same `/etc/machine-id` hash are recorded (`node.machine_id_reused`): a
  cloned image. Two daemon sessions beating as one node quarantine it (`node.duplicate_identity`).
- Renewal: certificates last `FLEET_NODE_CERT_DAYS` (30). Within `FLEET_RENEW_DAYS` (10) of the
  end, heartbeat answers carry `renew`; the node makes a new key, calls `…/renew` with its current
  certificate, and swaps its files by one rename. The pin moves on the first beat with the new one.
- A node whose identity was lost re-enrolls under its own id with a token bound to it
  (`token --node`), and adopts its own containers (`node.reenrolled`).

- An answer lost on the way (a network drop, or a disk that refused the identity) is asked for
  again: until it is enrolled the node keeps one key on disk, across restarts too, and the control
  plane answers a spent token again, before its expiry, for the key that spent it
  (`node.enrollment_repeated`, #src("blocklyd/src/fleet/enroll.rs:8"),
  #src("apps/control/src/infra/fleet/registry.ts:284")). Any other use of a spent token is refused.

#caveat[A node that lost that key before its answer arrived (its state directory wiped) cannot
prove it is the one the token enrolled: an operator mints a new token, and the half-made node is
retired by hand. Nothing is compromised.]

= Heartbeats and node health <s-health>

Every 5 seconds (`heartbeat_seconds`, #src("blocklyd/src/config.rs:119")) a node sends
everything it holds: capacity, every workload's state and epoch, issues, addresses. The answer
carries its lifecycle, fences, the lease, and `renew` when due (#src("apps/control/src/infra/fleet/wire.ts:234")).
A node that was cut off, restarted or rebooted resynchronises on its first beat. #implemented

#fig(grid(
  columns: (1fr, 1fr), column-gutter: 4mm,
  draw(
    spacing: (9mm, 8mm),
    node((0, 0), text(size: 6.6pt, weight: "semibold")[Health: derived, never stored], stroke: none),
    cp((0, 1), [healthy], name: <h>),
    cp((1, 1), [degraded], name: <d>),
    cp((0, 2), [suspect], name: <s>),
    cp((0, 3), [unavailable], name: <u>),
    edge(<h>, <d>, "-|>", lbl[Docker down,\ not reconciled], shift: 2pt),
    edge(<d>, <h>, "-|>", shift: 2pt),
    edge(<h>, <s>, "-|>", lbl[silent > 15 s]),
    edge(<s>, <u>, "-|>", lbl[silent > 45 s]),
    edge(<u>, <h>, "--|>", bend: -50deg, lbl[a beat]),
  ),
  draw(
    spacing: (9mm, 8mm),
    node((0.7, 0), text(size: 6.6pt, weight: "semibold")[Lifecycle: an operator's statement], stroke: none),
    cp((0, 1), [active], name: <a>),
    cp((1.4, 1), [draining], name: <dr>),
    cp((0, 2.4), [lost], name: <l>),
    cp((1.4, 2.4), [retired], name: <r>),
    edge(<a>, <dr>, "-|>", lbl[drain], shift: 2pt),
    edge(<dr>, <a>, "-|>", lbl[undrain], shift: 2pt, label-side: left),
    edge(<a>, <l>, "-|>", lbl[lost `--fenced-by`\ (or from draining)], shift: 2pt, label-side: right),
    edge(<l>, <a>, "-|>", lbl[reinstate], shift: 2pt, label-side: right),
    edge(<dr>, <r>, "-|>", lbl[retire,\ once empty]),
    edge(<l>, <r>, "-|>", lbl[retire]),
  ),
), caption: [Health and lifecycle are separate. Thresholds: #src("apps/control/src/infra/fleet/health.ts:17") (`FLEET_SUSPECT_SECONDS`, `FLEET_UNAVAILABLE_SECONDS`); lifecycle actions: #src("apps/control/src/infra/fleet/operator-api.ts:116").], name: "fig-health")

#figure(
  table(
    columns: (auto, 1fr, 1fr),
    table.header[Health][What it means][What happens automatically],
    [healthy], [Beat within 15 s; Docker answers; reconciled since.], [Eligible for placement.],
    [degraded], [Beating, but Docker doesn't answer or the node hasn't reconciled since.], [No new placements. Servers keep running.],
    [suspect], [Silent 15–45 s, or longer while the endpoint itself has been up less than 45 s.], [No new placements. Its last report is kept, so a missed beat doesn't flap a server's state.],
    [unavailable], [Silent over 45 s, or never beat.], [Its servers read `unknown`. *Nothing moves and nothing restarts elsewhere.*],
  ),
  caption: [What each health means. #src("apps/control/src/infra/fleet/health.ts:32").],
  kind: table,
)

#why[*Unavailable is not dead.* Silence is a fact about the network between two machines, not about
the host. A partitioned node keeps serving its players (@s-split-brain); rebuilding its servers elsewhere on a
timer would run two copies and fork worlds. So `lost` is never derived: an operator declares it
after fencing the host. `confirmLost` refuses only while the node still beats (healthy or
degraded) unless forced, so it is allowed from 15 s of silence on
(#src("apps/control/src/infra/fleet/registry.ts:860")): the operator, not a timer, carries the
judgement. The endpoint's own uptime counts too: heartbeats sent while nothing listened aren't the
nodes' fault (`fleet_endpoints`).]

= Epochs and fencing <s-epochs>

Every new home of a server gets a *placement epoch*: a number that rises in the transaction that
changes the placement and is never reused (`nextEpoch`, #src("fleet-runtime.ts:561")). Every
mutating request to a node carries it in `blocklyd-epoch`. #implemented

- A node refuses a request older than the copy it holds (`stale_epoch`), refuses to run a copy for
  another epoch, and refuses everything but teardown on a copy a newer epoch superseded.
- *A fence* says "this workload is at epoch N". The node marks an older copy `superseded_by N`,
  switches off its restarts, stops it, keeps its data. Late or repeated fences change nothing.
  Fences arrive in every heartbeat answer and, during a move, directly (`POST …/fence`).
- A superseded copy is never started again, by anyone, even after a reboot. Since `eacb334` the
  mark is held in memory first, so a disk that refuses the record (full, read-only) still stops
  the copy and keeps it from resuming; the failed write is reported.

#fig(draw(
  spacing: (10mm, 9mm),
  cp((1, 0), [Placement row: epoch 7 → 8\ #text(size: 6.4pt)[in one transaction; never reused]], name: <p>),
  rt((0, 1.2), [Node A: copy \@7\ #text(size: 6.4pt)[superseded_by 8: stopped, restarts off,\ data kept, never runs again]], name: <a>),
  rt((2, 1.2), [Node B: copy \@8\ #text(size: 6.4pt)[runs; a request at epoch 7\ is refused here]], name: <b>),
  ext((0, 2.4), [Physical fence\ #text(size: 6.4pt)[power-off, rescue boot,\ network removed]], name: <phys>),
  edge(<p>, <b>, "-|>", lbl[PUT, restore, start\ `blocklyd-epoch: 8`]),
  edge(<p>, <a>, "--|>", lbl[fence 8: in the move,\ then in every heartbeat answer], label-side: right),
  edge(<phys>, <a>, "..|>", lbl[an operator, before `lost`], label-side: right),
), caption: [Logical fencing needs the node to hear the fence; physical fencing doesn't. An operator does the second before declaring a host lost.], name: "fig-epochs")

#figure(
  table(
    columns: (auto, 1fr, 1fr),
    table.header[][Logical fence (epochs)][Physical fence (operator)],
    [What], [The node refuses old epochs and stops superseded copies.], [The host stops: powered off in the provider's console, rescue boot, network removed.],
    [Needs], [The node to be reachable, or to hear its next heartbeat answer.], [Nothing from the node.],
    [Protects against], [A stale request, a late retry, a returning node, a restored database.], [A partitioned node still serving its players.],
    [Status], [#implemented], [#implemented as a required statement (`--fenced-by`); no provider API does it (#deferred).],
  ),
  caption: [Two kinds of fence. #src("docs/fleet.md:209").],
  kind: table,
)

- *A copy of no placement at all* (its server was destroyed while its node was unreachable, or the
  database was restored from before it existed) is fenced one epoch past its own and reported
  (`copy.orphaned`). The application's hourly `orphans` sweep destroys a copy whose server was
  purged (its data goes to the node's trash for 24 hours); one whose server the database doesn't
  know is kept and logged each time it is seen, for an operator, since after a restored database
  that is every server made since (#src("apps/control/src/app/operations/schedules.ts:808")).
- *A restored database* behind a node: the node's newer epoch is adopted for its own placement
  (`epoch.adopted`) and flagged for any other (`epoch.conflict`).

#why[Epochs make the safety property local: a node can decide alone whether a request is
current, with no clock and no quorum. That is what lets the fleet have no consensus store. What
epochs can't do is reach a node that can't be reached, hence the operator's physical fence.]

= Execution leases <s-lease>

blocklyd is the restart authority on its host; Docker's restart policy is always `no`
(#src("blocklyd/src/manager.rs:762")). It restarts a workload that failed, per the spec's
policy (`on-failure`, 3 tries with backoff), and resumes after a host reboot what was running,
*only while it holds an execution lease*. #implemented

#let lane(label, segments) = grid(
  columns: (26mm, 1fr), column-gutter: 2mm,
  align(right + horizon, text(size: 6.8pt, fill: muted, label)),
  stack(dir: ltr, ..segments.map(s => box(width: s.at(0), height: 4.2mm, fill: s.at(1),
    stroke: 0.4pt + hairline.darken(20%), inset: (x: 2pt), align(horizon, text(size: 6.2pt, s.at(2)))))),
)
#fig({
  set block(spacing: 1.2mm)
  lane([heartbeat answers], ((22%, control-fill, [every 5 s, each grants 120 s]), (78%, surface, [partition: no answers])))
  lane([lease], ((22%, runtime-fill, []), (40%, runtime-fill, [120 s from the last beat sent]), (38%, tint, [lapsed: lease 0])))
  lane([restart a crash], ((62%, runtime-fill, [allowed (policy, 3 tries)]), (38%, surface, [withheld: it may have been replaced])))
  lane([resume after reboot], ((62%, runtime-fill, [allowed, fences applied first]), (38%, surface, [withheld])))
  lane([running servers], ((100%, runtime-fill, [keep running throughout: the lease never stops anything]),))
  lane([commands], ((100%, control-fill, [carry their own authority (the epoch); need no lease]),))
}, caption: [A partition starts after the fourth answer. Lease measured on `CLOCK_BOOTTIME` from when the beat was *sent*, so a paused VM or a slow answer can't stretch it. #src("blocklyd/src/manager.rs:2513"), #src("apps/control/src/config/load.ts:91").], name: "fig-lease")

- The answer grants `FLEET_LEASE_SECONDS` (120); a node held `lost` gets 0. Without an answer
  naming one, `restart_requires_contact_seconds` (120) applies.
- The heartbeat that grants a lease applies its fences first, so a server rebuilt elsewhere during
  an outage never resumes here.
- A restart of blocklyd alone (same boot id) resumes nothing: what died while it was down is
  reported, not restarted.

#why[A node that hasn't heard from the control plane for a lease may already have been replaced:
restarting its copy could fork a world. But stopping running servers when the lease lapses would
turn every control-plane outage into a fleet-wide one. So the lease withholds only what the node
would do unasked. The consequence is @s-split-brain's split-brain window.]

= Workload lifecycle <s-lifecycle>

Two state machines, one per owner. The application's is the product's (what the owner sees);
blocklyd's is the host's (what the container is doing). #implemented

#fig(draw(
  spacing: (14mm, 9mm),
  cp((0, 0), [provisioning], name: <pv>),
  cp((2, 0), [running], name: <ru>),
  cp((0.6, 1), [starting], name: <st>),
  cp((3, 1), [stopping], name: <sp>),
  cp((2, 2), [stopped], name: <so>),
  cp((3, 2), [storing], name: <sg>),
  cp((4, 2), [stored], name: <sd>),
  cp((4, 0), [updating · restoring\ relocating\ #text(size: 6.4pt)[then running or stopped]], name: <ch>),
  edge(<pv>, <ru>, "-|>", lbl[provisioned], label-side: left),
  edge(<st>, <ru>, "-|>", lbl[started], label-side: left),
  edge(<ru>, <sp>, "-|>", lbl[stop · idle\ · restart], label-side: left),
  edge(<sp>, <so>, "-|>", lbl[stopped], label-side: left),
  edge(<so>, <st>, "-|>", lbl[start · join], label-side: left, shift: 2.5pt),
  edge(<st>, <so>, "-|>", lbl[no room:\ back to sleep], label-side: left, shift: 2.5pt),
  edge(<ru>, <so>, "-|>", lbl[crashed], label-side: left, label-pos: 0.4),
  edge(<ru>, <ch>, "-|>", lbl[apply · restore · relocate], label-side: left, label-pos: 0.6, shift: 2.5pt),
  edge(<ch>, <ru>, "-|>", shift: 2.5pt),
  edge(<so>, <sg>, "-|>", lbl[unplayed\ for days], label-side: right),
  edge(<sg>, <sd>, "-|>"),
  edge(<sd>, <ch>, "-|>", lbl[start · join:\ unstore], label-side: right),
), caption: [The server's lifecycle, simplified (#src("apps/control/src/domain/server/lifecycle.ts:212")). Not
  drawn: any phase can end in `failed`, and `retry` resumes the phase it failed in; a restart's stop
  half goes from `stopping` back to `starting`; `deleted`, then `purged`. A start that
  finds no room puts the server back to sleep (`refused`, idle) instead of failing
  (#src("apps/control/src/app/operations/handlers.ts:435")).], name: "fig-server-lifecycle")

#fig(draw(
  spacing: (15mm, 9mm),
  rt((0, 0), [creating], name: <c>),
  rt((1, 0), [created], name: <cd>),
  rt((2, 0), [running], name: <r>),
  rt((3, 0), [stopping], name: <s>),
  rt((4, 0), [stopped], name: <sd>),
  rt((2, 1), [crashed], name: <cr>),
  rt((1, 1), [restarting], name: <rs>),
  rt((3, 1), [fenced], name: <f>),
  rt((4, 1), [retained], name: <rt>),
  rt((0, 1), [missing · unknown], name: <m>),
  edge(<c>, <cd>, "-|>"),
  edge(<cd>, <r>, "-|>", lbl[start], label-side: left),
  edge(<r>, <s>, "-|>", lbl[stop], label-side: left),
  edge(<s>, <sd>, "-|>"),
  edge(<r>, <cr>, "-|>", lbl[exit ≠ 0\ or OOM], label-side: left, label-pos: 0.62),
  edge(<cr>, <rs>, "-|>", lbl[lease held,\ tries left], label-side: left),
  edge(<rs>, <r>, "-|>"),
  edge(<r>, <f>, "-|>", lbl[fence], label-side: left, label-pos: 0.62),
  edge(<sd>, <rt>, "-|>", lbl[delete,\ data kept], label-side: left),
  edge(<sd>, <r>, "-|>", bend: -40deg, lbl[start], label-side: right),
), caption: [A workload on a node (`WorkloadState`, #src("blocklyd/src/protocol.rs:495")), derived
  from blocklyd's record and Docker's view (#src("blocklyd/src/manager.rs:3217")). A superseded
  copy at rest reads `fenced`; a stopped or crashed copy waiting to resume after a reboot reads
  `restarting`; `missing`: the container vanished; `unknown`: Docker doesn't answer.], name: "fig-workload-lifecycle")

= The startup path <s-startup>

What happens between a press of Start (or a player joining a sleeping server) and a playable
world, on the fleet. Other runtimes follow the same application path and differ inside
`ensureProvisioned` (@s-sleep). #implemented for the fleet half.

#fig(sequence({
  import chronos: *
  par-person("u", [Owner\ or player])
  par-control("api", [API + operations\ worker])
  par-control("rr", [RuntimeRouter])
  par-control("fr", [FleetRuntime])
  par-runtime("bd", [blocklyd])
  par-runtime("dk", [Docker])
  _seq("u", "api", comment: [Start (or a join on the edge wakes it)])
  _note("right", [command → `starting`; enqueue `start`], pos: "api")
  _seq("api", "rr", comment: [`ensureProvisioned(provider, key, placement, spec)`])
  _seq("rr", "fr", comment: [the server's runtime, by its handle])
  _note("right", [region lock; `#claim`: room to run now?\ none → move first (`moved_for_room`) or RuntimeFull], pos: "fr")
  _seq("fr", "bd", comment: [`PUT /v1/workloads/:id` spec, epoch])
  _seq("bd", "dk", comment: [create container (hardened)])
  _seq("fr", "bd", comment: [`POST …/start`, epoch])
  _seq("bd", "dk", comment: [start])
  _seq("fr", "rr", comment: [handle: node, epoch, ports], dashed: true)
  _seq("api", "bd", comment: [boot: wait until running and ready (`waitRunning`, logs)])
  _note("right", [`started`: run interval opens\ (woken runs on probation)], pos: "api")
  _seq("api", "u", comment: [running; the edge routes the hostname to node:port], dashed: true)
}), caption: [Startup on the fleet. #src("apps/control/src/app/operations/handlers.ts:291") (bringUp), #src("apps/control/src/infra/fleet/fleet-runtime.ts:527") (ensureProvisioned).], name: "fig-startup", float: true)

Where it can go wrong, and what the owner sees:

- *No room on the node:* the sleeping server moves first to a node in its region with room
  (its world through the archive store), then starts (`placement.moved_for_room`). No room
  anywhere, or a world too big to copy: `RuntimeFull`, and the server goes back to sleep with a
  plain-words reason.
- *Never started before, and its runtime is full:* a server a rule sent to this runtime falls back
  once to the default runtime, and it is recorded (#src("handlers.ts:278")); on the default, it
  waits for room. #canary for the fleet.
- *The node refuses a start the ledger allowed* (it runs a copy the ledger doesn't know): the
  claim is given back and the server moves after all.
- *A pack that learns on first boot* starts again on what it learned (`boot.run`).

= Sleep and wake on Boat, Fly and the fleet <s-sleep>

"Asleep" means the same thing to the owner everywhere: stopped, world kept, a join wakes it. What
it costs, and what is kept, differs per runtime. Details of each runtime are in @s-providers–@s-direct-hosts.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr),
    table.header[][Fly][Boat][Fleet],
    [Asleep, it keeps], [Its stopped Machine, volume, app and Flycast address], [Boat's own snapshot of the sandbox's disk; no compute, no address], [Its world on the node's disk, its node address and host ports; no memory claim],
    [Waking needs], [The Machine to start on its host], [A Boat start from the plan's quota (per minute, hour and day), then a new machine], [Room on its node; else a move to a node in the region with room],
    [Address after wake], [The same (`stableEndpoints`)], [A new IPv6 each run; the edge routes to `0.0.0.0:0` while asleep], [The same while placed],
    [No room], [A host with no room is `RuntimeFull` → back to sleep; Fly never starts it elsewhere], [`RuntimeFull` when starts are spent → back to sleep], [`RuntimeFull` after every node → back to sleep],
    [Wake time], [Not measured by Blockly], [About 34 s from join to running, measured on a trial account; the edge waits 25 s, so a first join sees "starting"], [Only prototype numbers, on one VM (#research)],
    [Cost asleep], [Volume, 15¢ per GB-month, and the stopped root filesystem], [None while archived], [The node's, which is paid for whether servers run or not],
  ),
  caption: [Sleep and wake per runtime. #src("apps/control/src/infra/fly/fly-runtime.ts:397"), #src("apps/control/src/infra/boat/boat-runtime.ts:43"), #src("apps/control/src/infra/fleet/fleet-runtime.ts:1792").],
  kind: table,
)

#why[The application decides *when* a server sleeps (idle past its plan, a woken run nobody joined
within five minutes, #src("schedules.ts:776")) and the runtime decides *what sleeping keeps*. That
split is what lets a fleet server give back its memory while a Fly server keeps its Machine.]
