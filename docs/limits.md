# Limits and bottlenecks

Everything found in this repository that caps, serializes or slows Blockly when many people use it
at once. A load test with 50 people found the control plane runs at most 8 server operations at a
time; this list is the rest of what that test didn't reach yet.

Read it worst first. **People at once** means people signed in and playing at the same moment, each
with about one server. The 50, 500 and 5,000 columns say what breaks at that many, today; a dash
means nothing does. Numbers that come from private configuration (`ABUSE_LIMITS`,
`FREE_LINK_TUNING`) are not written here.

**Status:** *fixed* is fixed in the pull request that added this file; *config* means the number
should come from configuration with today's value as its default, and is small enough to do as it
is; *brief* points at a change of its own, described under [Briefs](#briefs); *elsewhere* is being
changed by other work right now; *partial* is improved, with what is left said in its brief.

Paths are from the repository root; `control/` is `apps/control/src/`.

## The table

| # | Where | What it limits | Today | 50 | 500 | 5,000 | Fix | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `control/main.node.ts:483` | Server operations (start, stop, create, restore) one worker runs at once | 8, written in code | Starts queue behind each other; a wake waits minutes | Most wakes time out at the edge | Unusable | Config, a size per kind, more workers | elsewhere |
| 2 | Paper's `bukkit.yml` (never written; `scripts/players-bench.ts:110` sets it only for the bench) and `apps/edge/front.ts:93` | Logins per address. Every player reaches the game server from the edge's address, so Paper's connection throttle counts every player on a server as one | Paper's default throttle; real address never passed on | Two friends joining within a few seconds: the second is kicked as throttled | Same, on every busy server | Same | Pass the real address with the PROXY protocol to Paper, or turn the throttle off where it can't see it | brief A |
| 3 | `control/infra/fly/fly-runtime.ts:137,140`, `control/config/load.ts:127`, `scripts/staging.ts:442` | Servers Fly holds: `floor((machine limit − platform machines) / 2)` | Staging: 50 typed in, about 21 servers. Production: the `fly_machine_limit` variable | Staging overflowed to Boat at 22 servers (see [Fly's ceiling](#flys-ceiling)) | Every new server beyond the ceiling goes elsewhere or waits | Same | Count the second machine only while it exists; read the real limit | brief B |
| 4 | `control/app/edge/service.ts` (`listed`), `apps/edge/agent.ts`, `apps/edge/router.ts` | The edge's route list: rebuilt from every live server, every binding and today's play, once a second per edge. It used to rewrite the whole routes file on any change and reload every route in mc-router, which empties its table for a moment: 145 of 23,550 pings to a route that never changed were closed while one other route changed ten times a second among 300 (602 of 22,199 among 1,000). Now only the routes that changed go to mc-router, one at a time through its API: 0 closed of about 25,700 at both sizes, and a change lands in 2 ms (p50) whatever the count | 1 s poll, full rebuild, about seven queries | — | Several full-table reads a second | Database time grows with every server; mc-router's side no longer does | Done at the edge: changes only, through mc-router's API. Left: serve changes since a version, not the whole list; cache the list between polls | brief C |
| 5 | `scripts/production.ts:154` (`--ha=false`), `infra/fly/edge.toml` | One machine each for the edge, the api and the worker | 1 each | A deploy or restart of the edge drops every player in every world; an api restart stops wakes | Same, more people hit | Same, and one edge's CPU carries every connection | Two edges, two api machines; a worker that can be more than one | brief D |
| 6 | `control/app/policy/access-policy.ts:150,156`, `control/app/accounts/persistence.ts:418,426` | Creates, starts and undeletes on the platform take turns under one lock for the platform's counts, room and caps, held from the decision to the commit; each person's own facts are read before it, under a lock of their own | One platform-wide lock, for the decision and the create's own writes | — | A create burst still runs one decision at a time: about 46 a second on a local stack, up from 29 | The create's own writes, held under the lock until it commits, are the ceiling | Each person's facts under their own lock; the platform's lock for its counts only, taken last; the count from an index of live servers; a provider asked about room before the lock; resizes take no platform lock. Left: the platform lock still holds most of a burst | partial (brief E) |
| 7 | `packages/db/src/index.ts:31`, `control/config/load.ts:91`, `control/infra/pg/jobs.ts:154`, `control/infra/pg/locks.ts:26` | Database connections: each process opens a query pool and a job-queue pool of `DATABASE_POOL_MAX` each, plus a listener for live updates, and a worker one more for the job queue's wake-ups; a request waits for a free connection without end; every console command holds one for its whole RCON session | 10 + 10 + 1 per process, 2 in a worker; no wait timeout; production leaves the size unset | — | Eight operations, the edge poll and console sessions share 10; requests stall | Pool exhaustion; the session pooler's own limit is reached | Separate sizes per pool, a wait timeout, locks that don't pin a connection | brief F |
| 8 | `control/app/operations/schedules/presence.ts:53`, `session-cap.ts:106`, `idle.ts:40`, `drift.ts:37`, `disk-growth.ts:42`, `control/app/accounts/service.ts:490,497` | Per-minute sweeps go through every running server or owner one at a time; presence asks each server over RCON; a scheduled job is cut off at 5 minutes and not retried (`control/infra/pg/jobs.ts:591`) | Serial, unbounded | — | A pass takes most of its minute; a few hung servers make it miss | Passes never finish; presence, idle stops and limits go stale | Work in parallel with a bound; page through; skip the slow | brief G |
| 9 | `control/infra/auth/better-auth.ts:188,192` | Sign-in, sign-up and password reset per address, counted in each api machine's memory, by the full address | Better Auth's default per-address limit | A class signing in at once from a school's one address is refused | Same, for any carrier-grade NAT | Same | Its own limits from `ABUSE_LIMITS`, IPv6 by /64, counted in the database | brief H |
| 10 | `apps/edge/agent.ts:73–88`, `apps/edge/front.ts:169` | Connections per address at the edge (rate, burst, handshakes in progress) and per server; every hostname not in the route list shares one bucket | Env vars, defaults in code | — | A school or a carrier's address shares one bucket; pings count | Same | Fine as config; check the defaults against many players on one address; give unknown names a bucket of their own per name | config |
| 11 | `control/app/sharing/service.ts` (invite joins) | People one invite link lets in an hour | Was written in code | A class of 30 joining by one link stopped part way | Same | Same | `inviteJoinsPerHour` in `ABUSE_LIMITS`, optional, same default | fixed |
| 12 | `control/app/servers/queries.ts:224` | The server list: about 20 queries per server, all at once through `Promise.all` | — | An owner with ten servers takes the whole pool for a moment | Server lists slow everyone's requests | Same | Read per owner once, then per server in batches | brief I |
| 13 | `packages/db/src/schema/servers.ts`, `backups.ts`, `usage.ts` | Hot queries reading whole tables: running servers, a server's newest operation of one kind, the trash's hold on an address, ready backups past expiry, players seen in the last day | No index | — | Sweeps read every row each minute | Same, and the server list with it | Five indexes (migration `0071_hot_path_indexes`), tested by planning the real queries | fixed |
| 14 | `control/app/access/persistence.ts`, `control/app/sharing/service.ts` | Audit queries that left out the subject type, so the audit index didn't apply | Full scan of the audit log | — | Every invite join and access page scans it | Same | Name the subject type | fixed |
| 15 | `control/app/edge/service.ts` (`wake`) | A wake read every binding to find one | Full table | — | Every wake reads every server's binding | Same | One binding by its key | fixed |
| 16 | Remaining unindexed hot queries: `control/app/billing/persistence.ts` (`untoldAbout`), `control/app/billing/extra-usage.ts:476,491`, `control/app/billing/chip-ins.ts:205`, `control/app/accounts/persistence.ts` (`ownersNotActive`), `control/app/platform/persistence.ts` (`runsBetween`) | Billing and play sweeps that read every order, interval or chip-in ever, each minute | No index; `OR` over a nullable column | — | Each minute reads all history | Same, growing for ever | Partial indexes and rewrites without `OR` | brief J |
| 17 | `audit_log`, `server_operations`, `power_intervals`, `server_usage_days`, `insight_events` | Nothing is ever deleted from them (only fleet events, `control/infra/fleet/fleet-runtime.ts:722`) | Unbounded | — | — | Scans and indexes grow for ever | Retention per table | brief K |
| 18 | `control/infra/mail/smtp.ts` | Sign-up and password reset wait on their email; nodemailer's defaults wait minutes on a silent server | Minutes | A slow mail server holds sign-ups open | Same | Same | Connect, greeting and socket timeouts | fixed |
| 19 | `control/infra/hangar/client.ts` | A Hangar read had no timeout | None | A hung read holds a mod search for ever | Same | Same | A timeout per try, tried again | fixed |
| 20 | `control/infra/boat/client.ts:87`, `control/infra/s3/s3-archive-store.ts:144`, `control/infra/formats/pack-archives.ts:172`, `control/infra/formats/file-formats.ts`, `control/infra/formats/remote-zip.ts`, `control/infra/fleet/store.ts`, `control/infra/pg/events.ts:55`, the Docker client | Outbound calls with no timeout | None | A hung call holds an operation slot until its half-hour deadline | Slots fill with hung calls | Same | A timeout on each (Fly and Modrinth are elsewhere) | brief L |
| 21 | `control/app/operations/schedules/reconcile.ts:165`, `orphans.ts:55`, `leftovers.ts:32` | Calls to the provider made inside a transaction that holds the server's row | — | — | A slow provider holds row locks other work waits on | Same | Decide in the transaction, call after it | brief M |
| 22 | `control/interfaces/realtime/server.node.ts:45,164`, `infra/fly/realtime.toml` | Realtime is one process: every room in one machine; no cap on connections, rooms or message size; a database read for every presence event even when nobody watches | One machine | — | One small machine carries every open page | A restart drops everyone; memory | Caps and backpressure; skip presence reads for empty rooms | brief N |
| 23 | `control/infra/mojang/client-assets.ts:74` | A release's client jar (up to 200 MB) read whole into memory, its files kept unzipped for as long as the process lives, per release | Whole jar | — | A few releases' item pictures use much of the api's memory | Same | Read the entries needed from disk; keep a bounded set | brief O |
| 24 | `control/app/items/icons.ts` | Item pictures kept with no bound, by ids anyone can send | Unbounded | — | Grows with made-up ids | Same | A bound, oldest first | fixed |
| 25 | `control/interfaces/http/api.ts`, `control/interfaces/billing/webhook.ts:18` | Request bodies on the api have no size limit; the billing webhook reads its whole body | None | — | — | One large request can use the api's memory | A body limit per route | brief P |
| 26 | `control/app/platform/fleet.ts:115` | The admin server list loads every matching server, then pages in memory | All rows | — | Slow admin page | Very slow, and heavy on the api | Page in the query | brief Q |
| 27 | `control/infra/pg/jobs.ts` (queue options) | One pack import, one world download and one curation at a time per worker; scheduled jobs expire after 5 minutes with no retry | 1 each | Imports and downloads queue | Long queues | Same | Config per queue | elsewhere |
| 28 | `control/main.node.ts:672–673` | How long a boot may take, and how long a wake from the edge waits | Written in code | — | — | — | Config, same defaults | elsewhere |
| 29 | `control/infra/fly/client.ts:41` | Fly API pace per process | 1 a second per call, written in code | — | Two api or worker machines exceed Fly's own pace | Same | Shared pace, config | elsewhere |
| 30 | `control/infra/limits/memory-limits.ts:29`, `control/app/sharing/queries.ts:47`, `control/app/accounts/service.ts:70` | Public page reads per server, invite reads, the waitlist: counted in each machine's memory; the waitlist is one count for everyone | Written in code | A class opening one server's public page at once reaches its per-minute cap | Same | Doubles with each api machine, resets on restart | Config; count in the database where the number matters | config |
| 31 | `infra/fly/control.toml:46–47` | Concurrent requests to the one api machine before Fly stops sending it more | 200 soft, 250 hard | — | Peaks are held at Fly's proxy | Refused at the proxy | Raise with a second machine (brief D) | config |
| 32 | `infra/fly/edge.toml`, `infra/fly/realtime.toml` | Connections Fly's proxy gives one machine before it prefers another, and before it holds new ones back. The edge's, measured on staging: a shared-cpu-1x edge copies about 400 players' packets while its CPU burst lasts, and about 50 once it is held to its baseline, when replies take up to a second and connections drop; memory is never what runs out | Edge: 50 soft, 400 hard. Realtime: Fly's defaults | — | Past 50 on one edge, new players go to the other edge | One edge's CPU, held to its baseline, slows everyone on it | Edge done; a larger CPU for the edge raises both numbers. Realtime's with brief N | partial |
| 33 | `apps/edge/front.ts` (`pipe`), `apps/edge/agent.ts` (`TIMEOUTS`) | A player's connection to a game server, and through the front door to mc-router: how long a server has to take it, and how long it may go with nothing passing either way | `CONNECT_TIMEOUT_MS` 10 s; `IDLE_TIMEOUT_MS` 60 s, past Minecraft's keep-alive (one every 15 s, a client dropped after 30 s without) | — | — | — | Connect timeout; idle timeout longer than Minecraft's keep-alive | fixed |
| 34 | `control/app/insight/service.ts:47`, `control/app/billing/extra-usage.ts:63` | Events sent a minute: product insight, and usage to the billing provider | Written in code, sent one at a time | — | — | A backlog grows faster than it drains | Config; send in batches | config |
| 35 | `control/app/servers/waiter.ts:47` | Each wake waiting on a server reads the database once a second as well as listening | 1 s | — | Many waits, many reads | Same | Rely on the event bus, read rarely | config |
| 36 | `control/app/accounts/free-links.ts:210` | Regrouping free accounts reads every link under one lock, inside sign-up | One lock | — | — | Sign-ups queue behind it | Regroup only the accounts touched | brief J |
| 37 | `control/infra/polar/polar-billing.ts:378` | Gift products read from one page | 100 | — | — | — | Page through | config |
| 38 | `control/infra/fleet/node-client.ts:99`, `control/infra/fleet/join-routes.ts:33,65` | Calls to all fleet nodes share 16 sockets per process; the blocklyd binary is read whole from disk on every join request | 16; whole file | — | Node calls queue | Same | Config; read the binary once | config |
| 39 | `apps/web/src/app/(public)/pricing/page.tsx:19,43` | The pricing page asks the control plane on every view | No cache | — | — | One api request per view | Cache it as the landing page does | config |
| 40 | `control/app/listings/persistence.ts` (discover search) | Searching listings by name matches with `ILIKE '%…%'`, twice a page | No index | — | — | Slow discover search | Trigram index | brief J |

## Fly's ceiling

Staging's burst stopped placing servers on Fly at 22 and sent every one after that to Boat, which
then throttled at its plan's starts a minute and failed two creates four times each with "the
workload did not start (exited)".

**Is 50 the organization's real Fly quota, or a number we chose?** A number written into the
repository, not read from Fly. Staging sets `FLY_MACHINE_LIMIT: '50'` in `scripts/staging.ts:442`,
and the control plane's fallback in `control/config/load.ts:127` is also 50, commented as "Fly's
default for an organization". Production takes it from the `fly_machine_limit` Terraform variable,
described as "as Fly support set it" (`infra/terraform/modules/fly-org/main.tf:27`). Nothing asks
Fly. Whether staging's organization is really capped at 50 can't be told from here (staging was off
limits during the load test): it needs a look at the organization's limits on Fly, or Fly's answer.
Two more things don't line up: production's checks count 7 platform machines
(`scripts/production-values.ts:379`) while Terraform's default sends 4
(`infra/terraform/modules/fly-org/main.tf:33`); and staging counts its platform machines from its
list of apps, so it differs again.

**Is reserving two machines per server the right trade?** No. Every server keeps one machine for
as long as it exists, asleep or not, and Fly counts stopped machines too, so one per server is
right. The second exists only while a restore, a move, a host-loss replacement (`#replace`,
`control/infra/fly/fly-runtime.ts:699`) or an export's helper runs, and those are few at once:
they run as server operations, which one worker runs a handful of at a time. Reserving one for
every server halves what the organization holds for something that happens to a few servers at a
time. Better: hold back a fixed number of machines for those operations, the most that may run at
once, and let no more of them run than that. With 50 and 7 platform machines that is 43 less the
reserve, about 35 servers instead of 21. Counting the second machine "only while one exists" is
the same idea; doing it with a reserve keeps a create from racing a restore for the last machine.
See [brief B](#b-flys-ceiling).

## Briefs

Each is one change for one session.

### A. The real player address, and Paper's throttle

Every player reaches a game server through the edge, so Paper sees one address for all of them. Its
connection throttle (left at Paper's default) then kicks a second player who logs in within a few
seconds of the first, and IP bans and per-address plugins see the edge, not the player. The bench
already turns the throttle off by hand (`scripts/players-bench.ts:110`). Either have the edge send
a PROXY protocol line to Paper servers (`apps/edge/front.ts` `pipe`, and mc-router's onward
connection) and turn on Paper's `proxies.proxy-protocol`, so the throttle and bans count real
players; or, as a first step, write `connection-throttle: -1` into `bukkit.yml` for every Paper
server. Vanilla and Fabric don't read PROXY lines, so only Paper servers get it. Check how the IP
bans an owner sets are applied today, since they can only match the edge's address.

### B. Fly's ceiling

Replace `MACHINES_PER_SERVER = 2` (`control/infra/fly/fly-runtime.ts:137`) with one machine per
server plus a fixed reserve for restores, moves and exports, and hold those operations to the
reserve so a create never takes the machine a restore needs. Make the reserve config. Have
`scripts/staging.ts` take the machine limit from the environment instead of a literal, and make
production's platform count agree with Terraform's. Separately, look into why Boat's two creates
exited: the throttle explains a delay, not an exit.

### C. Routes by change, not by list

`EdgeService.routes()` rebuilds every route from four full reads every second per edge, and the
edge rewrites its whole route file and reloads mc-router on any change (`apps/edge/agent.ts:117`).
Keep a version that rises with each change to a route (the event bus already carries the changes),
let the edge ask for changes since its version, and build the full list only for an edge that is
new. Until then, cache the built list in the api for its poll interval so several edges share one
build.

### D. More than one of each machine

Production deploys the edge, the api and the worker as one machine each (`--ha=false`). A restart
of the edge cuts every live game connection; of the api, every wake. Run two edges (the play
domain already points at the app, and Fly balances between machines) and two api machines. The
worker needs its schedules to stay singletons (pg-boss's `singleton` policy already does) before
it can be two.

### E. The capacity lock

Partly done. Creates, starts and undeletes read each person's own facts (standing, play, their
servers, their creates an hour) under a lock per person, `blockly:capacity:<id>`
(`control/app/accounts/persistence.ts:426`, taken at `control/app/policy/access-policy.ts:150`),
which other people's decisions don't wait on. Only then do they take `blockly:capacity`
(`control/app/accounts/persistence.ts:418`, taken at `control/app/policy/access-policy.ts:156`),
for the platform's switches, its count of servers and running ones, and the room for a new
server. That count is one query read from the index of live servers by state
(`servers_live_status`), not two counts of the table. A resize reads none of the platform's facts
and takes only its owner's lock. The per-person lock is always taken before the platform's, never
after.

A runtime is asked whether it has room before the lock, so a call to Fly is never waited on under
it; its count of servers is read again under the lock. That can't admit more than before: the lock
never covered the answer, since a provider's room changes outside the database, and provisioning
asks the provider again and waits for room when it has gone.

`capacity-lock.test.ts` sends requests at once and checks that nothing passes a cap and nothing
deadlocks: fifty creates by fifty people stay within the room, and fifty by one person within
their plan; twenty starts stay within the platform's running cap, and eight by one person within
their plan's; undeletes stay within the runtime's ceiling; free and Plus creates mixed close to
free plans at their share first and Plus fills the rest; creates and starts mixed stay within both
running caps. With the platform's lock taken out, every test of a platform cap fails; with the
per-person lock taken out (in the policy and in the create), every test of a plan's cap fails.

On a local stack (the operation-test harness, fake runtime, fifty Plus creates at once, three runs
each, the lock sampled from `pg_locks`):

| | Creates a second | Mean hold | Share of the burst the lock is held |
|---|---|---|---|
| Before | 28–32 | 26–33 ms | 92–97% |
| After | 40–48 | 18–20 ms | 85–90% |
| Before, the runtime taking 20 ms to say it has room | 17–19 | 43–50 ms | 96–97% |
| After, the same | 38–50 | 17–20 ms | 84–87% |

Left: the platform lock still holds most of a burst. A create still writes its server, placement,
binding, audit and job under it, since the count it was admitted by must include them, and that
is now most of the hold. The runtimes' count of servers by provider
(`control/app/runtimes/persistence.ts:208`) still joins every binding, twice per create.

### F. Database connections

Give the query pool and the job queue's pool their own sizes (today both are `DATABASE_POOL_MAX`),
and don't open the job queue's pool on api-only machines beyond what sending jobs needs. Add a
wait timeout to the pool, so an exhausted pool fails a request instead of holding it. RCON's
advisory lock (`control/infra/pg/locks.ts:26`) pins a pooled connection for a whole RCON session;
use a transaction-level lock or a lock row instead. Set `DATABASE_POOL_MAX` in production against
the session pooler's own limit and the number of machines.

### G. Sweeps that keep up

The per-minute sweeps loop over every running server or owner one at a time. Run each server's
step with bounded parallelism, with a short timeout on RCON in presence, and let a pass stop when
its minute is up and carry on from where it stopped. Read owners' standing once per owner, not
once per server.

### H. Sign-in by address

Better Auth's limits count in each machine's memory, per full address. Set Blockly's own
(`rateLimit` in `control/infra/auth/better-auth.ts`), from `ABUSE_LIMITS`, stored in the database
so machines share them, with IPv6 grouped by /64. A school's or a carrier's address needs more
room than one person's.

### I. The server list

`ServerQueries.list` fans out about 20 queries per server at once. Read what is per owner
(standing, play today and in total, live count) once, and per-server facts in one query each for
all servers.

### J. The rest of the indexes, and unbounded reads

Partial indexes for billing orders not yet told about, open plan years, and accounts not active;
rewrite the `OR`s over `stopped_at` in extra usage and play as two indexed reads; a trigram index
for discover's search; bound the reads of removed listings, open reports and pending moves. Each
with a test like `control/app/servers/hot-path-indexes.test.ts`. Free-play regrouping should work
on the accounts touched, not every link.

### K. Retention

Decide how long each growing table keeps its rows (the audit log, operations, power intervals,
usage days, sent insight events), and delete in batches on a schedule. What billing and support
need to keep decides the periods.

### L. Timeouts on every outbound call

Boat's client, the S3 ingest download, pack and tarball reads, remote zips, the fleet store's
reads, the Docker client and the event bus's connection have none. Give each a timeout (per try
where it retries) the way `control/infra/hangar/client.ts` now does. Fly's client and Modrinth's
downloads are being changed elsewhere.

### M. No provider calls inside row locks

Reconcile, the orphan sweep and the leftover sweep call the provider inside a transaction that
holds the server's row. Decide and record in the transaction, call the provider after it, and
check again before writing what it said.

### N. Realtime under load

Cap connections and rooms per person, the size of a message, and what is buffered for a slow
client; read presence only for rooms someone is in. It stays one process, so measure how many
connections one machine of its size holds and say so in `infra/fly/realtime.toml`.

### O. Client jars

`MojangClientAssets` reads a whole client jar into memory and keeps every file of it unzipped for
the life of the process. Keep the jar on disk and read only the entries asked for, with a bounded
cache.

### P. Request size

Add a body limit to the api's routes (Hono's `bodyLimit`, as the fleet's node endpoint already
does), sized per route: small for tRPC and the webhook, what uploads need where they arrive.

### Q. The admin server list

`control/app/platform/fleet.ts` loads every server that matches and pages in memory. Page and
count in the query.
