#import "../style.typ": *

#part("Orientation", [What Blockly is, the map of the whole system, and where its code lives.])

= Executive overview <s-overview>

Blockly is Minecraft server hosting that feels simple. A player names a server, picks what to play,
invites friends, and plays; everything else is Blockly's to decide. That rule shapes the
architecture: Blockly absorbs complexity so the player doesn't have to, and asks only about what
the player alone knows, what is destructive or one-way, money, and who can reach the server
(#src("CLAUDE.md")).

*The system in seven sentences.*

+ A *control plane* (TypeScript, one image in three roles: `api`, `worker`, `realtime`) owns every
  server's desired state in Postgres and is the only writer of it.
+ Owners act through a *web app* (Next.js) that calls the control plane's tRPC API; every change
  that touches infrastructure becomes an *operation* on a per-server FIFO queue, run by workers.
+ Workers reach compute only through *one port*, `MinecraftRuntime`. Behind it sit adapters for Fly
  Machines, Boat sandboxes, Blockly's own *fleet* of machines, local Docker, and a fake for tests.
+ Players connect to one *edge* (mc-router with a small agent) that routes each server's hostname
  to wherever it runs, answers for sleeping servers, and wakes them on join.
+ Worlds live on the runtime's disk while a server runs, with *durable copies* in an S3-compatible
  archive store; idle worlds rest there with no compute at all.
+ The fleet runtime drives *blocklyd*, a small Rust daemon on each machine, over mutual TLS, with
  placement epochs, fences and an execution lease instead of a cluster.
+ Money is plans with included hours, billed through Polar; extra paid hours are deferred.

#figure(
  table(
    columns: (1.3fr, 1fr, 2.2fr),
    table.header[Part][Status][In one line],
    [Control plane, web, edge, Fly runtime], [#implemented], [What staging runs (made by `scripts/staging.ts` on Fly) and what the production Terraform configures (`RUNTIME_PROVIDER=fly`).],
    [Boat runtime], [#implemented], [Configured in no environment; ready for an internal canary, not paying players (@s-boat).],
    [Several runtimes at once, the canary], [#implemented], [Opt-in: nothing is configured to use it.],
    [Fleet runtime and blocklyd], [#implemented #canary], [Tested end to end on one VM; never run on independent machines.],
    [Running admission], [#implemented], [Sleeping fleet servers hold no node memory.],
    [Automatic failover, provider fencing, cost-aware placement], [#deferred], [Deliberately not built; the reasons are in @s-split-brain and @s-placement.],
    [ZFS snapshots], [#research], [Evaluated, not adopted (@s-storage).],
  ),
  caption: [Where things stand at the commit this document was rendered from. The full table is @s-status.],
  kind: table,
)

*Decisions that explain the rest.*

- *A server is not a machine.* The server (name, world, settings, plan) is a durable record; compute
  comes and goes behind a handle. Sleep, wake, moves and provider changes are all just compute
  changing under a server that stays (@s-runtime-port).
- *One writer of intent.* Only the control plane decides what should run; providers, nodes and the
  edge report and obey. The exceptions are bounded: Fly and fleet nodes restart a crashed server
  (three tries; a node only under its lease, @s-lease), and Boat stops a parked sandbox when its
  time to live ends.
- *No cluster.* The fleet has no quorum, consensus store, scheduler cluster or distributed
  filesystem. Correctness comes from epochs (a node refuses stale orders) and from an operator's
  physical fence before a host is declared lost (@s-epochs).
- *Cheap idle.* Plans let a server run 3–8% of a month, so the architecture optimises for servers
  that sleep: sleeping costs disk or object storage, never memory (@s-capacity, @s-runtime-choice).

#caveat[*What this document is not.* It is not a promise that unbuilt parts will be built; status
labels say what exists. Numbers marked as measured come from a single test VM, a Boat trial account
or Fly staging, never from production traffic: Blockly has none yet (@s-limits).]

= System map <s-system-map>

Every running part and what talks to what. Each box is detailed later; the trust boundaries
between them are in @s-topology.

#fig(draw(
  spacing: (11mm, 10mm),
  who((0, 0), [Owner\ (browser)], name: <owner>),
  cp((1.15, 0), [Web app\ #text(size: 6.4pt)[Next.js]], name: <web>),
  cp((2.45, 0.6), [Control plane\ #text(size: 6.4pt)[`api`: tRPC, auth, webhooks,\ internal listener\ `worker`: operations, sweeps\ `realtime`: live hints]], name: <cp>),
  st((3.9, 0), [Postgres], name: <pg>),
  ext((3.9, -0.95), [Polar · SMTP ·\ Modrinth · Mojang], name: <ext>),
  ext((3.9, 1.15), [Fly · Boat APIs], name: <prov>),
  who((-0.15, 2.2), [Player\ (Minecraft)], name: <player>),
  rt((0.95, 2.2), [Edge\ #text(size: 6.4pt)[mc-router + agent]], name: <edge>),
  rt((2.45, 2.2), [Game servers\ #text(size: 6.4pt)[Fly · Boat · fleet nodes]], name: <servers>),
  st((3.9, 2.2), [Archive store\ #text(size: 6.4pt)[S3-compatible]], name: <s3>),
  edge(<owner>, <web>, "-|>"),
  edge(<web>, <cp>, "-|>", lbl[`/api`]),
  edge(<cp>, <owner>, "--|>", bend: -38deg, lbl[live hints]),
  edge(<cp>, <pg>, "-|>"),
  edge(<cp>, <ext>, "-|>"),
  edge(<cp>, <prov>, "-|>", lbl[runtime port], label-side: left),
  edge(<prov>, <servers>, "-|>"),
  edge(<cp>, <servers>, "-|>", lbl[RCON; mTLS\ to nodes]),
  edge(<player>, <edge>, "-|>"),
  edge(<edge>, <servers>, "-|>", lbl[game traffic], label-side: right),
  edge(<edge>, <cp>, "--|>", lbl[routes, wake], label-side: left),
  edge(<servers>, <s3>, "--|>", lbl[archives]),
), caption: [The system. People in italics; control plane rounded; runtime and hosts square; storage cylinders; external providers dashed.], name: "fig-system")

#figure(
  table(
    columns: (auto, 1.4fr, 1fr),
    table.header[Part][Does][Where it runs],
    [Web app (`apps/web`)], [Owner and admin UI; proxies `/api/*` to the control plane so cookies stay host-only.], [Production: Vercel; staging: a standalone image on Fly],
    [Control plane (`apps/control`)], [`api`: tRPC, auth, public status, webhooks, the internal listener for the edge and operators; `worker`: operations and every scheduled sweep; `realtime`: WebTransport and WebSocket hints to browsers.], [Fly: `api` and `worker` are process groups of one app; `realtime` is its own app],
    [Postgres], [All durable state: servers, operations queue (pg-boss), events (NOTIFY), billing, fleet tables.], [Production: Fly Managed Postgres, made by hand; staging: a Postgres 17 machine on Fly],
    [Edge (`apps/edge`)], [The only public Minecraft address: routes by hostname, answers pings for sleeping servers, wakes on join.], [Its own Fly app],
    [Runtimes], [Run the game servers: Fly Machines (default), Boat sandboxes, fleet nodes with blocklyd, local Docker.], [Per runtime],
    [Archive store], [Backups' durable copies, resting worlds, moves between runtimes and nodes.], [Production: Cloudflare R2; staging: Tigris; local: RustFS],
  ),
  caption: [The parts in one table.],
  kind: table,
)

= Repository and module map <s-modules>

One repository: a Bun workspace (TypeScript) plus one Rust crate.

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Path][What it is],
    [`apps/control`], [The control plane: Node 22 runs the TypeScript sources directly; Hono, tRPC, pg-boss, Drizzle, Better Auth.],
    [`apps/web`], [Next.js web app; imports only *types* from the control plane (`AppRouter`) and contracts.],
    [`apps/edge`], [The edge agent (Bun, compiled) that supervises `itzg/mc-router` and speaks the edge protocol.],
    [`apps/blocklyd`], [The fleet's node daemon, Rust.],
    [`apps/devtools`], [A local-only inspector (`bun run devtools`); never shipped.],
    [`packages/contracts`], [Zod schemas, view types, error codes, the realtime and edge protocols: what crosses process boundaries.],
    [`packages/db`], [Drizzle schema (52 tables), 43 SQL migrations, the migrator.],
    [`infra/fly`, `infra/terraform`], [Fly app configs; Terraform modules (archive, control, dns, edge, fly-org, web) and the two environments.],
    [`scripts/`], [Operator and check scripts: boundaries, staging, smoke, `fleet.ts` and `runtimes.ts`, the fleet's price catalog, this document's build.],
    [`tools/openapi`], [Vendored OpenAPI specs for Fly, Boat and Modrinth, and their generated clients.],
    [`docs/`], [Design documents, operator runbooks and research.],
  ),
  caption: [Top-level layout.],
  kind: table,
)

Inside the control plane, layers are enforced by `scripts/check-boundaries.ts`, run in CI. An
arrow means "may import".

#fig(draw(
  spacing: (8mm, 9mm),
  cp((1, 0), [`main.node.ts`\ #text(size: 6.4pt)[composition root]], name: <main>),
  cp((0, 1.1), [`interfaces`\ #text(size: 6.4pt)[http · trpc · edge · operator]], name: <if>),
  cp((2, 1.1), [`infra/<adapter>`\ #text(size: 6.4pt)[19 adapters]], name: <infra>),
  cp((3.2, 1.1), [`config`], name: <config>),
  cp((0, 2.2), [`app`\ #text(size: 6.4pt)[services · operations · schedules]], name: <app>),
  cp((2, 2.2), [`app/ports`\ #text(size: 6.4pt)[runtime, jobs, events, …]], name: <ports>),
  cp((0, 3.3), [`minecraft`\ #text(size: 6.4pt)[pure translation]], name: <mc>),
  cp((1.4, 3.3), [`domain`\ #text(size: 6.4pt)[pure model]], name: <domain>),
  edge(<main>, <if>, "-|>"), edge(<main>, <infra>, "-|>", lbl[41]), edge(<main>, <config>, "-|>"),
  edge(<if>, <app>, "-|>", lbl[44]),
  edge(<infra>, <ports>, "-|>", lbl[55: types,\ declared errors]),
  edge(<config>, <ports>, "-|>"),
  edge(<app>, <ports>, "-|>", lbl[114]),
  edge(<app>, <mc>, "-|>", lbl[79]),
  edge(<app>, <domain>, "-|>", lbl[140]),
  edge(<mc>, <domain>, "-|>", lbl[16]),
  edge(<ports>, <domain>, "-|>"),
), caption: [Control-plane layers and measured import counts (production files). No adapter imports another adapter; only `main` imports adapters. #src("scripts/check-boundaries.ts:133").], name: "fig-modules")

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Rule][Enforced by `check-boundaries.ts`],
    [`domain`, `minecraft`], [Pure: no packages at all; `minecraft` may use runtime *types* only.],
    [`app`], [Only `@blockly/db`, `@blockly/contracts`, `drizzle-orm`, `zod`, `node:*`; never a provider SDK.],
    [`infra/<x>`], [Only port types, declared errors and `as const` vocabularies, and itself: no cross-adapter imports. Provider SDKs only in their adapter (`@aws-sdk` in `infra/s3`, `@polar-sh` in `infra/polar`, …).],
    [Above the port], [No runtime provider names (collected from the adapters' `provider` fields), no hostnames, no `25565`, no hostname-shaped columns.],
    [`apps/web`], [Only types from `@blockly/control`; never `@blockly/db`.],
  ),
  caption: [The layering rules that keep providers swappable. #src("scripts/check-boundaries.ts:8").],
  kind: table,
)

Between packages, imports run one way, toward the shared contracts and schema:

#fig(draw(
  spacing: (15mm, 10mm),
  rt((0, 0), [`apps/edge`\ #text(size: 6.4pt)[agent]], name: <edge>),
  cp((1, 0), [`apps/web`\ #text(size: 6.4pt)[Next.js]], name: <web>),
  cp((2, 0), [`apps/control`\ #text(size: 6.4pt)[control plane]], name: <control>),
  rt((3, 0), [`apps/blocklyd`\ #text(size: 6.4pt)[Rust]], name: <bd>),
  cp((1, 1), [`packages/contracts`\ #text(size: 6.4pt)[schemas · views · protocols]], name: <contracts>),
  st((2, 1), [`packages/db`\ #text(size: 6.4pt)[schema · migrations]], name: <db>),
  edge(<edge>, <contracts>, "-|>", lbl[types:\ edge protocol], label-side: right),
  edge(<web>, <contracts>, "-|>", lbl[49 files], label-side: left),
  edge(<web>, <control>, "-|>", lbl[types only:\ `AppRouter`], label-side: left),
  edge(<control>, <contracts>, "-|>"),
  edge(<control>, <db>, "-|>", lbl[125 imports], label-side: left),
  edge(<control>, <bd>, "--", lbl[HTTP only], label-side: left),
), caption: [Package dependencies. `packages/contracts` depends only on `zod`; `packages/db` only on
  `drizzle-orm` and `pg`. blocklyd shares no code with the TypeScript packages: it and the control
  plane speak HTTP.], name: "fig-packages")

- `apps/blocklyd` shares no code with the TypeScript side: the contract is its HTTP protocol
  (`apps/blocklyd/docs/protocol.md`) and the wire types mirrored in
  `apps/control/src/infra/fleet/wire.ts`.
- `infra/fleet` is the one adapter that owns database tables (`fleet_*`), read and written only by
  it.

#why[The layering exists so that a provider is an adapter and nothing else: no Fly name, hostname
or port number can leak upward, so swapping or adding a runtime never touches the product code. It
is checked mechanically because review alone lets such leaks in one convenience at a time.]
