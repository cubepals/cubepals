# Several runtimes in one deployment

A deployment can run Fly, Boat, the fleet and Docker at the same time.
Each server lives on exactly one of them, and a placement policy decides where new servers go. That
lets the fleet start as a small, measured canary beside the cloud runtimes rather than a switch for
the whole platform. Owners never see any of it: where a server runs is Blockly's decision.

How the fleet itself works is [fleet.md](fleet.md).

## Contents

1. [The model](#1-the-model)
2. [Configuration](#2-configuration)
3. [Where new servers go](#3-where-new-servers-go)
4. [When a runtime is full](#4-when-a-runtime-is-full)
5. [Moving a server to another runtime](#5-moving-a-server-to-another-runtime)
6. [Operating it](#6-operating-it)
7. [Measuring a canary](#7-measuring-a-canary)
8. [Adding a runtime](#8-adding-a-runtime)
9. [Limits](#9-limits)

## 1. The model

- **A handle says which runtime owns a server.** Every handle a runtime issues starts with its
  own prefix (`fly:v1:`, `fleet:v1:`, …), and each runtime answers `owns(handle)`.
  `app/runtimes/router.ts` (`RuntimeRouter`) gives every call to the runtime that owns the
  handle. A server on Fly stays on Fly and a server on the fleet stays on the fleet, whatever new
  servers are sent to. Nothing in the application branches on a provider id; the boundary check
  still holds.
- **A binding records the runtime.** `server_runtimes.provider` names the runtime beside the
  handle. Only three things ever change it:
  - placement, when the server is made;
  - the first-start fallback (§4);
  - an operator's move (§5).
  A binding to a runtime this deployment doesn't run is *foreign*: its handle is withheld and
  nothing touches it, as before.
- **Calls with no handle name their runtime.** A first `ensureProvisioned`, an `adopt`, and a
  `destroy` by key take the binding's provider. Listings (`observeChanged`, `inventory`) read
  every runtime. A runtime whose listing fails is reported after the others.
- **The console, readiness probe and logs follow the same handle.** The router stamps each
  endpoint with its runtime (`Endpoint.provider`), and `RoutedAdapters` hands it to that
  runtime's console and probe. Fly, the fleet and Docker share RCON and the status ping. Boat
  reaches its servers through its command endpoint, so it brings its own.
- **The port gained five methods:**
  - `owns` and `ownsSnapshot`: whether a runtime issued a handle or took a snapshot.
  - `hasRoom`: whether it could place a server of this size where a placement maps now.
  - `adopt`: a handle for a server it holds nothing for, which a restore from an archive fills.
  - `capacity`: the machines it pays for whether or not servers fill them; null where only
    servers bill.

## 2. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RUNTIME_PROVIDER` | `docker` | The default runtime: where every new server goes unless a rule says otherwise. It must place every region. |
| `RUNTIME_PROVIDERS` | `RUNTIME_PROVIDER` | Every runtime the deployment runs, comma-separated, the default among them. Each reads its own variables (`FLY_*`, `BOAT_*`, `FLEET_*`, `DOCKER_*`). |
| `RUNTIME_REGION_MAP` | — | The default runtime's region map, which places every region. No other runtime reads it. |
| `<NAME>_REGION_MAP` | — | One runtime's own region map (`FLY_REGION_MAP`, `FLEET_REGION_MAP`, …). The default runtime's stands in for `RUNTIME_REGION_MAP`. Every other runtime needs its own, and places only the regions it names: the start is refused without one. |
| `OPERATOR_TOKEN` | `FLEET_OPERATOR_TOKEN` | Bearer token of the operators' API on the internal listener (`scripts/runtimes.ts`, `scripts/fleet.ts`). Required when the fleet runs. |

A Fly deployment with a fleet canary in Europe:

```sh
RUNTIME_PROVIDER=fly
RUNTIME_PROVIDERS=fly,fleet
RUNTIME_REGION_MAP=eu:fra,us:iad      # Fly's: every region
FLEET_REGION_MAP=eu:eu-rbx            # the fleet's: only where it has nodes
OPERATOR_TOKEN=…                      # plus FLEET_CA_CERT, FLEET_CA_KEY, FLEET_ENDPOINT_HOSTS, an archive store
```

With only `RUNTIME_PROVIDER` set, a deployment behaves exactly as before: one runtime, no rules,
every decision `placed` on it.

## 3. Where new servers go

`app/runtimes/placement.ts` is the policy, as one pure function over the rules
(`runtime_rules`) and what each runtime says about room. Nothing else in the application chooses a
runtime.

- **A rule** sends a share (`percent`, 0–100) of matching new servers to one runtime. It matches
  on owners (an account allowlist), regions and plans; an empty list matches everything.
- **Rules are read in the order they were made.** The first one that matches, whose runtime the
  deployment runs and has room for the server, places it. A rule for the default runtime placed
  first keeps those owners off a canary.
- **The share is stable.** It is a hash of the rule and the server id, so a server always lands
  the same way, and raising 5% to 20% keeps the 5% already in.
- **No rule matched:** the default runtime.
- **The decision is recorded** in `runtime_decisions`, with every rule considered and why each
  did or didn't place the server: not matched, not in the rollout, not run here, no room.
- **It decides once.** Changing or turning off a rule changes where *new* servers go, and nothing
  else. Servers already placed stay where they are, so turning a canary off never strands or
  moves the servers on it.

The two commands the canary needs:

```sh
# These five servers to the fleet; everything else stays where it is (an explicit move, §5)
bun scripts/runtimes.ts move <id1> <id2> <id3> <id4> <id5> --to fleet

# Later: 5% of new Plus servers in Europe
bun scripts/runtimes.ts rule add fleet --percent 5 --plan plus --region eu --note "canary"

# Only these accounts' new servers
bun scripts/runtimes.ts rule add fleet --percent 100 --account a@example.com --account b@example.com

# Off again: new servers go to the default; the fleet's servers keep running there
bun scripts/runtimes.ts rule off <rule>
```

## 4. When a runtime is full

The fallback is explicit and happens at two moments:

- **At placement.** A rule's runtime that has no room for the server (`hasRoom` false) is passed
  over for the next rule, then the default. The decision says so: `the default runtime: fleet had
  no room`.
- **At the first start.** Room can go between placement and provisioning. A server a rule sent to
  another runtime (its placement decision's `rule_id`), that has never held anything, whose
  runtime throws `RuntimeFull`, moves to the default runtime once and starts there. This is
  recorded as `fell_back`. Whatever the first runtime began for it is cleared. One the default
  overflowed (below) has no fallback, since the default is full: it stays where it went, as one on
  the default does.

After that, a full runtime never moves a server. Once a server has started anywhere, `RuntimeFull`
means it waits for room, as every server always has. Owners read the same "no room just then"
sentence. A server already on the default runtime has nowhere to fall back to.

**A provider's own limit counts as full.** Fly holds at most `(machine limit − platform machines) / 2`
servers. Once another runtime with no such limit runs beside it, the deployment-wide cap
(`maxServers`) can't express that. So placement counts the servers holding compute on each runtime
against its own ceiling (a resting world has let its machine go, and isn't counted):

- a rule's runtime at its ceiling is passed over;
- the default at its ceiling *overflows* new servers to the first other runtime, in
  `RUNTIME_PROVIDERS` order, that has room, recorded as `overflow: fly is at its provider's limit`;
- with room nowhere, the server goes to the default and waits.

## 5. Moving a server to another runtime

A move is explicit: only an operator asks for one, never a rule change, and never the platform for
a cheaper place. It goes through the archive store, the one place every runtime reads, so nothing
of one provider is ever handed to another.

1. `bun scripts/runtimes.ts move <server> --to <runtime>` records the request
   (`server_runtimes.move_to`, and a `move_requested` decision).
2. The relocation sweep picks it up at the server's next quiet moment: no operation in flight, for
   a running server nobody online, and room for it on the other runtime (`hasRoom`); until there
   is, the request waits. A server whose last move failed is left for an operator; one whose move
   was refused before anything was let go (it stayed where it was) is asked for again 15 minutes
   later (`RELOCATION_RETRY_MS`), then twice as long after each refusal in a row, up to a day.
3. **A stopped or running server** goes through the application's own relocation, extended to
   cross runtimes:
   - a running server imports in-game access changes, saves and stops;
   - a copy of its world goes to the archive store, which must hold as many bytes as were sent,
     and is read back as far as the server's settings and its world's `level.dat`; the sha256 it
     was written with is kept beside it (`backups.sha256`), for a runtime that checks what it
     downloads, as the fleet does;
   - the other runtime adopts the server and restores storage and compute from that copy;
   - only then does the binding change, and the server's snapshots on the old runtime expire,
     since nothing restores them there;
   - the old runtime's copy is destroyed;
   - a server that ran starts again where it is now, and boot puts the access record back on it.
4. **A resting server** (its world is only in the archive store) moves by its binding alone. The
   other runtime adopts it, the binding changes under the server's lock, and it wakes there.

If the move fails before the binding changes (no room, a restore that didn't finish), the server
stays where it was, with its world. It runs again if it ran (or sleeps there, when its own runtime
has no room to run it just then), the request is cleared, and a `move_failed` decision says why.
The portable copy is kept for a week either way.

Players see what any relocation shows: the server restarts once, which takes a few minutes for a
large world. Nothing an owner sees changes: address, settings, backups in the store, access.

`bun scripts/runtimes.ts stay <server>` calls off a move not yet made.

**Leftovers.** The orphan sweep destroys what a runtime holds for a server that is bound
elsewhere: a fallback's partial placement, a failed move's target, a source the move couldn't
delete. It never does so while an operation is in flight for the server. It destroys what a purged
server left too. Compute whose server the database doesn't know is kept, and logged every hour
(`orphans: <runtime> holds <key>…`): after a restore from a backup, that is every server made since,
and only an operator can say what it is.

## 6. Operating it

`scripts/runtimes.ts` talks to the operators' API (`/runtimes/v1` on the internal listener) with
`OPERATOR_API` and `OPERATOR_TOKEN`; `OPERATOR` is who the decisions say acted.

```sh
bun scripts/runtimes.ts summary            # default runtime, servers per runtime, rules, moves, recent decisions
bun scripts/runtimes.ts rules
bun scripts/runtimes.ts where <server>     # its runtime, a pending move, every decision
bun scripts/runtimes.ts report             # this month: each runtime's cost against its revenue
```

The admin servers page shows each server's runtime, and any move under way.

## 7. Measuring a canary

**What is recorded:**

- `power_intervals.provider`: the runtime each run was on.
- `server_usage_days`: player-minutes, minutes with anyone online, and peak players, per server,
  day and runtime. The presence sync adds them once a minute.
- `runtime_decisions`: where each server was placed, and why.
- `server_runtimes`: storage and disk used. Backup sizes are in `backups`.
- A runtime that pays for machines reports them through `capacity()`. For the fleet that is every
  node: its `monthly_cost_cents` label, the memory and CPU held for the servers running on it, the
  memory of every server placed on it, and what it reported in use.

**`bun scripts/runtimes.ts report [--from] [--to]`** (`app/runtimes/economics.ts`) puts them
together. Its assumptions are printed with it.

| Level | What it shows |
|---|---|
| Per runtime | servers, hours run, memory-hours, hours played, player-hours, storage, backups; usage cost (list prices for runtimes billed by the server); capacity cost (machines over the window), how much of it was idle, and *running utilization* (memory-hours servers ran ÷ memory-hours the machines offered); revenue and payment fees; margin; cost per server, per allocated GB-month, per running hour and per played hour |
| Per machine | price, servers, memory held for running servers and observed in use as a share of what is allocatable, memory placed, and stranded memory: free memory no server size fits, or that has no CPU left |
| Per server | the same, at its share |

**How revenue is attributed:** an owner's orders in the window, after discounts and refunds and
before tax, shared among their servers by the memory-hours each ran. Fees are Polar's Starter rate
on each order's total.

**A sleeping server holds no memory.** A fleet node holds memory for the servers running on it,
or starting; a sleeping one keeps only its disk ([fleet.md §5](fleet.md#5-placement)). A machine's
allocated share is therefore a snapshot of what runs as the report is made. Running utilization,
over the window, is the number that decides what an hour of play costs on machines Blockly pays
for.

**What it can't see yet:**

- Bandwidth: nothing counts bytes.
- Per-server memory and CPU in use: machines report theirs, servers don't.
- Hours on a runtime a server has since left: counted, but not priced, since only the current
  handle can be.

Comparing runtimes by hand:

```sql
-- Hours run and played per runtime this month
SELECT i.provider,
       sum(extract(epoch FROM coalesce(i.stopped_at, now()) - i.started_at)) / 3600 AS hours_run,
       (SELECT sum(active_minutes) / 60.0 FROM server_usage_days u
         WHERE u.provider = i.provider AND u.day >= date_trunc('month', now())) AS hours_played
FROM power_intervals i
WHERE i.started_at >= date_trunc('month', now())
GROUP BY i.provider;

-- Where new servers went this week, and why
SELECT provider, reason, count(*) FROM runtime_decisions
WHERE kind = 'placed' AND at > now() - interval '7 days'
GROUP BY provider, reason ORDER BY count(*) DESC;
```

## 8. Adding a runtime

A runtime is still an adapter:

- `infra/<name>/` implementing `MinecraftRuntime`, including `owns`, `ownsSnapshot`, `hasRoom`,
  `adopt` and `capacity`;
- its `LogSource`, and a console and probe if it doesn't speak RCON and the status ping to
  `endpoint(…, 'control')`;
- its `runtime` variant in `config/`;
- its case in `main.node.ts` `providerFor`.

`runtimesFor` builds every configured runtime and routes between them; nothing above the port
changes.

### Boat beside the others

Boat ([boat-runtime-plan.md](boat-runtime-plan.md)) is the runtime that differs most, and it fits
the same way:

- **Its handles say they're Boat's.** `owns`/`ownsSnapshot` use `isBoatHandle`/`isBoatSnapshot`.
- **Its addresses move.** A sandbox comes back at another address on every resume, and a stopped
  sandbox's address may go to anyone's. So `start` returns the handle to keep, and
  `stableEndpoints` is asked per handle (`Runtimes.stableEndpoint`): the edge routes a stopped
  Boat server nowhere, while a stopped Fly or fleet server keeps its route.
- **Its console, probe and logs go through its command endpoint**, not the network. They are
  registered as Boat's in `RoutedAdapters`.
- **`hasRoom`** is a region in `BOAT_REGION_MAP` (or `RUNTIME_REGION_MAP`, where Boat is the
  default runtime), while the plan has starts to spare beyond the share kept for wakes
  (`BOAT_START_RESERVE`): a new server spends a start now and more every time it wakes.
- **`adopt`** is a handle with no sandbox, as `release` leaves one. A restore from an archive makes
  the sandbox, as a wake of a resting Boat server does.
- **`capacity`** is null: Boat bills by the second a sandbox runs.

Fly, Boat and the fleet together:

```sh
RUNTIME_PROVIDER=fly
RUNTIME_PROVIDERS=fly,boat,fleet
RUNTIME_REGION_MAP=eu:fra,us:iad      # Fly: every region
BOAT_REGION_MAP=eu:eu                 # Boat: Europe only
FLEET_REGION_MAP=eu:eu-rbx            # the fleet: where it has nodes
```

Then, for example, one rule sends 5% of new free servers in Europe to Boat, and another sends
named accounts to the fleet. Every server stays where it was placed until an operator moves it.

## 9. Limits

- Placement weighs rules and room only. There are no prices, no performance and no optimiser:
  those come from what the canary measures.
- A move costs one restart, and a stopped server stays stopped. There is no live migration.
- The fallback covers only the first start of a server a rule sent to another runtime. A server
  already running elsewhere is never moved because its runtime filled.
- Revenue attribution is per owner and by memory-hours, so an owner whose servers sit on two
  runtimes splits their payment between them.
