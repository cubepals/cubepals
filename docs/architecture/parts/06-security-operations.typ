#import "../style.typ": *

#part("Security and operations", [What is protected and from whom, what operators can see and do,
  where everything is deployed, and what happens when each part fails.])

= Security model <s-security>

Who can do what, at each boundary, and how far isolation really goes. #implemented unless marked.

#figure(
  table(
    columns: (1fr, 1.6fr),
    table.header[Boundary][Authentication],
    [Browser → web → control API], [Better Auth: email and password (10 characters minimum, verification email, 1-hour reset links), optional Google and GitHub; session cookie host-only on the web origin. tRPC mutations refuse cross-site requests and untrusted origins. Admins are rows in `platform_admins`; non-admins get `NOT_FOUND`. No 2FA or passkeys.],
    [Browser → realtime], [`Origin` must be a web origin, plus a 60-second ticket (JWT) for this deployment.],
    [Edge → control (internal listener)], [Shared `EDGE_TOKEN`, compared in constant time; reachable only on the private network.],
    [Operators → control (internal listener)], [One shared `OPERATOR_TOKEN`; the operator's name is the self-declared `x-operator` header. Off unless set; set in no environment.],
    [Game runtimes → artifacts], [A per-server token derived from the runtime key, plus a hash the file must match.],
    [Polar → billing webhook], [Polar's signature (`whsec_…`).],
    [Control ↔ fleet nodes], [Mutual TLS 1.3 under a per-deployment CA: one-time enrollment token, then pinned node certificates (30 days); the control plane's client certificate lasts 2 days, renewed daily (@s-enroll).],
    [Public → edge], [None by design: anyone may connect. Wakes are bounded by a quota (12 an hour per server) and a 5-minute probation; mc-router's connection rate limit is global.],
  ),
  caption: [Authentication at each boundary.],
  kind: table,
)

*Isolation, as it is* (no more than the code does):

#figure(
  table(
    columns: (auto, 1fr, 1fr),
    table.header[Runtime][What separates servers][What doesn't],
    [Fly], [Each server is its own Fly app on its own private network; no public address; reached only through Flycast from the org network; RCON only there. Fly's VM isolation.], [Relies on Fly's documented behaviour; the edge and control plane share the org network.],
    [Fleet], [A container per server: a numeric user, never root (blocklyd refuses to start with uid or gid 0 for workloads or their data), every capability dropped, `no-new-privileges`, read-only root filesystem (host default), private IPC, PID limit, hard memory limit without swap, logs bounded, a bridge network with inter-container traffic off, ports only on configured addresses. A request cannot relax host policy.], [*Containers share the host's kernel*: a kernel exploit from a plugin or mod escapes. No seccomp or AppArmor profile beyond Docker's defaults; no user namespaces; egress open; cloud metadata and host addresses not blocked; no CPU quota; no disk quota.],
    [Boat], [A VM per server.], [The game port is public over IPv6, bypassing the edge (@s-boat).],
    [Docker (local)], [Containers on a network only the edge joins.], [Development only.],
  ),
  caption: [Isolation per runtime. #src("blocklyd/src/runtime/docker.rs:138"), #src("apps/control/src/infra/fly/fly-runtime.ts:930").],
  kind: table,
)

- *Reading worlds safely.* blocklyd reads a world as root, so every walk opens each directory
  relative to its parent with `O_NOFOLLOW`, never follows a link, skips entries swapped mid-walk,
  never opens a FIFO or device, and cuts a file that changes to the size its header states; a race
  test swaps continuously while walking (#src("blocklyd/src/tree.rs:92")).
- *A node's own surfaces.* Its API asks every caller for a certificate under the fleet CA. Its ops
  listener (health, metrics naming every workload) asks for none, so blocklyd refuses to start
  with it bound anywhere but loopback or a private address
  (#src("blocklyd/src/config.rs:513")). An enrollment answer must name the CA the node was
  provisioned with, or the node writes no identity (#src("blocklyd/src/fleet/enroll.rs:94")).
- *Secrets.* Per-server secrets (RCON passwords, artifact tokens) are derived from a versioned key,
  never stored. On Fly they are app secrets, never in a machine's config. On a node they exist only
  in Docker's container config, never in records, logs or answers.

#caveat[*Known exposures*, stated so nobody overclaims. The realtime app holds every control-plane
secret, and every role builds every runtime's client at boot. The control API is public on
`*.fly.dev` (game runtimes and Polar need it), not gated to the web tier. Operator actions are
attributed by a self-declared header under one shared token. Fleet servers have no CPU ceiling
(@s-capacity). gVisor or microVMs for stronger isolation are #designed only
(#src("docs/fleet.md:453")).]

= Observability <s-observability>

There is no metrics pipeline in the control plane; answers are durable rows read with SQL
(#src("docs/metrics.md:3")). #implemented

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Signal][What and where],
    [Health], [`GET /api/health` (Fly checks it every 15 s); TCP checks on edge and realtime; blocklyd `/healthz` and `/readyz` (Docker up and reconciled).],
    [Operations], [`server_operations`: kind, status, step, the owner's error words and the operator's detail, per operation.],
    [Audit], [`audit_log`: every privileged action and platform decision (`server.runtime_moved`, `server.rebuilt_from_backup`, `platform.controls_changed`, …).],
    [Runs and play], [`power_intervals` (with runtime and `woken`), `server_usage_days`, presence tables.],
    [Placement], [`runtime_decisions`: every placement, fallback and move with what was considered.],
    [Fleet], [`fleet_events` (47 kinds, kept 90 days; @a-metrics); `/fleet/v1/summary`; node views with memory running, placed and observed.],
    [Live hints], [The `blockly_events` NOTIFY channel → realtime → browsers.],
    [Alerts], [Admin alerts (`blocked_operations`, `purge_overdue`, `catalog_stale`, `worlds_outgrow_plan`): live in admin and emailed once. No fleet alerts: the watch list in `docs/fleet-operations.md` is #designed.],
    [Nodes], [blocklyd `/metrics` (OpenMetrics, 24 families, loopback by default): operations, HTTP, auth failures, reconciles, workloads by state, per-workload memory, CPU and disk, heartbeats, contact age, lease left, renewals, snapshot bytes.],
    [Logs], [Control plane: plain lines to stdout. Game logs through each runtime's log source (Fly NATS, Docker, blocklyd NDJSON, Boat exec).],
  ),
  caption: [What can be seen.],
  kind: table,
)

#why[A young product has more questions than dashboards; durable columns answer any question
later, with SQL, without deciding up front what to count. The cost is that nothing pages anyone:
the fleet's alerts are a list in a runbook, not code.]

= Operator workflows <s-operators>

Everything an operator does goes through a script or the admin UI. #implemented

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Command][Does],
    [`bun scripts/staging.ts up | start | stop | status | env`], [Make and deploy staging, start it, stop every machine (and say so), show it, write cloud credentials. `down` destroys everything, and is only for retiring staging.],
    [`bun scripts/staging-check.ts [--keep]`], [One Free server through its whole life on staging, timed.],
    [`bun run smoke`], [The product end to end on the local stack.],
    [`bun scripts/runtimes.ts …`], [`summary`, `rules`, `rule add|set|on|off`, `where <server>`, `move <server>… --to <runtime>`, `stay`, `report`.],
    [`bun scripts/fleet.ts …`], [`ca`, `token <region> | --node <node>`, `nodes`, `node`, `label`, `drain`, `undrain`, `lost --fenced-by --reason [--force]`, `reinstate`, `retire`, `clear-quarantine`, `placements`, `placement`, `move [--to]`, `events`, `summary`.],
    [`bun scripts/architecture.ts`], [Renders this document.],
    [Admin UI], [Accounts (suspend, plan, limits, admins), servers across providers, platform kill switches and caps, stuck operations (retry, discard), audit log, reports, trusted mods, curated packs.],
  ),
  caption: [Operator entry points. #src("scripts/fleet.ts:1"), #src("scripts/runtimes.ts:1"), #src("scripts/staging.ts:1").],
  kind: table,
)

Fleet runbooks live in `docs/fleet-operations.md`: a new deployment, adding a node, day to day, a
node that stops answering, declaring a node lost, a lost node coming back, retiring, certificates,
upgrading blocklyd (replace the binary and restart: servers keep running), disk, two hosts with one
identity.

*A restored database keeps the copies it doesn't know.* A copy whose server the database doesn't
know is fenced, kept and reported (`copy.orphaned`), and the hourly `orphans` sweep logs it each
time it sees it, for an operator, and never destroys it: after Postgres is restored from a backup,
that is every server made since, and a destroyed world can't be brought back
(#src("apps/control/src/app/operations/schedules.ts:808")). Only a copy whose server was purged is
destroyed, into the node's `trash/` for 24 hours.

= Deployment topology and trust boundaries <s-topology>

As configured in the repository: production in Terraform, staging by script. #implemented as
configuration; production's application status unknown.

#fig(draw(
  spacing: (8mm, 9mm),
  who((0, 0.5), [Internet], name: <net>),
  cp((1.4, 0), [Web\ #text(size: 6.4pt)[Vercel]], name: <web>),
  cp((2.8, 0), [`control` app\ #text(size: 6.4pt)[api ×2 · worker]], name: <ctl>),
  cp((4.2, 0), [`realtime` app\ #text(size: 6.4pt)[UDP/TCP 443]], name: <rt>),
  rt((1.4, 1.2), [`edge` app\ #text(size: 6.4pt)[TCP 25565, v4 + v6]], name: <edge>),
  rt((2.8, 1.2), [One app per server\ #text(size: 6.4pt)[own network, Flycast only]], name: <games>),
  ..zone((<ctl>, <rt>, <edge>, <games>), [Fly org: private network (6PN)], name: "fly"),
  st((5.5, 0), [Postgres\ #text(size: 6.4pt)[Fly Managed]], name: <pg>),
  st((5.5, 1.2), [R2 · DNS\ #text(size: 6.4pt)[Cloudflare]], name: <cf>),
  ext((4.2, 2.3), [Polar · SMTP ·\ Modrinth · Mojang], name: <ext>),
  rt((1.4, 2.3), [Fleet nodes\ #text(size: 6.4pt)[mTLS to the control plane;\ private network: not built]], name: <nodes>),
  edge(<net>, <web>, "-|>"), edge(<net>, <edge>, "-|>"),
  edge(<web>, <ctl>, "-|>", lbl[`/api`]),
  edge(<edge>, <ctl>, "--|>", lbl[internal 4001]),
  edge(<edge>, <games>, "-|>"),
  edge(<ctl>, <pg>, "-|>", bend: -20deg),
  edge(<ctl>, <ext>, "-|>"),
  edge(<edge>, <nodes>, "..|>"),
  edge(<ctl>, <nodes>, "..|>"),
), caption: [Production as configured (`infra/terraform`). Staging differs: web on Fly, a Postgres machine, Tigris, nip.io play addresses. Dotted: designed, not built.], name: "fig-topology")

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Holder][Secrets (names only)],
    [`control` and `realtime` apps], [Every control-plane secret: database URLs, `AUTH_SECRET`, OAuth clients, `WEB_PROXY_SECRET`, `REALTIME_TICKET_SECRET`, `EDGE_TOKEN`, `RUNTIME_SECRETS_KEY`, `FLY_API_TOKEN`, `SMTP_URL`, archive keys, Polar token and webhook secret, `CLOUDFLARE_DNS_API_TOKEN`; and when used, `BOAT_API_TOKEN`, `FLEET_CA_KEY`, `OPERATOR_TOKEN`.],
    [`edge` app], [`CONTROL_URL`, `EDGE_TOKEN`.],
    [Web (Vercel)], [`WEB_PROXY_SECRET`.],
    [A server's Fly app], [Its own per-server secrets, as app secrets.],
    [A fleet node], [The fleet CA's certificate (public) and a one-time token; never the operator token.],
  ),
  caption: [Where secrets live. #src("infra/terraform/modules/control/main.tf:63").],
  kind: table,
)

- *Roles, not services.* One control-plane image in three roles; `api` and `worker` are process
  groups of one Fly app (migrations run as its `release_command` before any machine takes the
  image); `realtime` is its own app because public ports belong to an app and both HTTPS and the
  WebSocket fallback need TCP 443.
- *One Fly org per environment*, because Fly's private network and billing are per org.
- *Game servers reach the control plane only through the public artifact endpoint*: their app
  networks have no route to the org network.
- *No deploy pipeline.* Deploys are `fly deploy` and Terraform by hand, the staging script, and
  Vercel's git integration.

= Failure matrix <s-failures>

What fails, what players see, and what recovers it. "Auto" means without a person.

#figure(
  table(
    columns: (0.8fr, 1.45fr, 1.75fr),
    table.header[What fails][Effect][Recovery],
    [A game server crashes], [Players disconnected.], [Auto: Fly restarts it (on-failure ×3); a fleet node restarts it under its lease (3 tries, backoff), or reports why it didn't (`insufficient_capacity`); reconcile marks it `stopped{crash}` after that, with an out-of-memory kill noted.],
    [A worker dies mid-operation], [The operation stalls.], [Auto: pg-boss retries (per kind); operations are convergent; per-server FIFO keeps order. A blocked key is retried or discarded by an admin.],
    [Control plane down], [No starts, stops or changes; running servers keep running; the edge keeps its last routes; nodes restart nothing unasked after 120 s.], [Auto when it returns: reconcile, heartbeats resync everything.],
    [Postgres down], [The control plane can't act.], [Restore from the provider's backups; a restored database adopts newer node epochs and fences copies it doesn't know (@s-epochs), which the hourly sweep keeps and logs for an operator (@s-operators).],
    [Edge down], [Nobody can join; running sessions through it drop.], [Fly restarts the machine; production runs two.],
    [blocklyd crashes], [Nothing: servers aren't its children.], [Auto: it reconciles from disk and Docker in about a second; nothing that died meanwhile is restarted.],
    [Docker restarts on a node], [With `live-restore`, nothing; without, servers stop.], [Reported, not restarted.],
    [A node reboots], [Its servers stop.], [Auto: resumed once a lease is held, fences first.],
    [A node is silent], [No new placements; its servers read `unknown`.], [Operator (@s-node-loss).],
    [A node is gone for good], [Its servers are down.], [Operator fences and declares it lost; auto rebuild after 10 min from the newest uploaded snapshot; play since then is lost.],
    [A partition hides a live node], [Its players keep playing.], [Don't declare it lost (@s-split-brain).],
    [Disk full on a node], [Creates, snapshots, exports and restores refused (`507`), a URL restore also when its download wouldn't fit; running servers untouched.], [Operator frees space; placement avoids the node.],
    [Archive store down], [Snapshots stay local; moves, rebuilds, rests and wakes from rest wait.], [Auto: uploads retry each minute (5 tries per snapshot); a rest that failed is tried again a day later.],
    [A provider is full], [`RuntimeFull`: a start goes back to sleep; a new server a rule placed falls back once to the default; a move or rebuild is refused before anything stops, and the server stays as it was.], [Auto on the next join or press; the relocation sweep asks for a move again once there is room.],
    [Boat out of starts], [Wakes refused until the window resets.], [Auto, later.],
  ),
  caption: [Failures and recoveries. #src("docs/fleet.md:387"), #src("apps/control/src/app/operations/runner.ts:86").],
  kind: table,
)
