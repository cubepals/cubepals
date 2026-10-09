#import "../style.typ": *

#part("Appendices", [Reference material: interfaces, entities, protocol, configuration, signals,
  measurements, tests and words.], numbered: false)

#counter(heading).update(0)
#set heading(numbering: "A.1")

= Interfaces <a-interfaces>

== MinecraftRuntime

The port every runtime implements (#src("apps/control/src/app/ports/runtime.ts:192")). Handles
are branded opaque strings.

```ts
interface MinecraftRuntime {
  readonly provider: string                      // 'fly' | 'boat' | 'fleet' | 'docker' | 'fake'
  readonly serverCeiling: number | null          // most servers it can hold; null: no ceiling
  owns(h: RuntimeHandle): boolean
  ownsSnapshot(s: SnapshotHandle): boolean
  hasRoom(p: Placement, size: { memoryMb; storageGb }): Promise<boolean> // a hint
  // idempotent and convergent; leaves the server started
  ensureProvisioned(key, p: Placement, spec: RuntimeSpec, progress: ProgressSink,
                    install?: InstallSeed | null): Promise<RuntimeHandle>
  apply(h, spec): Promise<RuntimeHandle>          // restarts if running
  start(h): Promise<RuntimeHandle>                // may return a new handle (Boat)
  restart(h): Promise<void>                       // same compute, same handle
  stop(h): Promise<void>
  forceStop(h): Promise<void>
  waitRunning(h, signal: AbortSignal): Promise<void>
  readonly snapshotLifetimeDays: number | null
  snapshot(h): Promise<{ snapshot: SnapshotHandle; sizeBytes: number; at: Date }>
  goneSnapshots(ss): Promise<ReadonlySet<SnapshotHandle>>
  deleteSnapshot(s): Promise<void>                // may throw RuntimeUnsupported
  restore(h, from: RestoreSource, spec, progress): Promise<RuntimeHandle>
  relocate(h, to: Placement, spec, progress, from?: SnapshotHandle): Promise<RuntimeHandle>
  exportSnapshot(s, target: ArchiveTarget): Promise<{ sizeBytes: number; sha256: string }>
  exec(h, command: readonly string[], timeoutSeconds: number): Promise<ExecResult>
  decommission(h): Promise<void>                  // compute gone, storage kept
  release(h): Promise<RuntimeHandle>              // compute and storage gone; world is elsewhere
  adopt(key, p, spec): Promise<RuntimeHandle>     // a handle for a world arriving
  destroy(target: RuntimeKey | RuntimeHandle): Promise<void>
  observe(h): Promise<RuntimeObservation>         // state, exit, hostLost?, handle?
  observeChanged(since: Date): AsyncIterable<{ key; handle; observation }>
  isPlaced(h, p): boolean
  sameCompute(a, b): boolean
  inventory(): AsyncIterable<{ key; handle }>
  endpoint(h, port: string, audience: 'edge' | 'control'): Endpoint
  readonly stableEndpoints: boolean
  tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number>
  locate(h): RuntimeLocation
  prices(h, size): RuntimePrices | null           // list prices, US cents
  capacity(): Promise<RuntimeCapacity | null>     // machines paid for (fleet nodes)
}
class RuntimeFull extends Error {}        // "no room just then": a wait passes it
class RuntimeUnsupported extends Error {} // what a runtime can't do: an optional operation,
                                          // or a world too big to move or pack
```

== Edge protocol v1

Base `/edge/v1` on the control plane's internal listener, `Authorization: Bearer EDGE_TOKEN`
(#src("packages/contracts/src/edge.ts")).

```ts
GET  /edge/v1/routes   → { routes: { hostname; destination: 'host:port';
                                     state?: 'asleep' | 'restarting' }[] }       (ETag, 304)
POST /edge/v1/wake     { hostname } → { ready: { destination } } | 'starting' | 'restarting'
                         | { denied: 'unknown' | 'suspended' | 'paused' | 'quota' | 'deleted' }
POST /edge/v1/idle     { hostname } → 204          // a hint; the idle policy decides
POST /edge/v1/sessions { edgeId, hostname, event: 'connect' | 'disconnect', player?, at } → 204
```

== Node endpoint (fleet)

```ts
POST /fleet/v1/enroll
     { token, csrPem, facts: NodeFacts }
   → { nodeId, deploymentId, serverCertPem, clientCertPem, caPem, allowedClients,
       heartbeatSeconds }
POST /fleet/v1/nodes/:id/heartbeat
     { nodeId, sessionId, bootId, seq, daemonVersion, protocol, features, runtimeUp, reconciled,
       capacity, workloads: WorkloadReport[], issues, addresses? }
   → { lifecycle, fences: { workload, currentEpoch }[], heartbeatSeconds?, leaseSeconds?, renew? }
POST /fleet/v1/nodes/:id/renew
     { nodeId, csrPem } → { serverCertPem, clientCertPem, caPem }
```

= Database entities <a-db>

52 tables in `packages/db/src/schema.ts`; 45 migrations (`0000_init` … `0044_backup_sha256`),
applied by `packages/db/src/migrate.ts` as Fly's `release_command`, before any machine takes a new
image. `0043` adds the key a spent enrollment token enrolled (`used_key_sha256`), `0044` an
archive's sha256 to `backups`.

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Group][Tables],
    [Accounts and auth], [`users`, `auth_sessions`, `auth_accounts`, `auth_verifications` (Better Auth), `platform_admins`, `account_standing` (plan, status, restrictions, overrides, extra units)],
    [Servers], [`minecraft_servers` (the aggregate: owner, slug, region, size, status, failure, revision, world; never a hostname), `retired_slugs`, `server_revisions` (immutable boot configs), `worlds`, `server_runtimes` (the binding: provider, opaque handle, applied spec, observed state; `move_to`)],
    [Work], [`server_operations` (kind, status, progress, owner's error, operator's detail; idempotency key per server); pg-boss's own schema],
    [Access], [`server_access`, `server_access_entries` (whitelist, ops, bans, pending states)],
    [Worlds' copies], [`backups` (snapshots and archives, trigger, status, handle or archive key), `stored_artifacts`, `pending_uploads`, `mod_uploads`, `pack_contents`, `pack_imports`],
    [Catalog and curation], [`catalog_projects`, `catalog_versions`, `catalog_refreshes`, `pack_checks`, `curated_releases`, `trusted_mod_projects`],
    [Sharing and community], [`public_listings`, `listing_reports`, `server_stars`, `server_notes`, `play_domain_joins`],
    [Use and money], [`power_intervals` (runs, with their `provider`), `server_usage_days`, `server_presence`, `server_activity` (both unlogged), `server_players`, `billing_subscriptions`, `billing_orders`],
    [Platform], [`platform_controls` (kill switches, caps), `platform_alerts`, `audit_log`, `realtime_certificate`],
    [Runtimes], [`runtime_rules` (placement rules), `runtime_decisions` (`placed`, `fell_back`, `move_requested`, `move_cancelled`, `moved`, `move_failed`)],
    [Fleet], [`fleet_nodes`, `fleet_node_tokens`, `fleet_placements`, `fleet_placement_history`, `fleet_observations`, `fleet_archives`, `fleet_endpoints`, `fleet_events`: read and written only by `infra/fleet`],
  ),
  caption: [Tables by group.],
  kind: table,
)

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Fleet table][Key columns],
    [`fleet_nodes`], [id, name, `region_key`, `api_address`, `edge_host`, `control_host`, `lifecycle` (active, draining, lost, retired), `lost_at`, `lost_reason`, `fenced_by`, certificate pins and expiries (current and next), `machine_id_sha256`, `boot_id`, session ids, `heartbeat_seq`, `last_heartbeat_at`, `runtime_up`, `reconciled`, `health`, capacity, features, issues, labels, `last_probe`, `daemon_version`. Never deleted.],
    [`fleet_node_tokens`], [`token_sha256` (unique), region, labels, `expires_at`, `used_at`, `used_by`, `used_key_sha256` (0043: the key it enrolled, which alone may ask again), `node_id` (re-enrollment), `created_by`.],
    [`fleet_placements`], [`workload` (key), `node_id`, `epoch`, `state` (placing, placed, released, displaced), region, memory, CPU, disk, ports, `handle`, `spec_digest`, `completing` (restore, move, recover), `restore_from`, `desired_power`, `power_changed_at` (0042), `move_requested_at`, `move_to`.],
    [`fleet_placement_history`], [(`workload`, `epoch`), node, reason (placed, restore, move, recover), started, ended, `end_reason` (moved, restored, released, lost, destroyed, refused).],
    [`fleet_observations`], [(`node_id`, `workload`), epoch, `superseded_by`, state, `spec_digest`, last report (with the node's issues for it), `observed_at`, `state_changed_at`. Written only when a report changes.],
    [`fleet_archives`], [id, workload, purpose (snapshot, move), epoch, node, `local_id`, `object_key`, `status` (creating, local, uploading, ready, failed, deleted), `sha256`, size, consistency (quiesced, stopped), captured and uploaded times, attempts, error.],
    [`fleet_endpoints`], [Which control-plane processes serve the node endpoint, seen every 5 s.],
    [`fleet_events`], [kind, node, workload, epoch, data; kept 90 days.],
  ),
  caption: [The fleet's tables. #src("packages/db/src/schema.ts:1168").],
  kind: table,
)

= Protocol operations <a-protocol>

blocklyd's workload API (#src("blocklyd/src/api/mod.rs:460"); full text:
`blocklyd/docs/protocol.md`). Every mutating verb is idempotent and checks its epoch rule:
`Exact` (the current copy only), `Teardown` (any copy, even superseded), `Place` (create or replace;
a newer epoch takes over). A workload made with an epoch refuses a request without one (`428`).

#figure(
  table(
    columns: (1.25fr, auto, 1.7fr),
    table.header[Request][Rule][Notes],
    [`PUT /v1/workloads/{id}`], [Place], [Ensure: create stopped, replace on a new spec or epoch (restart if it ran); `If-Match` / `If-None-Match`; disk floor, ports, image allowlist, memory admission when running.],
    [`POST …/start`], [Exact], [Memory admission; `not_created`, `container_missing`, `port_conflict`.],
    [`POST …/stop`, `…/kill`], [Teardown], [Graceful stop with the spec's signal and grace; kill is SIGKILL.],
    [`DELETE /v1/workloads/{id}?data=keep|delete`], [Teardown], [`delete` needs the confirm header equal to the id; data goes to the trash.],
    [`POST …/fence {currentEpoch}`], [none], [Mark superseded (in memory first), restarts off, stop; data kept.],
    [`POST …/export {url, headers, quiesced, exclude, parts?}`], [Exact], [tar.gz to a presigned PUT; running only when quiesced; disk floor for the spool; over one PUT's limit (`transfer.max_put_mb`) in the `parts` offered, each part's ETag returned, or refused before sending without enough of them.],
    [`POST …/restore {url, sha256?} | {snapshot}`], [Exact], [Stopped only; disk admitted; unpack beside, then one exchange.],
    [`POST …/snapshots {id, quiesced}`], [Exact], [Local copy, FICLONE or copy; same id returns the existing one.],
    [`GET …/snapshots`, `DELETE …/snapshots/{s}`, `POST …/snapshots/{s}/upload`], [none], [List; delete (`snapshot_busy` while uploading); upload as an export does, one at a time per snapshot (`snapshot_busy`).],
    [`POST …/exec {command, timeoutSeconds}`], [Exact], [Running only; `Idempotency-Key`; timeout kills the process tree.],
    [`GET …/logs`, `…/stats`, `/v1/workloads`, `/v1/node`, `/v1/health`], [none], [Reads.],
  ),
  caption: [Operations.],
  kind: table,
)

#figure(
  table(
    columns: (1.4fr, auto, 1fr),
    table.header[Code][Status][Meaning],
    [`invalid_request`], [422 / 400], [Validation, with every field problem at once.],
    [`stale_epoch`, `epoch_ahead`, `superseded`], [409], [Epoch refusals, with the epochs involved.],
    [`epoch_required`], [428], [The workload has an epoch; the request named none.],
    [`insufficient_capacity`, `no_free_ports`], [409], [No memory or no host port.],
    [`insufficient_disk`], [507], [Below the disk floor, or a download that wouldn't fit above it.],
    [`archive_too_large`], [422], [An archive over one PUT's limit with no parts, or too few, offered: refused before anything is sent, with its size.],
    [`not_created`, `not_stopped`, `not_running`, `not_quiesced`, `container_missing`, `port_conflict`, `snapshot_busy`, `no_compute`, `name_taken`], [409], [State conflicts.],
    [`precondition_failed`], [412], [`If-Match` mismatch.],
    [`confirmation_required`], [428], [Data deletion without the confirm header.],
    [`invalid_archive`, `checksum_mismatch`], [422], [A restore refused.],
    [`runtime_unavailable`, `timeout`, `runtime_error`, `transfer_failed`, `internal`], [503, 504, 502, 502, 500], [Docker or transfer failures.],
    [`forbidden`], [403], [A valid certificate for a name not allowed.],
  ),
  caption: [Error codes: the code is the contract. #src("blocklyd/src/api/error.rs:21").],
  kind: table,
)

Features announced (instead of versions): `exec-idempotency-key`, `logs-follow-across-restarts`,
`conditional-put`, `placement-epochs`, `data-transfer`, `local-snapshots`, `export-exclude`,
`execution-lease`, `certificate-renewal`, `resume-after-reboot`, `multipart-upload`. The fleet places
only on nodes with `placement-epochs`, `data-transfer`, `local-snapshots` and `export-exclude`, and
offers parts only to nodes with `multipart-upload`.

= Configuration and environment <a-config>

== Control plane

#block(sticky: true)[Read once at boot, validated, and refused with every problem listed (#src("apps/control/src/config/schema.ts:109")).]

#figure(
  table(
    columns: (1.45fr, 0.85fr, 1.35fr),
    table.header[Variable][Default][Meaning],
    [`DEPLOYMENT_ID`], [required], [`[a-z0-9-]{2,16}`; names apps and resources, cookie prefix.],
    [`ROLES`], [`api,worker,realtime`], [Which roles this process runs.],
    [`DATABASE_URL`, `DATABASE_DIRECT_URL`], [—, = URL], [Pooled and direct (LISTEN, migrations).],
    [`WEB_CANONICAL_ORIGIN`, `WEB_TRUSTED_ORIGINS`], [—, empty], [The web origin; extra trusted origins.],
    [`API_LISTEN`, `INTERNAL_LISTEN`], [`127.0.0.1:4000`, `127.0.0.1:4001`], [Public API; internal listener (edge, operators).],
    [`REALTIME_LISTEN`, `REALTIME_FALLBACK_LISTEN`, `REALTIME_PUBLIC_URL`, `REALTIME_FALLBACK_URL`, `REALTIME_TICKET_SECRET`, `REALTIME_TLS_MODE`], [`:7443`, `:7444`, —, —, —, `pinned`], [WebTransport and WebSocket; TLS pinned, provided or ACME.],
    [`ACME_*`, `CLOUDFLARE_DNS_API_TOKEN`, `CLOUDFLARE_ZONE_ID`], [—], [Let's Encrypt via Cloudflare DNS-01, for realtime.],
    [`PLAY_DOMAIN`, `PLAY_DOMAIN_ALIASES`, `PLAY_PORT`], [—, empty, 25565], [Where players address servers.],
    [`REGIONS`], [required], [`key:Label` pairs; each maps on the default runtime.],
    [`AUTH_SECRET`, `AUTH_GITHUB_*`, `AUTH_GOOGLE_*`, `AUTH_OAUTH_PROXY_SECRET`, `ADMIN_EMAILS`], [—], [Sign-in; OAuth providers optional; bootstrap admins.],
    [`WEB_PROXY_SECRET`], [unset], [The web tier's word on a client's address.],
    [`SMTP_URL`, `MAIL_FROM`], [—], [Email.],
    [`EDGE_TOKEN`], [—], [Shared with the edge.],
    [`RUNTIME_SECRETS_KEY`, `RUNTIME_SECRETS_PREVIOUS_KEYS`], [—, empty], [Versioned key for per-server secrets; rotation.],
    [`RUNTIME_PROVIDER`, `RUNTIME_PROVIDERS`], [`docker`, = default], [Default runtime; every runtime run.],
    [`RUNTIME_REGION_MAP`, `<NAME>_REGION_MAP`], [—], [Product region → provider region. The shared map is the default runtime's alone; every other runtime needs its own, and places only the regions it names.],
    [`OPERATOR_TOKEN`], [unset (off)], [Operator APIs; required with the fleet.],
    [`ARTIFACTS_RUNTIME_FACING_URL`, `ARTIFACTS_MIRROR`], [—, false], [Where game runtimes fetch jars; mirror upstream jars.],
    [`ARCHIVE_S3_ENDPOINT`, `_RUNTIME_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`], [unset (no archives), —, —, `auto`], [The archive store.],
    [`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER`, `POLAR_PRODUCTS`], [unset (no billing)], [`POLAR_SERVER` must be named: `sandbox` or `production`.],
    [`CATALOG_USER_AGENT`], [set], [Names Blockly to the mod catalogs.],
  ),
  caption: [Control-plane settings. #src("apps/control/src/config/load.ts:110").],
  kind: table,
)

#figure(
  table(
    columns: (1.7fr, 1fr, 0.8fr),
    table.header[Variable][Default][Runtime],
    [`FLY_ORG`, `FLY_API_TOKEN`, `FLY_NATS_URL`, `FLY_MACHINE_LIMIT`, `FLY_PLATFORM_MACHINES`], [—, —, `nats://[fdaa::3]:4223`, 50, 7], [Fly (limit − platform ≥ 2).],
    [`BOAT_API_TOKEN`, `BOAT_API_URL`, `BOAT_RUN_TTL_SECONDS`, `BOAT_START_RESERVE`], [—, `https://boat.dev/api/v1`, none, 0.1], [Boat.],
    [`DOCKER_SOCKET`, `DOCKER_GAME_NETWORK`], [`/var/run/docker.sock`, `blockly-games`], [Docker (one region).],
    [`FLEET_CA_CERT`, `FLEET_CA_KEY`, `FLEET_NODE_LISTEN`, `FLEET_ENDPOINT_HOSTS`], [—, —, `[::]:8443`, —], [Fleet trust and endpoint, IPv6 and IPv4.],
    [`FLEET_PLACEMENT`, `FLEET_HEADROOM_MB`, `FLEET_MEMORY_OVERCOMMIT`, `FLEET_CPU_OVERCOMMIT`, `FLEET_CPU_PRESSURE`, `FLEET_DISK_OVERCOMMIT`, `FLEET_CPU_MILLIS_PER_GB`], [`balanced`, 0, 4, 1, 0.8, 1, 250], [Fleet placement.],
    [`FLEET_HEARTBEAT_SECONDS`, `FLEET_LEASE_SECONDS`, `FLEET_SUSPECT_SECONDS`, `FLEET_UNAVAILABLE_SECONDS`, `FLEET_NODE_CERT_DAYS`, `FLEET_RENEW_DAYS`], [5, 120, 15, 45, 30, 10], [Fleet timing and certificates.],
  ),
  caption: [Runtime settings. Not configurable: the edge's 25 s wake wait, boot timeouts (120 s running, 10 min ready), 12 wakes an hour, 10 min host-loss grace.],
  kind: table,
)

== Edge agent

`CONTROL_URL`, `EDGE_TOKEN` (required); `EDGE_ID` (hostname), `ROUTES_POLL_MS` (1000),
`IDLE_HINT_AFTER` (`10m`), `CONNECTION_RATE_LIMIT` (10), `MINECRAFT_PORT` (25565), `AGENT_PORT`
(8090), `NOTICE_PORT` (25564), `SLEEPING_PORT` (25563), `ROUTES_FILE`, `ROUTER_BIN`, and the four
message texts (`ASLEEP_MOTD`, `LOADING_MOTD`, `RESTARTING_MOTD`, `RESTARTING_JOIN`)
(#src("apps/edge/agent.ts:19")).

== blocklyd

#block(sticky: true)[TOML, every table refusing unknown keys (#src("blocklyd/src/config.rs")).]

#figure(
  table(
    columns: (1.5fr, 0.95fr, 1.3fr),
    table.header[Key][Default][Meaning],
    [`deployment_id`, `state_dir`], [required, `/var/lib/blocklyd`], [Containers of other deployments are never touched.],
    [`api.listen`, `api.max_body_bytes`, `api.shutdown_grace_seconds`], [required, 2 MiB, 30], [The mTLS API: a private address, never public.],
    [`ops.listen`], [`127.0.0.1:7070`], [`/healthz`, `/readyz`, `/metrics`; loopback or a private address only, refused otherwise, because it names workloads.],
    [`docker.socket`, `docker.network`, `docker.pull_timeout_seconds`], [default socket, `blockly-workloads`, 1200], [The bridge network is made with inter-container traffic off.],
    [`network.port_range`, `edge_ips`, `control_ips`, `port_quarantine_seconds`], [42000–42999, loopback, loopback, 600], [Never 0.0.0.0 (since `800eca9`).],
    [`workloads.allowed_images`], [`itzg/minecraft-server:` (and `docker.io/…`)], [Prefixes; everything else refused.],
    [`workloads.user`, `data_owner`], [`1000:1000`, = user], [Never uid or gid 0, refused at start; data owner for userns remapping.],
    [`workloads.read_only_rootfs`, `tmp_size_mb`, `default_pids_limit`, `log_max_size_mb`, `log_max_files`, `oom_score_adj`, `trash_retention_hours`, `min_memory_mb`], [true, 256, 4096, 20, 5, 500, 24, 256], [Host policy a request can't relax.],
    [`capacity.reserved_memory_mb`, `allocatable_memory_mb`, `min_free_disk_mb`, `memory_overcommit`, `reserved_cpu_millis`], [2048, none, 5120, 1.0, 1000], [What the host keeps; running memory never overcommitted by default.],
    [`intervals.resync_seconds`, `stats_seconds`, `disk_usage_seconds`], [30, 15, 300], [Reconcile and sampling.],
    [`transfer.max_put_mb`], [5115], [The most one PUT carries, in MiB (R2's 5 GiB less 5 MiB); a larger archive goes in the parts a request offers.],
    [`fleet.url`, `ca`, `enrollment_token_file`, `heartbeat_seconds`, `api_address`, `labels`, `restart_requires_contact_seconds`], [required, required, none, 5, = `api.listen`, {}, 120], [Fleet mode; without `[fleet]` blocklyd is a single-node daemon.],
  ),
  caption: [blocklyd's configuration.],
  kind: table,
)

= Metrics and events <a-metrics>

#figure(
  table(
    columns: (1.7fr, 1fr),
    table.header[blocklyd metric (`/metrics`)][Labels or meaning],
    [`blocklyd_operations_total`, `blocklyd_operation_duration_seconds`], [`op`, `outcome` (ok, refused, full, runtime_unavailable, error)],
    [`blocklyd_http_requests_total`, `blocklyd_auth_failures_total`], [method, route, status; reason],
    [`blocklyd_reconciles_total`, `blocklyd_reconcile_duration_seconds`, `blocklyd_runtime_events_total`], [outcome; —; action],
    [`blocklyd_info`, `blocklyd_uptime_seconds`, `blocklyd_docker_up`], [version, protocol, node, deployment],
    [`blocklyd_workloads`, `blocklyd_ports_allocated`, `blocklyd_ports_capacity`, `blocklyd_issues`], [by state (all 11)],
    [`blocklyd_workload_memory_working_set_bytes`, `…_cpu_cores`, `…_data_bytes`], [per workload],
    [`blocklyd_process_resident_memory_bytes`, `blocklyd_process_cpu_seconds`], [the daemon itself],
    [`blocklyd_heartbeats_total`, `blocklyd_fleet_contact_age_seconds`, `blocklyd_fleet_lease_remaining_seconds`, `blocklyd_certificate_renewals_total`, `blocklyd_snapshot_bytes`], [fleet mode (−1 before first contact or without a lease)],
  ),
  caption: [Node metrics. #src("blocklyd/src/metrics.rs:142").],
  kind: table,
)

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Area][`fleet_events` kinds (47)],
    [Nodes], [`token.created`, `node.enrolled`, `node.enrollment_repeated`, `node.reenrolled`, `node.machine_id_reused`, `node.duplicate_identity`, `node.certificate_issued`, `node.certificate_renewed`, `node.addresses_changed`, `node.daemon_restarted`, `node.rebooted`, `node.health`, `node.draining`, `node.undrained`, `node.lost`, `node.returned_while_lost`, `node.reinstated`, `node.retired`, `node.quarantine_cleared`, `node.labels_changed`],
    [Placements], [`placement.created`, `placement.refused`, `placement.placed`, `placement.adopted`, `placement.rehomed`, `placement.restored`, `placement.released`, `placement.destroyed`, `placement.displaced`, `placement.move_requested`, `placement.move_declined`, `placement.moved_for_room`, `placement.finished_from_report`, `placement.abandoned`],
    [Copies and epochs], [`epoch.adopted`, `epoch.conflict`, `copy.orphaned`, `copy.fenced`, `copy.tidied`, `fork.detected`],
    [Worlds], [`snapshot.local`, `snapshot.uploaded`, `snapshot.upload_failed`, `snapshot.local_trimmed`, `move.exported`, `move.export_superseded`, `recover.older_copy`],
  ),
  caption: [Fleet events: for operators, never read back to decide anything. #src("apps/control/src/infra/fleet/sql.ts:69").],
  kind: table,
)

- *Domain events* (NOTIFY `blockly_events`, hints of at most 8 kB): `server_changed`,
  `operation_progress`, `access_changed`, `backup_changed`, `listing_changed`, `presence`,
  `session_cap`.
- *Audit actions* include `server.runtime_moved`, `server.rebuilt_from_backup`,
  `server.wake_failed`, `server.stray_compute_stopped`, `server.relocation_scheduled`,
  `platform.controls_changed`, `operation.retried`, `operation.discarded`, `console.command`,
  `account.plan_changed`, `billing.checkout_started`, and the subscription changes in
  `app/billing/audit.ts` (`billing.subscribed`, `billing.cancel_scheduled`,
  `billing.subscription_lapsed`, `billing.subscription_ended` and the rest).
- *Admin alerts*: `blocked_operations`, `purge_overdue`, `catalog_stale`, `worlds_outgrow_plan`.

= Benchmarks and measurements <a-bench>

#block(sticky: true)[Every number below came from one machine or one trial; none from production. #research]

#figure(
  table(
    columns: (1.1fr, 1.5fr, 1fr),
    table.header[Where][Measured][Value],
    [Test VM, 4 vCPU, ext4 virtual disk], [Local snapshot of a 1 GB world (full copy, no reflink)], [2.9 s, 378 MB/s],
    [same], [Archive (gzip -1, one thread); move archive without libraries], [14.8 s (73 MB/s); 14.3 s],
    [same], [Restore from archive; from a node snapshot], [10.8 s (100 MB/s); 6.1 s],
    [same], [Heartbeat of a node with 50 servers], [10 ms mean, ~20 ms p99],
    [same], [blocklyd binary; resident memory], [8.3 MB; 7.5–9.5 MiB],
    [Two-node experiment (Docker-in-Docker on one VM)], [Enrollment, token to healthy], [0.9–1.1 s],
    [same], [Move of a 116 MB / 653 MB archive], [11.9 s / 52.6 s],
    [same], [Restore in place (116 MB); rebuild after loss], [1.9 s; 1.2 s plus boot],
    [Single-node VM, Minecraft 1.21.8, 3 GB, 2 CPUs], [First boot to answering; restart to ready], [29.4–37.1 s; 21.3–22.5 s],
    [same], [blocklyd restart to ready (one workload)], [40–45 ms],
    [Boat trial account], [Create to running; join on a sleeping server to running], [34–40 s; ~34 s],
    [same], [Backup; restore in the sandbox], [4.0 s; 27.7–31.4 s],
    [Fly staging], [Volume snapshot point in time], [Not point-in-time: writes 4.1 s after the ask were held; listed 66–70 s later],
    [Fly ams (capacity research)], [5 players spread, perf-1x 4 GB vs perf-2x], [31.4 ms vs 33.8 ms per tick: a second core doesn't help],
  ),
  caption: [Measurements. #src("docs/minecraft-capacity-research.md:138") for the capacity research.],
  kind: table,
)

Not measured: reflink snapshots on a real XFS or btrfs disk, ZFS, density on a candidate dedicated
CPU, wake times on Fly, running admission under real use, bandwidth.

= Test coverage <a-tests>

#figure(
  table(
    columns: (auto, auto, auto, 1fr),
    table.header[Area][Files][≈ Tests][Needs],
    [`apps/control/src/app`], [47], [350], [Postgres for 36 files; S3 for archives and moves],
    [`apps/control/src/infra`], [39], [349], [Fleet 99 (10 files), Fly 64, Boat 47; some need Docker, NATS, Pebble, S3],
    [`apps/control/src/domain`, `minecraft`, `config`, `interfaces`], [29], [305], [Pure],
    [`apps/web`, `apps/edge`], [14], [54], [—],
    [blocklyd (Rust)], [9 + unit], [142], [9 ignored: 8 need Docker and root (all 8 pass with them), 1 benchmark],
  ),
  caption: [Tests by area (TypeScript counts by grep: about 1,058 cases in 129 files). The full TypeScript suite when this was written: 1,043 passed, 28 skipped, 0 failed.],
  kind: table,
)

#figure(
  table(
    columns: (auto, 1fr, auto),
    table.header[Suite][Proves][In CI],
    [`fleet-runtime.e2e.test.ts` (11)], [The production adapter against a real blocklyd: mTLS enrollment, placement, snapshot and restore through a real S3, a world over the node's one-PUT limit uploaded and exported in parts, adoption, SIGKILL of the daemon leaves the server running, re-enrollment, a lost node fenced, the operator API.], [yes (`blocklyd` workflow)],
    [`fleet-two-node.e2e.test.ts` (7)], [Two nodes (Docker-in-Docker): operator move, drain, move for room, rebuild after loss, the lost node's copy fenced and the fork reported. "Tests the fleet's logic, not hardware failure."], [no: needs root and dind],
    [`hybrid.test.ts` (15)], [Rules, allowlist, fallback, canary off, moves both ways through real S3, a failed move, overflow and its lack of fallback, a resting world holding no machine.], [yes],
    [blocklyd `tests/*`], [Lifecycle, epochs, resume, reconcile, transfer, mTLS; Docker hardening as seen from inside a container.], [yes (unprivileged, then Docker tests as root)],
    [Manual], [`smoke`, `staging-check`, `staging-waits`, `snapshot-probe`, the capacity harness.], [no],
  ),
  caption: [End-to-end evidence.],
  kind: table,
)

CI: `ci.yml` (lint, typecheck, boundaries, deprecated APIs, Terraform validate, OpenAPI drift, the
whole `bun test` against Postgres, NATS, S3 and Pebble); `blocklyd.yml` (`check`, `supply-chain`,
`fleet-e2e`, `release`). Never tested: independent hosts, real reboots and
power fencing, reflink on a real disk, ZFS, cgroup v1 vs v2 differences beyond CI's runner, IPv6
publishing, user namespaces.

= Glossary <a-glossary>

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Term][Meaning here],
    [Admission (running)], [Only servers that run, start or are being made hold a node's memory and CPU; a sleeping one holds disk.],
    [Archive], [A gzip tarball of a world in the archive store; the format every runtime reads.],
    [Archive store], [The S3-compatible bucket (R2, Tigris, RustFS): backups' durable copies, resting worlds, moves.],
    [Binding], [`server_runtimes`: which runtime a server is on, and its handle.],
    [Canary], [A placement rule (or explicit moves) sending some new servers to a non-default runtime.],
    [Copy], [One node's container and data for a server at one epoch.],
    [Displaced], [A placement whose node an operator declared lost; it will be rebuilt.],
    [Drain], [A node takes no new placements; its servers move as they can.],
    [Edge], [mc-router and its agent: the only public Minecraft address.],
    [Epoch], [A per-server number that rises with every new home and is never reused.],
    [Execution lease], [How long after a heartbeat a node may restart or resume on its own (120 s).],
    [Fence], ["This server is at epoch N": an older copy is stopped and never runs again. Logical (by message) or physical (by the operator).],
    [Fork], [A lost node's copy reported when the node returns; kept for the owner to judge.],
    [Handle], [An opaque string a runtime issues for a server's compute.],
    [Headroom], [Memory kept free on every node for restores and moves (`FLEET_HEADROOM_MB`, 0).],
    [Health], [Derived from heartbeat age: healthy, degraded, suspect (15 s), unavailable (45 s). Never "lost".],
    [Included hours], [Units of play a plan includes (Free 20, Plus 60); 8 GB servers use two an hour.],
    [Lifecycle (node)], [active, draining, lost, retired: an operator's statement.],
    [Lost], [An operator's statement that a host is stopped and stays stopped.],
    [Moved for room], [A waking server moved to a node with room before it starts.],
    [`NOWHERE`], [`0.0.0.0:0`, the route of a sleeping server whose address isn't stable.],
    [Operation], [A unit of infrastructure work for one server, queued in order and retried.],
    [Overcommit], [`FLEET_MEMORY_OVERCOMMIT` (4): placed memory per node; blocklyd's `memory_overcommit` (1.0): running memory.],
    [Park], [Boat: wake a sleeping sandbox only for work, with a short time to live.],
    [Placement], [Fleet: choosing a node. Runtimes: choosing a runtime for a new server.],
    [Quarantine], [A node with two hosts beating as one; or a released port resting 600 s.],
    [Reconstructible], [Files the image remakes (jar, libraries), left out of moves.],
    [Relocation], [Moving a server: region, node, host loss, or runtime.],
    [Rest (stored)], [A world kept only in the archive store, with no compute or disk.],
    [`RuntimeFull`], [A runtime has no room just then; the server goes back to sleep.],
    [Snapshot], [A point-in-time copy of a world taken by its runtime.],
    [Superseded], [A copy a newer epoch replaced.],
    [Upkeep], [FleetRuntime's minute job: health, uploads, tidying.],
    [Wake], [A join on a sleeping server starts it, policy-checked, waited for up to 25 s.],
  ),
  caption: [Words this document uses.],
  kind: table,
)
