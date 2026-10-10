#import "../style.typ": *

#part("Network and providers", [How players reach a server, which providers sit under which
  runtime, what Boat is today, what running machines directly means, how to choose between them,
  and the canary that compares them.])

= Edge routing <s-edge>

Players reach every server through one edge: `itzg/mc-router` 1.47.1 and a small agent (TypeScript,
compiled with Bun) in one image, the only public Minecraft address. The agent is the only code that
knows mc-router exists (#src("apps/edge/agent.ts:1")). #implemented

#fig(draw(
  spacing: (16mm, 10mm),
  who((0, 0), [Player], name: <p>),
  ext((1, 0), [DNS\ #text(size: 6.4pt)[`*.play.…` A/AAAA]], name: <dns>),
  rt((2, 0), [mc-router\ #text(size: 6.4pt)[routes by hostname]], name: <mr>),
  rt((3, 0), [Server\ #text(size: 6.4pt)[Fly · fleet node · Boat]], name: <srv>),
  rt((2, 1), [Edge agent\ #text(size: 6.4pt)[routes file · notices · webhooks]], name: <agent>),
  cp((3, 1), [Control plane\ #text(size: 6.4pt)[internal listener `/edge/v1`]], name: <cp>),
  edge(<p>, <dns>, "-|>"),
  edge(<dns>, <mr>, "-|>", lbl[TCP 25565], label-side: left),
  edge(<mr>, <srv>, "-|>", lbl[running:\ splice], label-side: left),
  edge(<mr>, <agent>, "-|>", lbl[asleep: notice;\ join: wake], label-side: right),
  edge(<agent>, <cp>, "--|>", lbl[`GET routes`\ every 1 s], shift: 3pt, label-side: left),
  edge(<agent>, <cp>, "-|>", lbl[`POST wake`], shift: -3pt, label-side: right),
), caption: [The player's path. Routes are pulled, never pushed: every edge converges and a restart loses nothing. #src("apps/edge/agent.ts:44").], name: "fig-edge")

*Addressing.* A server is `<slug>.<PLAY_DOMAIN>` (port omitted at 25565). Nothing hostname-shaped is
stored: addresses are the slug plus configuration, so a domain move is a config change with the old
domain kept as an alias until joins to it stop (`play_domain_joins`). SRV records are not used: they
rewrite the handshake hostname, which is what the edge routes on.

*Routes.* `GET /edge/v1/routes` answers every server with a handle whose status is routable, with
its play hostnames, a destination (`host:port`, from `endpoint(handle, 'game', 'edge')`) and an
optional state (`asleep`, `restarting`). The answer is computed from the database on every request
and carries an ETag, so most polls are a 304 (#src("apps/control/src/app/edge/service.ts:64")).

#figure(
  table(
    columns: (1fr, auto, 1.7fr),
    table.header[Server status][Route][Destination],
    [running], [yes, no state], [The runtime's edge endpoint.],
    [stopped, stored, starting], [yes, `asleep`], [The endpoint, or `0.0.0.0:0` on runtimes whose address isn't stable (Boat): "nothing listens on port 0, so a status ping fails at once and gets the asleep message, and a join asks for a wake".],
    [updating, or a restart, restore or move of a running server], [yes, `restarting`], [As above.],
    [provisioning, restoring, storing, failed, deleted], [no route], [Unrouted on purpose: a world being restored gets its access list back before anyone can join.],
  ),
  caption: [Routes by status. #src("apps/control/src/app/edge/service.ts:75"), #src("apps/control/src/domain/server/lifecycle.ts:264").],
  kind: table,
)

#fig(sequence({
  import chronos: *
  par-person("p", [Player])
  par-runtime("mr", [mc-router])
  par-runtime("ag", [Edge agent])
  par-control("cp", [Control plane])
  par-runtime("s", [Server])
  _seq("p", "mr", comment: [status ping])
  _seq("mr", "ag", comment: [route `asleep` → sleeping notice])
  _seq("ag", "p", comment: ["Sleeping · join to wake it up"], dashed: true)
  _seq("p", "mr", comment: [login])
  _seq("mr", "ag", comment: [scale webhook `up`])
  _seq("ag", "cp", comment: [`POST /edge/v1/wake {hostname}`])
  _note("right", [quota: 12 wakes an hour; the Start button's own policy;\ start op; one 25 s wait for all of it\ (a restart or a rest first, then `running`); the agent gives up at 30 s], pos: "cp")
  _seq("cp", "ag", comment: [`ready {destination}` (or `starting`, `denied`)], dashed: true)
  _seq("ag", "s", comment: [probe: does it answer?])
  _seq("ag", "mr", comment: [`{backend: destination}`], dashed: true)
  _seq("mr", "s", comment: [splice the player's connection])
}), caption: [Wake on join. A run started by a connection is on probation: if nobody completes a login within 5 minutes it stops (`nobody_joined`). #src("apps/control/src/app/edge/service.ts:93"), #src("apps/control/src/app/operations/schedules.ts:123").], name: "fig-wake", float: true)

- *Destinations per runtime*: Fly `<app>.flycast:25565` on the org's private network (the server's
  app has no public address); fleet `<node edge address>:<host port>`; Boat the sandbox's public
  IPv6 while it runs; Docker the container on the games network.
- *Failure behaviour.* If the control plane is unreachable the agent keeps the last routes; a
  hostname newer than the last poll answers "no route yet" (players see "starting"); a server the
  database says runs but that doesn't answer gets the restarting notice, re-probed every 2 s.
- *Stale connections.* mc-router doesn't close a connection when its route changes. A planned move
  stops the source first, so it can't matter there; after a wrongly declared loss it would
  (@s-split-brain). A relay in the agent that closes connections whose destination left the route
  set is #designed (#src("docs/fleet.md:426")).

#caveat[*The fleet's network path is not built.* The edge and control plane run on Fly's private
network; fleet nodes would need to be reachable on theirs ("a private network is required between
the control plane, the edge and every node", #src("docs/fleet.md:403")). Nothing in the repository
creates that link, and reaching nodes from Fly is an open question. The control plane's node endpoint listens
on `[::]:8443` by default, IPv6 and IPv4, as Fly's private network needs
(#src("apps/control/src/config/load.ts:77")), but no environment runs a node yet.]

= Provider layering <s-providers>

Three ways of running a server, and the providers under each. #implemented for the runtimes;
direct-host providers #research.

#fig(draw(
  spacing: (10mm, 9mm),
  cp((1.5, 0), [Blockly control plane\ #text(size: 6.4pt)[RuntimeRouter: one port]], name: <cp>),
  cp((0, 1.15), [Per-second machine\ per server], name: <a>),
  cp((1.5, 1.15), [Per-second sandbox\ per server], name: <b>),
  cp((3, 1.15), [Many servers on\ machines Blockly rents], name: <c>),
  ext((0, 2.3), [Fly.io\ #text(size: 6.4pt)[Machines, volumes]], name: <fly>),
  ext((1.5, 2.3), [Boat\ #text(size: 6.4pt)[sandboxes, EU]], name: <boat>),
  ext((3, 2.3), [OVHcloud · Hetzner ·\ Vultr · Scaleway …], name: <hosts>),
  st((4.5, 1.15), [Archive store\ #text(size: 6.4pt)[Cloudflare R2]], name: <r2>),
  edge(<cp>, <a>, "-|>", lbl[FlyRuntime]),
  edge(<cp>, <b>, "-|>", lbl[BoatRuntime]),
  edge(<cp>, <c>, "-|>", lbl[FleetRuntime]),
  edge(<a>, <fly>, "-|>"), edge(<b>, <boat>, "-|>"), edge(<c>, <hosts>, "..|>", lbl[never run]),
  edge(<c>, <r2>, "--|>"),
), caption: [Provider layering: a machine per server (Fly), a sandbox per server (Boat), or many servers on each machine (the fleet).], name: "fig-providers")

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr),
    table.header[][Fly][Boat][Fleet],
    [What a server gets], [Its own Fly app on its own private network, one volume, one Machine (performance CPUs), a Flycast address], [A whole Linux VM ("sandbox") running one container; billed per second while it runs, free stopped], [A hardened container on a rented machine Blockly runs blocklyd on],
    [Snapshots], [Fly volume snapshots (not point-in-time: writes 4 s after the ask were held)], [A tar.gz in a snapshot volume inside the sandbox], [Local copy (FICLONE or copy), then upload],
    [Limit], [Org machine limit: `floor((limit − platform) / 2)` servers], [Daily start quota by plan; EU only], [Nodes you add],
    [Configured], [Production and staging], [Nowhere], [Nowhere],
  ),
  caption: [The three runtimes behind the port (Docker is local development).],
  kind: table,
)

- *Other providers*: Cloudflare (DNS, R2 archive store, ACME DNS-01, the web app's Worker), Polar (billing,
  merchant of record), an SMTP provider (unnamed), Modrinth and Mojang (catalog, profiles).
- *Archives are the only thing runtimes share.* Snapshots never cross runtimes; a move between
  runtimes goes through an archive any runtime can restore, so nothing of one provider is ever
  handed to another (#src("apps/control/src/app/operations/handlers.ts:1110")).

= Boat, as it actually is <s-boat>

Boat runs each server in its own sandbox: a Linux VM, billed by the second while it runs and free
while stopped. #implemented, configured in no environment, and not used by any server.

#figure(
  table(
    columns: (auto, 1fr),
    table.header[Question][Answer, from the code and its report],
    [Where?], [Its adapter is `apps/control/src/infra/boat`.],
    [Enabled?], [No. Not the default (`RUNTIME_PROVIDER` defaults to `docker`; environments set `fly`), and no environment lists it in `RUNTIME_PROVIDERS`.],
    [Verified live], [On a trial account, 28 September and 1 October: create → running 34–40 s; a new address on 7 of 7 resumes; a Fly machine reached the sandbox's IPv6 through mc-router; firewall reopened per start; recovery from a crash, an in-VM reboot and a Boat-initiated stop; backup 4.0 s; restore 27.7–31.4 s; a parked sandbox left alone and stopped by Boat.],
    [Not verified], [Export to an archive store and restore onto a new sandbox (unit tests only); a resize; a real player joining through the edge; the start-headroom alert.],
    [Open follow-ups], [All six: the edge's 25 s wake wait is shorter than Boat's ~34 s wake; archive proof; a snapshot at sleep; a start-window alert; refused-stop detection; a dedicated stop reason.],
    [Readiness], [Ready for an internal canary on a paid plan; not yet for paying players.],
  ),
  caption: [Boat's status.],
  kind: table,
)

#caveat[On Boat the game port is public: published on all interfaces, opened in the sandbox's
firewall, reachable over IPv6 without the edge (no edge rate limit, no session hints), and Boat
itself exposes ports 22 and 8911 (#src("apps/control/src/infra/boat/sandbox-scripts.ts:70")). It is
the one exception to "no public address on a game server" (#src("docs/architecture.md:2320")).]

= Direct-host providers <s-direct-hosts>

The fleet runs on machines Blockly rents directly. No node has run on any provider; everything here
is #research. Provisioning hosts from provider APIs is #deferred: a host arrives with Docker, the
binary, its config, the CA certificate and a token, by cloud-init, an install image or by hand.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr),
    table.header[Provider][A power-off that stays off (a real fence)][Private network][Signed instance identity],
    [Hetzner Cloud], [yes], [networks / vSwitch], [no],
    [Hetzner dedicated], [resets only; rescue boot is a fence], [vSwitch], [no],
    [OVHcloud dedicated], [no; emulated by netboot, minutes], [vRack], [no],
    [Vultr], [yes (bare-metal halt)], [VPC], [no],
    [Akamai (Linode)], [likely; not verified], [VLAN / VPC], [no],
  ),
  caption: [What matters per provider. #src("docs/fleet.md:511").],
  kind: table,
)

- *No provider signs its instance identity*, so trust comes from the one-time token, spent before any
  workload runs.
- *Worlds stay on local disks*: provider block volumes have millisecond-class fsync, and some have no
  snapshots.
- *Candidates* are dedicated machines with 64–128 GB of memory and fast single-thread cores, such
  as OVH RISE, Hetzner AX, Scaleway Elastic Metal, Vultr bare metal and phoenixNAP. The canary is
  designed for two nodes in Europe, one of them spare. #designed

= Choosing a runtime <s-runtime-choice>

#block(sticky: true)[What decides which runtime suits a server. Every usage figure is a scenario,
because there is no production usage to measure yet. #research]

- *Plans cap running time.* A server runs 3–8% of a month, so a runtime billed per running second
  (Fly, Boat) costs little while a server sleeps: its disk or snapshot, never its compute.
- *Machines are paid for running or not.* On the fleet what matters is running utilization: the
  GB-hours servers run, divided by the GB-hours the nodes offer.
- *Reserving memory wastes it.* A fleet that held memory for every placed server (overcommit 1)
  would use about 1% of the memory it holds. Running admission, which holds memory only for
  running servers (@s-capacity), is what makes a fleet worth running at all.
- *Boat's limits* are a daily start quota by plan and Europe only.
- *Owning machines suits* always-on servers, regions Boat doesn't serve, and servers where
  single-thread speed matters: a current dedicated core runs a server's main thread about three
  times as fast as a Fly vCPU.

#why[This is why the fleet exists as a measured canary and not a migration: a per-second cloud is
the safe default, and the fleet's case rests on a running utilization that only real traffic can
show.]

= The canary <s-canary>

A canary is not a flag. It is a placement rule (or explicit moves) that sends some *new* servers to
a runtime other than the default (#src("docs/runtimes.md:3")). #implemented, with no rules
defined: no deployment runs a canary.

#fig(draw(
  spacing: (10mm, 8.5mm),
  who((0, 0), [Operator], name: <op>),
  cp((1.3, 0), [`runtimes.ts rule add fleet`\ #text(size: 6.4pt)[`--percent 5 --plan plus --region eu`]], name: <rule>),
  cp((2.9, 0), [New matching\ servers → fleet], name: <new>),
  cp((2.9, 1.15), [`runtime_decisions`\ usage, capacity], name: <rec>),
  cp((1.3, 1.15), [`runtimes.ts report`\ #text(size: 6.4pt)[cost per played hour,\ utilization]], name: <rep>),
  who((0, 1.15), [Operator decides], name: <dec>),
  edge(<op>, <rule>, "-|>"),
  edge(<rule>, <new>, "-|>"),
  edge(<new>, <rec>, "--|>"),
  edge(<rec>, <rep>, "-|>"),
  edge(<rep>, <dec>, "-|>"),
), caption: [The canary loop. Turning a rule off affects only new servers; servers already on the canary stay until moved one by one.], name: "fig-canary")

- *Choosing servers*: an allowlist of accounts, regions, plans, and a stable percentage (hash of
  rule and server). Or explicit moves: `bun scripts/runtimes.ts move <id>… --to fleet`.
- *Measuring*: `bun scripts/runtimes.ts report` gives per runtime the servers, running and played
  hours, GB-hours, list-price usage, node capacity cost, idle memory, running utilization, backup
  cost, revenue, fees and margin, per played hour. Bandwidth and per-server CPU are not measured
  (printed as blind spots) (#src("apps/control/src/app/runtimes/economics.ts:8")).
- *Stopping*: `rule off <rule>` or percent 0. There is no rule delete. Removing a runtime from
  `RUNTIME_PROVIDERS` is not a stop: its servers become foreign.
- *The plan*: two EU nodes, named servers first, then an allowlist, a month of measurement, and
  expansion only if the canary beats the runtime it replaced per played hour with no data lost.
  #designed
