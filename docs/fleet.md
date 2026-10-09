# The fleet runtime

`RUNTIME_PROVIDER=fleet` runs Blockly's Minecraft servers on Linux hosts Blockly manages
directly: rented VMs or dedicated servers, each running [blocklyd](../apps/blocklyd/). One big
machine is a whole deployment; many machines are the same runtime with more nodes in it. There is
no cluster to run: no quorum, no consensus store, no Kubernetes or Nomad, no service mesh, no
distributed filesystem, no live migration, and no automatic failover.

It is a `MinecraftRuntime` like Fly's and Docker's ([architecture §8](architecture.md#8-minecraftruntime-and-the-runtime-handle)).
The application doesn't know it is there.

- Operating it: [fleet-operations.md](fleet-operations.md).
- The node's API: [apps/blocklyd/docs/protocol.md](../apps/blocklyd/docs/protocol.md).

## Contents

1. [The parts](#1-the-parts)
2. [One machine, or many](#2-one-machine-or-many)
3. [Trust](#3-trust)
4. [State: desired and observed](#4-state-desired-and-observed)
5. [Placement](#5-placement)
6. [Epochs and fencing](#6-epochs-and-fencing)
7. [The execution lease, restarts and reboots](#7-the-execution-lease-restarts-and-reboots)
8. [Storage, snapshots and backups](#8-storage-snapshots-and-backups)
9. [Moves and rebuilds](#9-moves-and-rebuilds)
10. [Failure semantics](#10-failure-semantics)
11. [Networking and the edge](#11-networking-and-the-edge)
12. [Isolation](#12-isolation)
13. [Upgrades](#13-upgrades)
14. [Observability](#14-observability)
15. [Cost](#15-cost)
16. [Canary](#16-canary)
17. [Providers](#17-providers)
18. [What isn't built](#18-what-isnt-built)

## 1. The parts

```
                         control plane (apps/control, ROLES=api,worker)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ application ── MinecraftRuntime ── FleetRuntime (infra/fleet/fleet-runtime.ts)│
  │                                     │ placement · epochs · snapshots · moves   │
  │  node endpoint :8443 (mTLS) ── registry (infra/fleet/registry.ts) ── Postgres │
  │  operator API (internal listener) ── scripts/fleet.ts                        │
  └───────────────▲────────────────────────────────┬─────────────────────────────┘
       enroll,    │ heartbeats (every 5 s)         │ workload API (mTLS, epochs)
       renew      │                                ▼
  ┌───────────────┴───────────────── node ──────────────────────────────────────┐
  │ blocklyd ── Docker ── one container per server, data in /var/lib/blocklyd   │
  └─────────────────────────────────────────────────────────────────────────────┘
                    archives ◄──► object store (presigned URLs, never credentials)
```

| Part | Where | Owns |
|---|---|---|
| blocklyd | each node, as root beside Docker | what exists on its host: containers, host ports, data directories, local snapshots, what it observed. It decides nothing about what should run, apart from its restart policy under a lease (§7). |
| Node endpoint | `ROLES=api`, `FLEET_NODE_LISTEN` | enrollment, heartbeats, certificate renewal |
| Registry | Postgres (`fleet_*` tables, migrations 0040, 0042 and 0043) | nodes, their lifecycle and health, tokens, observations, the event ledger |
| FleetRuntime | every role | placements, epochs, archives, moves, rebuilds; the port's methods |
| Upkeep | `ROLES=worker`, the `runtime-upkeep` job every minute | health changes, probes of silent nodes, uploads, tidying, copies of deleted snapshots (in the store, and on nodes once they can be asked), local-copy trimming, half-finished placements, first placements their node never got, dropping events after 90 days |
| Operator API | the internal listener | what operators do (§ [fleet-operations.md](fleet-operations.md)) |

**A node needs** Linux with cgroup v2, Docker set up as
[`deploy/daemon.json`](../apps/blocklyd/deploy/daemon.json) (live-restore, inter-container traffic
off, bounded logs), a machine id of its own, a synchronised clock, a private address for its
listeners, and free game ports; XFS with reflink under `/var/lib/blocklyd` makes snapshots cheap.
`blocklyd doctor` checks each of these on the host and says what to do about any that falls short
([fleet-operations.md §2](fleet-operations.md#2-adding-a-node)).

## 2. One machine, or many

The same runtime, the same tables, the same code paths. With one node, placement has one choice,
a move has nowhere to go (it is refused as `RuntimeFull` before anything stops, and the server
stays as it was), and a lost host means servers wait for it or are rebuilt from the archive store
once another node exists. With several, placement chooses (§5), operators can drain and move, and a lost
host's servers can be rebuilt on the others from their last uploaded snapshots (§9).

A single big machine is a fine deployment. What it gives up is only what a second host gives:
somewhere to go when the first is down. Its backups still leave the host (§8), so losing the
machine loses at most the play since the last uploaded snapshot.

## 3. Trust

### Identities

- **A fleet CA per deployment** (`scripts/fleet.ts ca`). The control plane holds its key
  (`FLEET_CA_KEY`, from the deployment's secrets); nodes get only its certificate.
- **Nodes** make their own P-256 key and never send it anywhere. Enrollment gets them two
  certificates for it, both named `<node-id>.nodes.<deployment>.fleet`: serverAuth for their
  API, clientAuth for their heartbeats. The control plane names the node; the CSR's subject is
  ignored. The identity is the certificate, never an address.
- **The control plane** calls nodes as `control-plane.<deployment>.fleet` with a client
  certificate it issues itself for two days and renews every day. Nodes accept no other name.
- **The node endpoint** presents `endpoint.<deployment>.fleet` (and its listed addresses), issued
  for seven days and replaced every day.

TLS 1.3 only, both ways, with no 0-RTT.

### Enrollment

- A token is 32 random bytes, shown once. Only its sha256 is stored, with its region (one
  `FLEET_REGION_MAP` maps to), labels, expiry (an hour by default, at least a minute, at most a
  week) and who made it. It enrolls exactly one node.
- An operator is given it as a **join token**: `bk1.` and base64url JSON with the node endpoint's
  URL, the sha256 of the fleet CA, the deployment, and the secret
  ([protocol.md](../apps/blocklyd/docs/protocol.md#what-a-joining-host-fetches)). The line
  `fleet.ts token` prints fetches the CA from that URL without trusting it, stops unless the hash
  matches, and only then fetches `join.sh` and blocklyd over TLS checked against it. The token's
  hash is the trust anchor a new host starts from; everything after it is the CA's.
- `blocklyd join` writes the CA, the token and a configuration holding only the deployment and the
  endpoint: the node's address and the memory it keeps are worked out from the host at each start
  (`infer.rs`), and anything the configuration sets wins.
- The node sends the token's secret, a CSR and its facts (hostname, boot id, sha256 of `/etc/machine-id`,
  version, features, addresses, capacity). blocklyd deletes the token file once enrolled.
- **An answer that never arrives.** The token keeps the sha256 of the key it enrolled (the CSR's
  SubjectPublicKeyInfo). A node whose answer was lost asks again with the same token and the same
  key (blocklyd keeps the key between attempts), and until the token's own expiry it is answered
  again for the node the token made: new certificates for that key, pinned in place of the ones it
  never received (`node.enrollment_repeated`). That gives nobody else anything, since the
  certificates are worthless without the key, which never left the node. Any other use of a spent
  token is refused as an unknown one is, and a retired node is never answered again.
- Two nodes with the same machine-id hash are recorded (`node.machine_id_reused`): a cloned
  image.

### Pinning, renewal and revocation

- The registry pins each node's client certificate by its sha256. A heartbeat with any other
  certificate of the right name is refused (`certificate_not_current`), so a stolen but replaced
  certificate is worthless.
- **Renewal.** Certificates last `FLEET_NODE_CERT_DAYS` (30). Within `FLEET_RENEW_DAYS` (10) of the
  end, heartbeat answers say `renew`. The node makes a new key, asks with its current certificate,
  and switches its files by one atomic rename. The registry accepts the old or the new
  certificate until the first beat that presents the new one, then only the new one.
- **Revocation** is the registry's: `retire` unpins a node and its certificates stop working at
  once (the control plane is the only relying party, so no CRL is needed). `lost` keeps the pin, so
  a node an operator was wrong about can be reinstated.
- **Two hosts with one identity** (a copied disk) are caught by their sessions: a second daemon
  session beating while the first still does, or the previous session beating after it was
  replaced. The node is quarantined: no new placements, and an operator decides.
- **Re-enrollment.** A node whose certificates ended, or whose identity directory was lost, gets
  a token bound to its id (`token --node`). It enrolls with a new key under the same id, the old
  certificates stop working at once, and its placements stay, so the host adopts its own servers
  (their containers carry the node id). A host reinstalled with an empty disk has nothing to keep:
  it enrolls as a new node, and the old one is declared lost.

### Threat model

| Threat | What stops it |
|---|---|
| Someone on the network calls a node's API | mTLS: a client certificate from the fleet CA, for exactly the control plane's name |
| A node is compromised | It holds its own key and certificates only. It can lie in its heartbeats about its own copies, and nothing more: placement decides on the registry's ledger, fences come from the control plane, and other nodes' APIs refuse its certificate (wrong name, wrong usage). |
| A workload in a container attacks its host | Docker hardening (§12). Its data directory is read by blocklyd only through the walk that never follows a link (§8). |
| A token leaks | One enrollment, then nothing; an hour by default. Presented again it answers only the node it enrolled, for that node's own key. The node it made is visible and can be retired. |
| A node's certificate leaks | Useless once renewed (pinning); retire for immediate effect. |
| The CA key leaks | Every identity can be forged. Replacing the CA re-enrolls every node under its own id, which cuts nodes off until each has ([fleet-operations.md §8](fleet-operations.md#8-certificates)); nodes refuse a renewal under another CA. Keep it in the deployment's secret store only. |
| The operator token leaks | Operator actions, including declaring a node lost. It never reaches nodes; rotate it like any secret. |
| Presigned archive URLs leak | One object, for 30 minutes. They are never logged by blocklyd (only scheme, host and path). |

## 4. State: desired and observed

| Table | Holds |
|---|---|
| `fleet_nodes` | identity, addresses, lifecycle (`active`, `draining`, `lost`, `retired`), session, health, capacity as last reported, certificate pins |
| `fleet_node_tokens` | enrollment tokens (hashes) |
| `fleet_placements` | **desired**: per server, the node, the epoch, the state (`placing`, `placed`, `displaced`, `released`), its memory, CPU and disk, the last power command and when, a pending operator move |
| `fleet_placement_history` | every epoch: where, why it started, why it ended |
| `fleet_observations` | **observed**: per node and copy, the last report (state, epoch, ports, exit). Written only when a report changes. |
| `fleet_archives` | snapshots and move archives: where they are (node, store), their checksum, their status |
| `fleet_endpoints` | which control-plane processes serve the node endpoint, so silence is only held against a node while someone was listening |
| `fleet_events` | the ledger: every decision and every surprise, with who acted |

A node's heartbeat carries everything it holds, every time, so a node that was cut off, restarted
or rebooted resynchronises fully on its first beat. The node's own records
(`/var/lib/blocklyd/workloads/*/workload.json`, and a copy in each container's labels) let it
rebuild its state without the control plane, and the control plane's let it rebuild the fleet's
without any node.

**Health** is derived, never stored as truth: `healthy`; `degraded` (Docker doesn't answer, or
the node hasn't reconciled since); `suspect` after `FLEET_SUSPECT_SECONDS` (15) of silence;
`unavailable` after `FLEET_UNAVAILABLE_SECONDS` (45). Suspect keeps the last report, so a missed
beat doesn't flap a server's state. Health changes are recorded as events by upkeep. **Lost is
never derived**: only an operator declares it (§6).

## 5. Placement

Deterministic and pure (`placement.ts`): filter, then score, with every node's reason kept so a
refusal says why ("memory: 900 MB free after headroom, needs 3072").

**Filters:** lifecycle `active`, not quarantined, `healthy`, in the server's fleet region
(`FLEET_REGION_MAP`; `RUNTIME_REGION_MAP` only where the fleet is the default runtime), the
protocol features the runtime needs, memory and CPU to run now beside the servers running there,
memory left to place servers in, disk free above the node's floor, disk not yet promised, host
ports.

**The resource model**, per node:

| | Memory | CPU | Disk |
|---|---|---|---|
| Physical | `memoryTotalMb` | cores | filesystem size |
| Reserved for the host | `reserved_memory_mb` (2 GB) | `reserved_cpu_millis` (1 core) | `min_free_disk_mb` floor (5 GB) |
| Allocatable | physical − reserved (or the node's cap) | (cores × 1000 − reserved) × `FLEET_CPU_OVERCOMMIT` | (size − floor) × `FLEET_DISK_OVERCOMMIT` |
| Running, in the ledger | the servers that run, or are being started or made | `FLEET_CPU_MILLIS_PER_GB` (250) per GB of their memory | — |
| Allocated, in the ledger | every server placed there, running or asleep: at most allocatable × `FLEET_MEMORY_OVERCOMMIT` (4) | the same, per GB | each placed server's storage size |
| Observed | working sets, as reported | cores in use, load | free bytes, snapshot bytes |

Placement decides on the **ledger**, never on what is observed, so a burst of placements can't
overcommit a node before its next heartbeat. Observed numbers are for operators and for the node's
own admission: it refuses a start past allocatable × `memory_overcommit` of running memory. A
running server's memory isn't overcommitted by default, since a JVM with a pre-touched heap uses
what it is given. A sleeping server holds none.

**Admission.** Memory and CPU are held only by servers that run, or are being started or made
(`HOLDS` in `registry.ts`). A sleeping server holds only its disk, where its world stays.

- **A placement** (a new server, a move, a rebuild) needs room to run now, after
  `FLEET_HEADROOM_MB`. It also needs room to stay: the servers placed on a node, running or not,
  may add up to its memory × `FLEET_MEMORY_OVERCOMMIT`. Plans let a server run 3–8% of a month,
  so 4 leaves room for a node's placed servers to run at a busy evening's rate. `1` holds memory for every placed
  server, as the fleet did before.
- **A start claims its memory** in the ledger, under the region's lock, before the node is asked.
  A stop gives the claim back. So does the node reporting the copy stopped or crashed after the
  start. A copy made and not yet started (`created`) keeps the claim.
- **A start with no room where the server sleeps moves it first.** This is the start the
  application makes for a sleeping server, `ensureProvisioned` with its spec. If the servers
  running on its node leave it no room, its world goes through the archive store to a node in its
  region that has room, as a planned move does, and it starts there. Operators see this as
  `placement.moved_for_room`, with the reason. Nobody is asked: the world is the same wherever it
  runs, and the move costs only the export and restore, seconds for a small world. With no room on
  any node, the start fails with `RuntimeFull`, as at any provider that is out of capacity.
- **`start(handle)` doesn't move.** It is used for a restart and for a start after a restore, and
  has no spec, so it is `RuntimeFull` when its node is full.
- **A planned move of a running server claims its room** on the new node as that node is chosen,
  as a move to make room does, so the start that follows the move finds the room still there.
- **A move a crash interrupted** after its new home was chosen is finished by the next start.
- **The node's own admission stays the final arbiter.** If it refuses a start because it runs a
  copy the ledger doesn't know of, the claim is given back and the server moves after all.

**Policies** (`FLEET_PLACEMENT`) score what is placed, running or not, against what may be placed:
a placement lasts as long as its world stays, while what runs changes by the hour.

- `balanced` (the default) is best fit on memory among nodes under the CPU pressure line
  (`FLEET_CPU_PRESSURE`, 0.8). Past the line it picks the least CPU-pressed node.
- `binpack` fills nodes.
- `spread` picks the node with the most room.

Ties fall to the node id, so a decision is reproducible from its inputs. `FLEET_HEADROOM_MB` is
memory a placement must leave free on its node beside the servers running there. It is 0 by
default, so nothing is kept unless it is set, and starts may use it.

Each region's placements take a Postgres advisory lock, so two placements can't both take the
last room on a node.

## 6. Epochs and fencing

Every new home of a server gets a **placement epoch**: a number that rises in the same
transaction that changes the placement and is never reused. Every mutating request to a node
carries it (`blocklyd-epoch`). A node refuses a request older than the copy it holds, refuses to
run a copy for any epoch but its own, and refuses everything but teardown on a copy a newer epoch
**superseded**. A superseded copy is never started again, by anyone.

- **Fences** reach nodes in heartbeat answers (and directly, during a move): "this workload is at
  epoch N". A node stops an older copy, switches off its restarts, keeps its data, and marks it
  superseded. Late or repeated fences are harmless. One the node marked but couldn't carry out
  (its runtime didn't answer) isn't sent again; the node stops the copy itself at its next resync.
- **A copy of no placement at all** (its server was destroyed while its node was unreachable, or
  the database was restored from before it existed) is fenced one epoch past its own and reported
  (`copy.orphaned`). Upkeep deletes it only when the history says its server was destroyed.
- **A restored database** that is behind a node: the node's newer epoch is adopted for its own
  placement (`epoch.adopted`), and flagged for any other (`epoch.conflict`).
- **A host is never declared lost by a timer.** `unavailable` is a fact about the network; `lost`
  is an operator's statement that the host is stopped and will stay stopped. The operator says how
  (`--fenced-by`: powered off in the provider's console, rescue boot, network removed) and why.
  Only then do its servers become `displaced` and get rebuilt elsewhere (§9).

**Why no automatic failover.** With today's edge, an operator who declares a reachable-but-silent
node lost gets two copies of a server running, and players connected to the old one keep playing
a fork until that node hears its fence (a two-node experiment measured this).
Automatic failover needs, first, a fence that doesn't depend on the node: a provider power-off
that stays off (§17), or a node that stops its own workloads when its lease runs out, which turns
every control-plane outage longer than the lease into a fleet-wide one. Neither is built; the
operator's confirmation is the fence.

## 7. The execution lease, restarts and reboots

**blocklyd is the restart authority on its host.** Docker's own restart policy is always `no`;
blocklyd restarts a workload that failed under it, per the spec's policy (`on-failure`, 3 tries
with backoff from Fly's and Docker's runtimes), and only while it holds an **execution lease**.

- Each heartbeat answer grants `FLEET_LEASE_SECONDS` (120) from when the beat was sent, measured
  on `CLOCK_BOOTTIME`, which keeps counting while a VM is paused.
- A node the control plane holds `lost` gets 0. A node that hasn't heard from the control plane
  in a lease's time restarts nothing on its own: it may have been replaced.
- The lease never stops anything. A control-plane outage changes nothing for players.
- Requests (start, exec, …) carry their own authority, the epoch, and don't need the lease.

**Reboots.** blocklyd records, per workload, the boot (kernel boot id) in which it last saw it
running. After the host restarts, a workload still marked with an earlier boot, never asked to
stop, not superseded and with a restart policy was running when the host went down: it reports
`restarting`, and is started once the node holds a lease. The heartbeat that grants the lease
applies its fences first, so a server rebuilt elsewhere meanwhile never starts here. A node held
lost gives its resumes up and forgets them. A restart of blocklyd alone (same boot) resumes
nothing: what died while it was down is reported, not restarted.

## 8. Storage, snapshots and backups

**Data** lives on the node's own disk, in `/var/lib/blocklyd/workloads/<server>/data`,
bind-mounted into the container: local NVMe latency, which Minecraft's region saves need. The
node's floor (`min_free_disk_mb`) is held at every create, export, snapshot and restore.

**Snapshots** are two steps, so a backup costs the player as little as possible:

1. **On the node, at once.** The application pauses saving (`save-off`, `save-all flush`); the
   node copies the data beside it (`snapshots/<id>/`, never mounted). On a filesystem that shares
   blocks (XFS with reflink, btrfs) every file is a `FICLONE`: moments, and no space until the
   data changes. On ext4 it is a full copy. Measured on this project's test VM (ext4, virtual
   disk), a 1 GB world: 2.9 s, 1 GB of disk.
2. **To the archive store, in the background.** Upkeep uploads it (`snapshot.uploaded`), a few at
   a time, retrying up to five times; the size is checked against the store's own. Until then,
   a restore on the same node uses the local copy; a rebuild elsewhere uses the newest uploaded
   one. A copy larger than one PUT carries (5 GiB less 5 MiB on R2; the node's
   `transfer.max_put_mb`) goes in parts: the control plane begins a multipart upload and offers
   the node a presigned URL for each part, the node sends them and reports each part's ETag, and
   the control plane completes the upload, or drops it when anything failed. Parts are offered at
   once when the world's size says they will be needed; otherwise the node's refusal
   (`archive_too_large`, before anything is sent) says how large the archive is, and it is asked
   again with parts for that. Only a copy its node can't send in parts (a node without the
   `multipart-upload` feature) fails at once and for good (`snapshot.upload_failed`, with its size
   and the limit), and stays on its node, where a restore there still finds it.

A node packs a snapshot for one upload at a time (`snapshot_busy` to another meanwhile): an export
of a snapshot whose own upload is still under way waits for it, and an upload that finds its node
busy exporting is left for the next round without counting as a try. An export the node can't
answer for comes from the store's copy, through the control plane, read by its ranges into parts
when it is larger than one PUT carries.

Once a newer snapshot of the same server is uploaded, older local copies are dropped (the store
keeps them), so a node keeps about one extra world per server. Deleting a snapshot deletes both
copies. What can't go at once waits for upkeep: the store's copy keeps its key until the store has
deleted it, and a node's copy stays recorded until its node can be asked, which for a node declared
lost means reinstated or beating again (a retired node is never asked). The node reports what
snapshots hold (`snapshotBytes`) and whether it shares blocks (`reflink`).

**Reading a world safely.** A server's data belongs to whatever runs in its container, and
blocklyd reads it as root. Every walk (snapshot, export) opens each directory relative to its
parent with `O_NOFOLLOW`, never follows a link, skips an entry replaced mid-walk, never opens a
FIFO or device, and cuts or pads a file that changes while it is read to the size its archive
header states. A plugin swapping a folder for a symlink to `/` gets a symlink in the backup, not
the host's files (`tree.rs`; a race test swaps continuously while walking). Restores accept only
regular files and directories, refuse absolute paths and `..`, mask modes, cap size and entry
count, and unpack beside the data before swapping it in by rename.

**Archives** are gzip tarballs with `./`-relative paths, Blockly's existing archive format, with
a sha256 recorded at upload. A restore from the fleet's own copy in the store sends it, and the
node checks it; so does a restore from an application archive, with the sha256 its backup recorded
when it was written (`backups.sha256`). An uploaded world, an archive made before that was kept,
and a snapshot's local copy carry none. gzip's fastest level: on real Minecraft data a fresh world
compresses to about a quarter, while jars and libraries barely compress; on already-compressed
region data packing is the bottleneck (73 MB/s single-threaded on the test VM).

**ZFS** was evaluated as the snapshot layer (`zfs snapshot` + `zfs send` streams). It is not used:
it needs an out-of-tree kernel module on every node, and the test environment's kernel has none
(nor XFS or btrfs), so nothing about it could be measured honestly here. Reflink through the
ordinary filesystem gives the same "instant, free until it changes" snapshot on XFS (the default
filesystem of several providers' images) without a module. Revisit ZFS for incremental offsite
streams (`zfs send -i`) once worlds are large enough that full uploads hurt.

## 9. Moves and rebuilds

**An operator's move** (`scripts/fleet.ts move <server> [--to <node>]`) goes through the
application's own relocation: it takes a snapshot while the server still runs, with saving paused
(`pre_relocate`), then relocates it and starts it where it landed, as it does for a region change.
FleetRuntime checks there is room first, stops the source, exports from it what the image can't
make again (`reconstructible`: the server jar and the libraries it unpacks are left behind and
remade at first start), takes a new epoch on the target, restores, and fences and deletes the
source copy. The move archive is deleted once restored, and so is one no move will use: the
placement changed while the world was copied, or there was no room left once it was. A move with
nowhere to go is refused as `RuntimeFull` before anything stops: the server stays where it was,
running if it ran, and the move's operation records the refusal. A move the relocation sweep makes
(a drain, a remapped region) isn't asked for until a node has room for it. A world larger than one
upload carries moves in parts, as its snapshots upload. One its source can't send in parts (a node
without `multipart-upload`) can't move between nodes: the source refuses the export before sending
anything (`snapshot.upload_failed`), and the move is declined, leaving the server where it was,
running again if it ran. Later moves of it are declined before anything stops, until a newer copy
of it uploads.

**A rebuild after a confirmed loss** places the server on another node under a new epoch and
restores its newest uploaded snapshot (the application names it). With no node that has room, it
waits, and the relocation sweep rebuilds it once one does. What was played after that
snapshot is on the lost host only; if that host comes back, its copy is fenced and never runs, and
the fork is reported (`fork.detected`) for its owner to decide about. Nothing of its servers on a
lost host is deleted automatically; only copies of snapshots the application deleted meanwhile go,
once the host beats again.

**Drain** (`drain <node>`) stops new placements on a node. Its servers read as misplaced, and the
application's relocation sweep moves them off, up to three a minute: stopped ones at once, running
ones only while nobody plays on them, and only once a node has room for them. One whose move was
refused or failed is asked for again 15 minutes later, then twice as long after each refusal in a
row, up to a day. An operator's move doesn't wait for players.

## 10. Failure semantics

| What fails | One node | Several nodes |
|---|---|---|
| blocklyd crashes or restarts | Servers keep running (they aren't its children). It reconciles from disk and Docker in about a second and reports everything on its first beat. Tested end to end (SIGKILL, then restart: the container's start time unchanged). | Same, per node. |
| Docker restarts | With `live-restore` (deploy/daemon.json) servers keep running. Without it they stop and are reported, not restarted. | Same. |
| The host reboots | Servers that were running come back once the control plane answers (§7). | Same; a server rebuilt elsewhere meanwhile is fenced instead. |
| The host is down for good | Servers wait. After an operator confirms the loss, they can be rebuilt from their last uploaded snapshot once a node exists. | An operator confirms; servers are rebuilt on other nodes from their last uploaded snapshots. |
| Network partition | Servers keep running; nothing is restarted unasked after the lease. Players on the edge side of the partition keep playing. | The same. Don't confirm a loss for a partition: both sides would run. |
| Control plane down | Servers keep running, no new operations. Nodes restart nothing unasked after their lease. | Same. |
| Database restored from a backup | Nodes report newer epochs; their own placements adopt them; copies of servers the backup doesn't know are fenced, kept and reported. | Same. |
| Disk full | Creates, snapshots, exports and restores are refused above the floor (`507 insufficient_disk`); running servers are untouched; the node reports its free space. | Placement avoids nodes without disk. |
| A node's clock is wrong | Nothing depends on it: health uses the database's clock, the lease the node's monotonic boot clock. Certificates allow a minute of skew. | Same. |
| The archive store is down | Snapshots stay local and upload later; moves and rebuilds wait. Copies of deleted snapshots there are deleted once it answers. | Same. |
| A new server's first request never reaches its node | Its placement holds its room until a retry makes it. Once nothing has touched it for 30 minutes (the longest an operation runs) and its node has beaten since without the copy, upkeep undoes it (`placement.abandoned`), and the next start places the server afresh. | Same. |

## 11. Networking and the edge

**A private network is required** between the control plane, the edge and every node, e.g.
WireGuard. On it:

| Listener | On | Reached by |
|---|---|---|
| Node endpoint (`FLEET_NODE_LISTEN`, 8443) | control plane | nodes |
| blocklyd API (`api.listen`, 7443) | node | the control plane |
| Game ports (`network.edge_ips`) | node | the edge |
| Console and status ports (`network.control_ips`) | node | the control plane |
| blocklyd ops (`/metrics`, 7070) | node, loopback | the host's own scraper |

Nothing on a node needs a public address. A node's addresses are configuration it reports in
every heartbeat; the control plane follows a change (`node.addresses_changed`), so renumbering a
host is a config change and a restart, not a re-enrollment.

**The edge routes by the server's stable identity.** The edge asks the control plane for routes
(`/edge/v1/routes`); each is the server's play hostname and the endpoint its current handle names
(the node's edge address and the server's host port). A move or rebuild issues a new handle, and
the edge follows within its next poll (a second). Host ports aren't reused for ten minutes after
release (`port_quarantine_seconds`), so a stale route can't reach another server.

**Stale connections.** mc-router doesn't close a connection when its route changes: a player
connected to a copy that was superseded keeps playing on it until that copy is stopped. In a
planned move the source is stopped first, so this can't happen; after an operator-confirmed loss,
it lasts until the old node hears its fence. Closing connections whose destination left the route
set (an edge-side relay, or a patch to mc-router) is the prerequisite, with a real fence, for
automatic failover; it is not built. The relay, as designed:

- The edge agent points each server's mc-router route at a local listener of its own instead of
  the backend, and splices each connection to the backend the route names now.
- It remembers the destination each spliced connection was opened to. When the control plane's
  routes name another destination for a server, the agent closes the connections to the old one:
  players reconnect, and land on the new copy.
- Routes would carry a version per server (the handle's epoch, through the edge protocol), and the
  agent would refuse an older one than it has seen, so a delayed poll can't send players back.

This costs one copy of every byte through the agent (Minecraft traffic is small: tens of KB/s per
player) and keeps mc-router as it is.

## 12. Isolation

Every server is a Docker container blocklyd makes with: a non-root numeric user, a read-only root
filesystem with a small tmpfs `/tmp`, every capability dropped, `no-new-privileges`, not
privileged, private IPC, Docker's default seccomp profile (and its AppArmor profile only where the
host has AppArmor enabled), a hard memory limit with no swap, a PID limit, a CPU weight by size,
an OOM score that puts workloads before blocklyd and Docker, rotated and bounded logs, a bridge
network with inter-container traffic off, and ports published only on the addresses the config
names. A spec can ask for none of this to be relaxed: policy is the host's (`[workloads]`), not
the request's.

Containers share the host's kernel. Servers run arbitrary plugins and mods, so a kernel escape is
the residual risk. The path to stronger isolation, without changing the protocol (it never names
Docker):

- **gVisor** (`runsc` as the Docker runtime): a user-space kernel; no hardware virtualisation
  needed, so it runs on any VM. Costs syscall-heavy workloads; the JVM's is measurable. First to
  try: it is a daemon.json change and a per-node choice.
- **Kata Containers** or **Firecracker** microVMs: a kernel per server. Needs nested
  virtualisation on VMs, or bare metal. A runtime adapter in blocklyd (`runtime/`), and a memory
  overhead per server (~30–150 MB).

## 13. Upgrades

- **blocklyd** is one static binary, and the control plane's image carries the one built from the
  same commit. Deploying the control plane rolls it out: a heartbeat's answer offers it
  (`upgrade: {version, sha256}`) to a node on an older version, which downloads it from the node
  endpoint over its mutual TLS, checks it, keeps the binary it ran as `blocklyd.prev`, and
  restarts into it. Servers keep running and no drain is needed: they are Docker's, not
  blocklyd's. The new binary is on trial until it reconciles and a heartbeat is accepted; one that
  doesn't within two minutes, or can't start, is swapped back for the one before, which reports
  the failure in its heartbeats (`upgradeFailed`). [fleet-operations.md
  §9](fleet-operations.md#9-upgrading-blocklyd) is the operator's side.
- **The rollout** goes one node per region at a time. The next node is offered the release once
  the previous one beats healthy on it. A failure (one the node reports, or a node not healthy on
  the release 15 minutes after the offer) stops that region's rollout until an operator retries
  the node; other regions go on. Draining, lost and quarantined nodes aren't offered it, and nor are nodes
  without the `self-upgrade` feature, which would ignore the offer. Each node's place in it is
  four columns on its `fleet_nodes` row, written only in its own heartbeat's transaction; the
  release isn't stored, since it is whatever binary the serving process carries, so a new image is
  a new rollout. `FLEET_UPGRADES=off` turns it off.
- **Compatibility** is by `features`, not versions: a node announces what it supports, and the
  control plane places only on nodes with what it needs (`placement-epochs`, `data-transfer`,
  `local-snapshots`, `export-exclude`). Protocol responses only grow and unknown request fields
  are refused, so a newer control plane checks features before sending a new field. The rollout
  compares versions only to choose which nodes to offer the release. Upgrade the control plane
  first when it needs a feature only new nodes have; nodes without it simply get no new placements
  until upgraded.
- **The control plane** upgrades as usual; nodes keep running servers while it is away.

## 14. Observability

- **Events**: `fleet_events`, every decision and every surprise (placements, epochs, fences,
  losses, forks, orphans, uploads, renewals), with who acted. `scripts/fleet.ts events`.
- **Operator API / CLI**: nodes (lifecycle, health, room: physical, reserved, allocatable,
  running, allocated, observed), placements, a summary, the node endpoint's heartbeat counts and
  latency. Each api process serves the node endpoint and counts only its own heartbeats, since it
  started; the summary gives the figures of the process that answers it.
- **Node metrics** (`/metrics` on each node, OpenMetrics): operations, durations, HTTP, auth
  failures, reconciliations, workloads by state, ports, issues, per-workload memory, CPU and disk,
  snapshot bytes, heartbeats, contact age, lease left, certificate renewals.
- **Alerts worth having**: a node `unavailable` for more than five minutes; a node with
  `blocklyd_heartbeats_total{outcome="error"}` rising; `blocklyd_fleet_lease_remaining_seconds` at
  0 on an active node; uploads failing (`snapshot.upload_failed`); any `fork.detected`,
  `copy.orphaned`, `epoch.conflict` or `node.duplicate_identity`; disk below the floor;
  certificates within three days of their end.

## 15. Cost

A node carries its monthly price as a label (`monthly_cost_cents`), given at enrollment and
corrected with `scripts/fleet.ts label` (`node.labels_changed`). The runtime reports each server's
share of its node by memory, out of the node's allocatable memory × `FLEET_MEMORY_OVERCOMMIT`, as
`storageMonthCents` (compute is the node's whether servers run or not, so `runningHourCents` is 0),
which the application's cost views use as they use Fly's list prices. Unlabelled nodes report
nothing.

## 16. Canary

One deployment can run several runtimes at once (`RUNTIME_PROVIDERS=fly,fleet`): handles record
their provider, and `RuntimeRouter` (`app/runtimes/router.ts`) hands each to the runtime that
issued it. A canary is therefore a **placement rule** in the same deployment, on one or two nodes:
it sends the fleet a share of new servers, and an operator can move a few servers there too.
Rules, overflow and moves between runtimes are [runtimes.md](runtimes.md).

## 17. Providers

Provisioning is not blocklyd's job: a host needs only the line `fleet.ts token` prints, which
installs Docker and blocklyd, and `blocklyd join` works out the rest. On Hetzner Cloud, nodes are
declared in Terraform: each environment's `fleet-nodes.auto.tfvars.json` lists them, and
[`modules/fleet-node`](../infra/terraform/modules/fleet-node/main.tf) makes each a server on the
private network, behind a firewall, whose cloud-init runs its line; `fleet.ts add` and `remove` do
both halves ([fleet-operations.md §2](fleet-operations.md#2-adding-a-node)). Anywhere else the line
is pasted by hand. What matters per provider:

| | Hetzner Cloud | Hetzner dedicated | OVHcloud dedicated | Vultr | Akamai (Linode) |
|---|---|---|---|---|---|
| A power-off that stays off (a real fence) | yes | resets only; the rescue boot is a fence | no; emulated by netboot, minutes | yes (bare metal `halt`) | likely (API shutdown); not verified |
| Private network | vSwitch / networks | vSwitch | vRack | VPC | VLAN / VPC |
| Signed instance identity | no | no | no | no | no (token-gated, unsigned) |

No provider signs its instance identity, so trust comes from the one-time token, spent before any
workload runs. Provider block volumes have millisecond-class fsync (and Hetzner's and Vultr's no
snapshots), so worlds live on local disks. The power-off column is what automatic failover would
need (§6); today the operator fences.

## 18. What isn't built

- Automatic failover, and the fences it needs (§6, §11).
- Declaring nodes on providers other than Hetzner Cloud: there, the line is pasted by hand.
- Parallel compression, or pre-copy (upload while running, then a delta) for faster moves of
  large worlds (§8).
- Install seeds (`InstallSeed`) on nodes: a first start downloads the server as on Docker.
- Parallel parts. An archive larger than one PUT goes in parts one after another, each retried on
  its own; an upload cut short by a crash isn't resumed but begins again, and the store drops the
  parts left behind (R2 after 7 days; [fleet-operations.md §12](fleet-operations.md#12-what-to-watch)).
- Replacing the fleet CA without cutting nodes off: today every node re-enrolls under the new one
  ([fleet-operations.md §8](fleet-operations.md#8-certificates)).
