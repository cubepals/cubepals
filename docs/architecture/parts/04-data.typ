#import "../style.typ": *

#part("Data", [Where worlds live, how they are backed up and restored, and how they move: between
  nodes, off a draining node, away from a lost one. Then the one failure the design does not
  prevent by itself.])

= The storage model <s-storage>

A world has one *hot* copy, where its server runs, and *durable* copies that outlive the machine.
Nothing in Blockly shares a hot copy between machines: no distributed filesystem, no network block
device for worlds. #implemented

#fig(draw(
  spacing: (11mm, 9mm),
  rt((0, 0), [Server's container], name: <c>),
  st((0, 1.15), [Hot copy\ #text(size: 6.4pt)[node disk · Fly volume · Boat]], name: <hot>),
  st((1.5, 1.15), [Local snapshot\ #text(size: 6.4pt)[fleet: beside the data]], name: <local>),
  st((3, 1.15), [Archive store\ #text(size: 6.4pt)[S3-compatible]], name: <store>),
  cp((3, 0), [Backups, archives,\ resting worlds], name: <rows>),
  edge(<c>, <hot>, "<|-|>", lbl[bind mount,\ local latency]),
  edge(<hot>, <local>, "-|>", lbl[FICLONE\ or copy]),
  edge(<local>, <store>, "--|>", lbl[upload in\ background]),
  edge(<hot>, <store>, "--|>", bend: -32deg, lbl[runtime snapshots, exports, moves, `store`]),
  edge(<rows>, <store>, "-", stroke: (dash: "dotted")),
), caption: [Hot and durable copies. The local snapshot tier exists only on the fleet; other runtimes snapshot with their provider (@s-providers).], name: "fig-storage")

#figure(
  table(
    columns: (auto, 1.35fr, 1.1fr, 0.75fr),
    table.header[Tier][What][Why][Status],
    [Hot, fleet], [`/var/lib/blocklyd/workloads/<id>/data` on the node's own disk, bind-mounted, owned by the workloads' uid (1000:1000).], [Minecraft's region saves are fsync-heavy and latency-bound; provider block volumes have millisecond fsync.], [#implemented],
    [Local snapshot], [`snapshots/<id>/data` beside it, never mounted. `FICLONE` per file where the filesystem shares blocks (XFS reflink, btrfs), else a full copy.], [A backup costs the player seconds; restoring on the same node needs no download.], [#implemented; reflink path not run on a real reflink disk],
    [Archive store], [Gzip tarballs (`./`-relative paths, fastest level). Every archive's sha256 is recorded as it is written (the fleet's own copies, and the application's `backups` since migration 0044), and a node checks it as it downloads. Presigned URLs (30 min); nodes hold no credentials. One PUT carries at most 5 GiB less 5 MiB; a larger archive goes as a multipart upload, a presigned URL for each part.], [Survives the machine; one format every runtime reads and writes.], [#implemented; parts],
    [Resting worlds], [A server unplayed for its plan's `storeAfterIdleDays` (Free 14, Plus 30) is `stored`: its world in the archive store, no compute, no disk.], [Idle worlds cost object storage, not disks. A join or start brings it back.], [#implemented],
    [ZFS], [`zfs snapshot` and `zfs send` streams, evaluated.], [Needs an out-of-tree kernel module on every node; nothing could be measured honestly in the test environment.], [#research],
  ),
  caption: [Storage tiers. #src("apps/blocklyd/src/store.rs:3"), #src("apps/blocklyd/src/tree.rs:330"), #src("apps/blocklyd/src/transfer.rs:95"), #src("apps/control/src/domain/account/entitlements.ts:150").],
  kind: table,
)

- *The disk floor.* blocklyd keeps `min_free_disk_mb` (5 GB) free: a create, an export's spool,
  a snapshot and a restore are refused below it with `507 insufficient_disk`. A restore from a
  URL is refused too when the size its download announces wouldn't fit above the floor, and is
  stopped if the floor is reached while it downloads or unpacks
  (#src("apps/blocklyd/src/manager.rs:1532")). Placement admits disk for the world when it places
  the server (@s-placement), which covers the normal case.
- *A world's size is measured, not enforced.* `storage.sizeGb` is checked against usage and
  reported as an issue (`over_storage`); there is no quota on the node (#deferred).
- *Trash.* Deleted data and data a restore replaced go to `trash/` for 24 hours, so a restore can be
  undone by hand; it is purged hourly.

#why[Worlds on local disks make a node's loss a data question: what was played since the last
uploaded snapshot is on that host only (@s-node-loss). The alternative,
network storage, would make every save as slow as the network and every node depend on a storage
cluster. For servers that sleep most of the day, a two-tier model (fast local disk, durable object
store) costs least and fails in the most understandable way.]

= The backup pipeline <s-backup>

Backups are the application's; runtimes only take and keep snapshots. #implemented, with the
fleet's two-step snapshot.

#fig(draw(
  spacing: (24mm, 10mm),
  cp((0, 0), [`backup-schedule`\ #text(size: 6.4pt)[hourly at :23]], name: <sched>),
  cp((1, 0), [`backup` op\ #text(size: 6.4pt)[worker]], name: <op>),
  rt((2, 0), [Server\ #text(size: 6.4pt)[RCON]], name: <mc>),
  cp((0, 1), [`backups` row\ #text(size: 6.4pt)[retention by plan]], name: <row>),
  cp((1, 1), [`runtime.snapshot`\ #text(size: 6.4pt)[FleetRuntime]], name: <snap>),
  rt((2, 1), [blocklyd], name: <bd>),
  st((1, 2), [Archive store], name: <store>),
  st((2, 2), [Local copy], name: <local>),
  edge(<sched>, <op>, "-|>", lbl[played since\ last one?], label-side: left),
  edge(<op>, <mc>, "-|>", lbl[`save-off`,\ `save-all flush`], label-side: left),
  edge(<op>, <snap>, "-|>"),
  edge(<snap>, <bd>, "-|>", lbl[`POST …/snapshots`\ epoch, quiesced], label-side: left),
  edge(<snap>, <row>, "-|>", lbl[handle, size], label-side: right),
  edge(<bd>, <local>, "-|>", lbl[FICLONE\ or copy], label-side: left),
  edge(<local>, <store>, "--|>", lbl[upkeep: upload,\ 4 at a time, 5 tries], label-side: left),
), caption: [A scheduled backup on the fleet. `save-on` follows whatever happens. #src("apps/control/src/app/operations/handlers.ts:221") (capture), #src("apps/control/src/infra/fleet/fleet-runtime.ts:682") (snapshot), #src("fleet-runtime.ts:747") (upload).], name: "fig-backup")

1. *Schedule.* `backup-schedule` runs hourly at :23 (#src("apps/control/src/infra/pg/jobs.ts:287"))
   and queues a daily snapshot of every server played on since its last scheduled one; a server
   nobody played keeps its last backup. Plus also gets a weekly archive.
2. *Quiesce.* For a running server the worker pauses saving over RCON (`save-off`,
   `save-all flush`) and resumes it (`save-on`) afterwards, whatever happens. A stopped server saved
   as it stopped.
3. *Snapshot.* The runtime takes it. On the fleet, `fleet_archives` gets a row (`creating`), the
   node copies the data beside it (`local`), and the handle is issued at once: a restore on the
   same node can use the local copy immediately.
4. *Upload.* In the background, and by `runtime-upkeep` each minute until it succeeds:
   `POST …/snapshots/<id>/upload` to a presigned PUT, or in parts when it is larger than one
   carries, the size checked against the store's own (`uploading` → `ready`, `snapshot.uploaded`).
   A node packs a snapshot for one upload at a time: an export asked meanwhile waits its turn. Once a newer snapshot of the same server is
   uploaded, older local copies are dropped (`snapshot.local_trimmed`).
5. *Retention.* Plans keep `snapshotsKept` daily snapshots (Free 3, Plus 14); weekly archives (Plus)
   are kept 30 days; downloads are made on request (Free one a day, kept 7 days)
   (#src("apps/control/src/domain/account/entitlements.ts:143")).

#caveat[Until a snapshot's upload finishes, its only copy is on the node it describes. A node lost
in that window loses that backup; a rebuild then uses the newest snapshot that did reach the store
(`recover.older_copy`). Uploads are full archives every time: at 1,000 servers the report estimates
about \$152 a month, against about \$13 for incremental ones (#designed). A world whose archive is
over one PUT's limit (5 GiB less 5 MiB) goes in parts: the control plane begins an S3 multipart
upload sized for it and presigns a URL for each part, the runtime sends the parts and reports their
ETags, and the control plane completes the upload, or aborts it when anything failed
(#src("apps/control/src/infra/s3/s3-archive-store.ts:256"),
#src("apps/blocklyd/src/manager.rs:3038")). Only a fleet node without the
`multipart-upload` feature still refuses such an archive before sending anything
(`archive_too_large`, #src("apps/blocklyd/src/manager.rs:3021")): its snapshots stay on its node,
and it can't rest or move to another node.]

= The restore pipeline <s-restore>

// Kept with its figure, so the heading never ends a page alone.
#block(sticky: true)[Restoring replaces a stopped server's world with a backup's. #implemented]

#fig(draw(
  spacing: (15mm, 9mm),
  cp((0, 1), [`restore` op\ #text(size: 6.4pt)[server `restoring`:\ no route reaches it]], name: <op>),
  cp((1, 1), [FleetRuntime\ `restore`], name: <fr>),
  rt((2, 1), [blocklyd\ `POST …/restore`], name: <bd>),
  st((2, 0), [Local snapshot\ #text(size: 6.4pt)[on the same node]], name: <ls>),
  st((3, 1), [Archive store], name: <as>),
  st((2, 2), [`data.restoring/`], name: <tmp>),
  st((3, 2), [`data/`], name: <data>),
  st((4, 2), [trash], name: <trash>),
  edge(<op>, <fr>, "-|>", lbl[source], label-side: left),
  edge(<fr>, <bd>, "-|>", lbl[new epoch\ (in place)], label-side: left),
  edge(<ls>, <bd>, "--|>"),
  edge(<as>, <bd>, "--|>", lbl[presigned\ GET, sha256\ if known], label-side: right),
  edge(<bd>, <tmp>, "-|>", lbl[unpack: files and\ dirs only, ≤ 256 GiB], label-side: right),
  edge(<tmp>, <data>, "-|>", lbl[one exchange], label-side: right),
  edge(<data>, <trash>, "-|>", lbl[old data,\ after], label-side: left),
), caption: [A restore. The new data is assembled beside the old, so a bad archive costs nothing. #src("apps/blocklyd/src/manager.rs:1426"), #src("apps/blocklyd/src/transfer.rs:161"), #src("apps/control/src/infra/fleet/fleet-runtime.ts:980").], name: "fig-restore")

- *Sources.* A backup's snapshot handle when its runtime still holds it; else the archive store
  through a link made just before use (#src("handlers.ts:869")). On the fleet a snapshot is read
  from the node's local copy when the server is still on that node, else from the store, with its
  recorded sha256. An application archive (a download, the copy a world rests in, a move between
  runtimes) carries the one recorded when it was written; an uploaded world, and an archive made
  before migration 0044, carry none.
- *Unpacking is hostile-input safe.* Only regular files and directories; an absolute path or `..`
  refuses the whole archive; modes masked to `0755`; at most 2,000,000 entries and 256 GiB; files
  opened `O_NOFOLLOW`; links and devices skipped and counted. Restores from a local snapshot copy
  the tree and recreate symlinks as symlinks (they are never followed).
- *In place, a new epoch.* A fleet restore into a placed server takes a new epoch on the same node
  (`placement.restored`); a running copy is stopped first and started again after.
- *The application boots it while `restoring`*, where no route reaches it, so its access list is
  back on the files before anyone can join; a server that was stopped is stopped again.

- *The swap is one exchange.* `renameat2(RENAME_EXCHANGE)` puts the new data in place and the
  old where the new was, in one step, so a crash leaves the old data or the new, never neither. A
  marker in the new data tells which side of the swap a crash fell on, and blocklyd settles it
  when it starts and before each restore. A filesystem that can't exchange gets two renames, and
  the same recovery finishes the second (#src("apps/blocklyd/src/store.rs:301")).

= Relocation <s-relocation>

Moving a fleet server to another node: an operator's move, a region change, a drain, or a start
that needs room elsewhere. A move refused before anything was let go (no room anywhere, or a world
too big to copy) leaves the server where it was, running if it ran; one that fails partway fails
as any operation does (see the caveat below). #implemented

#block(sticky: true)[The application takes a snapshot first, while the server still runs
(`pre_relocate`, quiesced); then FleetRuntime moves it:]

#fig(sequence({
  import chronos: *
  par-control("fr", [FleetRuntime])
  par-storage("pg", [Postgres])
  par-runtime("a", [Node A (source)])
  par-storage("s3", [Archive store])
  par-runtime("b", [Node B (target)])
  _note("over", [room first: `selectNode` avoiding A, or `RuntimeFull` and nothing stops], pos: "fr")
  _seq("fr", "a", comment: [stop (epoch 7) if running])
  _seq("fr", "a", comment: [`POST …/export` (epoch 7), minus what the image remakes])
  _seq("a", "s3", comment: [PUT tar.gz to a presigned URL, or in parts])
  _seq("fr", "s3", comment: [HEAD: size matches? archive `ready`, sha256])
  _seq("fr", "pg", comment: [region lock; still epoch 7 on A? choose B again; epoch 8; `placing`])
  _seq("fr", "b", comment: [`PUT` spec (epoch 8); `POST …/restore` from the archive])
  _seq("b", "s3", comment: [GET, check sha256, unpack, swap], dashed: true)
  _seq("fr", "pg", comment: [`placed`; event `placement.restored`; move archive deleted])
  _seq("fr", "a", comment: [`POST …/fence` {currentEpoch: 8}; delete A's copy])
  _note("over", [the application starts it on B; the edge follows the new handle within a second], pos: "fr")
}), caption: [A planned move, epochs 7 → 8. #src("apps/control/src/infra/fleet/fleet-runtime.ts:1065") (relocate), #src("fleet-runtime.ts:2087") (export), #src("fleet-runtime.ts:2218") (finishMove).], name: "fig-relocation")

#figure(
  table(
    columns: (1.3fr, 2fr),
    table.header[If this fails][What happens],
    [No node has room (before or after the export)], [`RuntimeFull`. The export is discarded; a server that was running starts again on A. The server settles back where it was, running if it ran (`stayPut`, #src("apps/control/src/app/operations/handlers.ts:1092")); the relocation sweep asks again 15 minutes later, twice as long after each refusal in a row (up to a day), and only once there is room.],
    [A world its node can't send (too big for one upload, on a node without parts)], [Declined (`RuntimeUnsupported`), and recorded each time (`placement.move_declined`): an operator's request is dropped, a server that was running starts again on A, and it settles back the same way. Asked again, it is declined before anything stops (#src("fleet-runtime.ts:1947")).],
    [The export or upload], [Archive `failed`; the server stays on A at epoch 7, stopped if it was stopped for the move. The operation tries once more, then fails for good (below).],
    [The placement changed meanwhile], [`StaleHandle`; the copy is discarded (`move.export_superseded`).],
    [Crash after epoch 8 was chosen], [The row stays `placing` with `completing = move`; the next start or relocation finishes it from the archive (`#finishMove` is idempotent).],
    [Restore on B], [The row stays `placing`; retrying restores again. A is not fenced until B holds the world.],
    [The fence or delete on A], [Logged; the heartbeat answer and `tidy()` fence and remove it later.],
  ),
  caption: [Relocation's failure behaviour.],
  kind: table,
)

- Only what the image can't remake is moved: the server jar and unpacked libraries are excluded
  (`reconstructible`) and remade at first start, so a move costs an export and a restore of the
  world itself: seconds for a small world. Measured: a 1 GB world exports in 14.3 s and restores in
  10.8 s on the test VM (@a-bench).
- *A start that needs room* (`#startElsewhere`) uses the same steps, then claims room on B and
  starts it there (`placement.moved_for_room`).
- *Between runtimes* (fleet to Fly, Fly to Boat …) a server moves through a backup any runtime can
  restore, only when an operator asks (`scripts/runtimes.ts move`), at its next quiet moment
  (@s-hybrid).

#caveat[*A move that fails partway stops the server.* An export, upload or restore that fails is
tried once more (#src("apps/control/src/app/servers/transitions.ts:24")); when that fails too, the
runner lets the operation settle what it owns, which stops a server still reading `relocating`
(`stopWhatFailed`, #src("apps/control/src/app/operations/handlers.ts:176")), and records it
`failed` (#src("apps/control/src/app/operations/runner.ts:165")). Its world is whole on A, or
placing on B; the sweep leaves a move the platform made that failed to its owner, whose Try again
runs the same move (#src("apps/control/src/app/operations/schedules.ts:341")). Only refusals settle
back on their own.]

= Draining <s-drain>

`scripts/fleet.ts drain <node>` sets the node's lifecycle to `draining`: no new placements go
there, and its servers read as misplaced (`isPlaced` is false, #src("fleet-runtime.ts:1295")).
The `relocations` sweep then moves them each minute, three at a time, each once another node in
its region has room for it: a stopped server at once, a running one only while nobody is on it. A
move refused or failed lately waits 15 minutes before the sweep asks again, twice as long after
each refusal in a row, up to a day; a world too big to copy never leaves, and says so each time. `undrain` stops the drain. An operator's `move <server>` doesn't wait: it starts the relocation at
once, whoever is playing. #implemented

#fig(draw(
  spacing: (12mm, 8mm),
  who((0, 0), [Operator]),
  cp((1, 0), [Node: draining], name: <n>),
  cp((2.2, 0), [`relocations`\ #text(size: 6.4pt)[every minute, 3 at a time]], name: <sweep>),
  rt((1.6, 1.1), [stopped servers:\ move now], name: <a>),
  rt((2.8, 1.1), [running, players on:\ wait], name: <b>),
  rt((4, 1.1), [running, nobody on:\ move], name: <c>),
  edge((0, 0), <n>, "-|>", lbl[`drain`]),
  edge(<n>, <sweep>, "--|>", lbl[misplaced]),
  edge(<sweep>, <a>, "-|>"),
  edge(<sweep>, <b>, "--|>", lbl[next minute], label-side: right),
  edge(<sweep>, <c>, "-|>"),
), caption: [A drain never stops a busy server. #src("apps/control/src/app/operations/schedules.ts:326").], name: "fig-drain")

#why[Moving a running server costs its players a reconnect; waiting costs nothing. A drain is for
planned work (an upgrade, a decommission), where minutes don't matter. An operator who can't wait
moves servers explicitly (`move <server>`).]

= Node loss <s-node-loss>

#block(sticky: true)[What happens when a host dies, from the first missed heartbeat to its servers
running elsewhere. #implemented, except the parts marked.]

#fig(draw(
  spacing: (6mm, 7mm),
  rt((0, 0), [heartbeats\ stop], name: <t0>),
  cp((1, 0), [suspect\ #text(size: 6.4pt)[15 s]], name: <t1>),
  cp((2, 0), [unavailable\ #text(size: 6.4pt)[45 s]], name: <t2>),
  who((3, 0), [an operator\ fences the host], name: <t3>),
  cp((4, 0), [`lost --fenced-by`\ #text(size: 6.4pt)[placements displaced]], name: <t4>),
  cp((5, 0), [rebuild\ #text(size: 6.4pt)[after 10 min grace]], name: <t5>),
  cp((6, 0), [new node,\ epoch +1], name: <t6>),
  edge(<t0>, <t1>, "-|>"),
  edge(<t1>, <t2>, "-|>"),
  edge(<t2>, <t3>, "-|>"),
  edge(<t3>, <t4>, "-|>"),
  edge(<t4>, <t5>, "-|>"),
  edge(<t5>, <t6>, "-|>"),
), caption: [Node loss. Nothing to the right of "unavailable" happens without an operator.], name: "fig-node-loss")

1. *Detection.* Suspect after 15 s of silence, unavailable after 45 s. No new placements; its
   servers read `unknown`. Players connected to it are already disconnected if the host is dead,
   or still playing if only the network to the control plane is cut (@s-split-brain).
2. *Fence, physically.* The operator makes sure the host is stopped and stays stopped: power-off in
   the provider's console, rescue boot, or network removed. No provider API is wired to do this
   (#deferred).
3. *Declare.* `scripts/fleet.ts lost <node> --fenced-by <how> --reason <why>`. Refused while the
   node still beats (`node_is_beating`) unless forced. Its placements become `displaced`, its
   observations are deleted, events `node.lost` and `placement.displaced`.
4. *Grace, then rebuild.* The application marks each server `host lost` when it first sees it, and
   the relocation sweep rebuilds it after `HOST_LOSS_GRACE_MS` (10 minutes), asking once more
   whether the host answers (#src("apps/control/src/app/operations/schedules.ts:82")). The rebuild
   places it on another node in its region under a new epoch and restores its newest *uploaded*
   snapshot (`#rebuild`, #src("fleet-runtime.ts:2165")).
5. *Route.* The new handle names the new node; the edge follows within a second.

#figure(
  table(
    columns: (1fr, 2fr),
    table.header[Question][Answer],
    [What is lost?], [Play since the newest snapshot that reached the archive store: up to about 24 hours (scheduled snapshots are daily, for servers played since the last one), plus any upload still pending.],
    [How long are players out?], [Detection (45 s) + the operator's response + 10 min grace + the restore (seconds per GB).],
    [With one node?], [The servers wait for the host. Declared lost with no other node, they wait too: the sweep asks for a rebuild only once a node in the region has room, and then rebuilds them by itself.],
    [If the host comes back?], [Its heartbeat is answered with lease 0 and fences for every rebuilt server's copy; nothing there runs again. Every copy whose epoch ended `lost` is reported as a fork (`fork.detected`), whether or not it holds newer play: nothing compares the data. `tidy()` never deletes such a copy: its owner decides.],
    [If the operator was wrong?], [`reinstate` puts the node back to `active`; certificates stay pinned through `lost`.],
  ),
  caption: [Node loss, in answers.],
  kind: table,
)

= Split brain <s-split-brain>

#block(sticky: true)[The one failure the fleet does not prevent on its own: a node cut off from
the control plane but not from players. #implemented as described; automatic prevention #deferred.]

#fig(draw(
  spacing: (13mm, 8mm),
  cp((1, 0), [Control plane], name: <cp>),
  rt((0, 1.2), [Node A\ #text(size: 6.4pt)[copy \@7 keeps running]], name: <a>),
  rt((2, 1.2), [Node B\ #text(size: 6.4pt)[rebuilt copy \@8]], name: <b>),
  who((0, 2.3), [players still on A], name: <pa>),
  who((2, 2.3), [players routed to B], name: <pb>),
  edge(<cp>, <a>, "-", stroke: (paint: caveat-ink, thickness: 1pt, dash: "dashed"), lbl[partition]),
  edge(<cp>, <b>, "-|>", lbl[only after an operator\ wrongly declares A lost]),
  edge(<pa>, <a>, "-|>"),
  edge(<pb>, <b>, "-|>"),
), caption: [Two copies run only if an operator declares a reachable-by-players node lost. The world forks.], name: "fig-split-brain")

What stops it, and what does not:

- *The lease* stops A restarting or resuming anything unasked after 120 s without an answer. It does
  not stop A's running copy: the lease never stops anything (@s-lease).
- *Epochs* make A's copy unusable to the control plane: any request at epoch 7 is refused once A
  has heard of epoch 8. But A can't hear while partitioned.
- *The operator's physical fence* is the guard: `lost` requires saying how the host was stopped,
  and is refused while the node beats. An operator who declares a partitioned-but-alive node lost
  gets two copies.
- *Stale connections.* mc-router doesn't close a connection when its route changes, so players on
  A's copy keep playing on it until A hears its fence and stops it, as the two-node
  experiment showed.

When A returns, its first heartbeat is answered with fences; its copy stops and never runs again,
and the fork is reported (`fork.detected`). Nothing is merged automatically.

#why[*Why not automatic failover.* It needs a fence that doesn't depend on the node: a provider
power-off that stays off, or a node that stops its own servers when its lease runs out. The second
turns every control-plane outage longer than the lease into a fleet-wide outage; the first isn't
built. So the operator's confirmation is the fence (#src("docs/fleet.md:255")). Closing stale
connections at the edge (a relay in the edge agent) is #designed, not built
(#src("docs/fleet.md:426")).]
