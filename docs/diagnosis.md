# Diagnosis

How to find out why someone is having a bad time on Cubepals, for one account, for a group of them,
or for the whole platform, and where each piece of the answer is kept. It is written so a person or
an agent can follow it from a question ("an owner says their server is slow") to the record that
explains it, in as few calls as possible.

Everything here reads; nothing changes anything. It is reached through the operators' API on the
control plane's internal listener: `bun scripts/ops.ts` from a terminal, or the ops MCP server
(`scripts/ops-mcp.ts`) from an agent, as [production.md](production.md#from-the-command-line) sets
them up. Each command below has a tool of the same purpose, named after it.

## Start here

| The question | Ask | Tool |
|---|---|---|
| What happened on this server? | `ops.ts timeline <server> [--since 24h\|7d\|<ISO>]`: its operations and why each went as it did, its joins and how each session ended, its signals, in time order | |
| Why is this one person having a bad time? | `ops.ts diagnose <email or id> [--since 24h\|7d\|<ISO>]` | `account_diagnose` |
| Which queries, procedures or requests are slow or failing, and for whom? | `ops.ts diagnostics summary [--by name\|account\|server\|origin\|kind]` | `diagnostics_summary` |
| What exactly happened to that one? | `ops.ts diagnostics --name <q:…> \| --account <email> \| --server <id>` | `diagnostics_list` |
| Is the database itself struggling? | `ops.ts database [--order total\|mean\|calls\|max]` | `database_now` |
| Why did this join fail or take so long? | `ops.ts join <player or join id> --markdown` | `join_get` |
| Why did this start or wake fail or take so long? | `ops.ts operations --server <server> --status failed`, then `ops.ts operation <id>` | `operations_list`, `operation_get` |
| Which servers lag, and whose are they? | `ops.ts vitals [--account <email>] [--since 24h]` | `vitals_list` |
| How did this one server tick? | `ops.ts vitals <server> [--since 24h]` | `server_vitals` |
| What does the server's own log say? | `ops.ts console <server> --lines 200` | `console_read` |
| Is the platform as a whole up and fast? | `ops.ts health`, and the metrics ([metrics.md](metrics.md)) | `health` |

Every command that takes a `<server>`, and every `--server`, takes what a player calls it: its slug,
the address they join (`v0idworld.play.cubepals.com`), its name, or its id
(`/ops/v1/servers/find`). One that names several servers says each and stops.

`diagnose` is the one to run first for a person. It puts together, for the account and its servers
since the moment given (a day ago by default):

- who it is (email, plan, standing, whether it is a test account) and its servers;
- the operations on its servers that failed, and the slowest that succeeded;
- joins that stopped before the world or were turned away, newest first;
- the signals raised on its servers ([production.md](production.md#from-the-command-line), `signals`);
- how its servers ticked, the most minutes behind first;
- what ran slow or failed in the control plane for it, grouped by what it was, and the newest;
- where else to look, by name: its errors in PostHog, a server's log, one join's story.

## One account, a group, the whole platform

The same records answer all three; only the filter changes.

- **One account**: `--account <email>` (or `account_diagnose`). An account's records are its own
  (work done while it was signed in) and those of work done on its servers, a worker's included.
- **A group**: `diagnostics summary --by account` names the accounts a slow query or a failing
  procedure touched, the most first. Narrow it with `--name <q:…>` to see who one query hurt, with
  `--origin trpc:servers` to see who one part of the site hurt, or with `--server <id>` for one
  server's players' owners. Each group says how many accounts and servers it touched.
- **The whole platform**: `diagnostics summary --by name` lists what is slow or failing, with p50,
  p95, max and how many failed, the most frequent first. The metrics answer the same without
  naming anyone ([metrics.md](metrics.md)), and are where a trend over weeks is.

## How far a join got

A join's row says how far it got, each step by whoever saw it (`ops.ts join <id>`,
`ops.ts timeline <server>`):

- **It reached no server**: `handed_at` is null, and `left_reason` says why once it is known.
  `refused:` and a word of the edge's (`wrong_game`, `busy`, `restarting`, a wake's refusal such as
  `starting` or `quota`) is a join the edge turned away, telling the player why.
  `refused:missing-backend` and `refused:failed-backend-connection` are mc-router's own statuses
  for a join it connected to nothing and closed with nothing said: it held no backend for the
  address, or the server didn't take its connection (`apps/edge/router-session.ts`). Its `path` is
  `refused`, whatever its route said. `gave_up_waiting` is a player who left the waiting room.
- **It was handed to its server**: `handed_at` is set, and `path` is `direct` or `held`.
- **It logged in, configured and was in the world**: `login_at` to `in_world_at`, which only the
  server's own reporter tells, a Paper plugin (`apps/reporter`), placed where `JOIN_REPORTER` says
  on a Paper server that plays no modpack, and wherever Stop cheaters runs, from its next full
  boot. Its rows read `server_side = 'reported'`.

A vanilla, Fabric, Forge or NeoForge server, a modpack, and a Paper server without the plugin
report nothing: `login_at` and `in_world_at` stay null on a join that got in as on one the game
refused. Such a server has a second, coarser witness, its own player list, which the control plane
reads over its console once a minute (`presence-sync`, `app/joins/player-list.ts`):

- **Its player was on the list**: `detail.listedAt` is when the list first showed them, and
  `server_side` reads `console`. The join got in. The moment is the reading's, up to a minute
  after the player came in, so it says nothing of how long the join took: `slow_join` and every
  other figure are measured by the reporter's own times and never by this one. Of two joins of
  one player still open, a retry seconds after a failed try, the one handed over last is marked.
- **Its player wasn't on it a minute or more after the join was handed over**:
  `detail.notListedAt` is that reading. Once the join has ended it stopped short: it never
  reached the world, or was in it for less than a minute. No join is marked so while a Bedrock
  player nobody could tie to a join is on, since Floodgate lists them under a name of its own,
  nor by a list that counted a player it didn't name.
- **Neither**: nobody could tell. The join ended before a reading a minute after it was handed
  over, or the list couldn't be read. It is called neither in the world nor stopped short. What
  the edge relayed is all that was seen of it: `bytes_down`, how long it lasted (`handed_at` to
  `left_at`), and which side closed first (`detail.session`, below). A login the game refused
  ends within seconds, closed by the server, with little sent back; a join that got in is sent
  its world.

The edge tells of a join's end two minutes after it, so a join is open on its row for a while
after it ended. A mark the list made in that while is taken back once `left_at` is known. Where
the reporter told of a join too, its row reads `reported`, `in_world_at` is the reporter's own
time, and `detail.listedAt` stays beside it as what the list saw.

The edge can't read which way a login went: a server that checks accounts has the client encrypt
the connection before the login ends, and what follows is unreadable to it. Where the game refused
a join for a ban or its whitelist, the row says so from the server's lists (`refused:banned`,
`refused:whitelist`, `app/joins/refusals.ts`), unless its player list showed the player in the
world. `ops.ts timeline` prints a join the list showed as in the world, on its player list by that
reading; one it didn't show as handed to the server and not on its player list; and one nobody
could tell of as handed to a server that reports no login, with the bytes that came back.

**Joins that stopped short** (`ops.ts diagnose`, `account_diagnose`) are the joins known not to
have got in (`stoppedShort` in `app/joins/reached.ts`): turned away (`refused:*`); never handed to
a server; and handed over without reaching the world by the word of whoever could tell. On a
server with a reporter that is every join with no `in_world_at` its player list didn't show
either, since the reporter tells of every login. On a server without one it is a join that ended
with its player list not having shown the player, as above. A server
is read as having a reporter when it told of its boot (`server_reports`) and its newest
`server_vitals` sample isn't the console's: a server that left Paper keeps its old boot report,
and its ticks are read over its console from then on.

## How a session ended

When a player's connection through the edge closes, its join keeps how the session went, as
`detail.session` (`apps/edge/session-end.ts`; `ops.ts join <id>`, `join_get`):

- `longestQuietMs` and `longestQuietFrom`: the longest the player's side sent nothing, and when it
  began. A client in the game sends something every fraction of a second, so seconds of silence
  are a stall on the player's way to the edge (their machine, their network, or the path to Fly).
- `stalls`: how many times the player was quiet for 5 s or more, so a session that survived its
  stalls still shows them.
- `quietAtEndMs`: how long the player had been quiet when it ended. A drop the server timed out
  (`lost connection: Timed out` in its log) reads 15 to 30 s here, with `closedFirst: "server"`.
- `downQuietAtEndMs` and `mostQueuedDown`: how long since anything went toward the player, and the
  most that waited at the edge to go to them. A large backlog is a path toward the player that
  couldn't keep up.
- `longestHeldMs`, `heldStalls`, `heldAtEnd` and `mostQueuedUp`: stretches in which the edge had
  stopped reading the player because the way on to the server was full. They are the server
  side's, not the player's, and aren't in the figures above.
- `closedFirst` (`player` or `server`) and `how` (`reset` with its `error`, `timeout`, `closed`).

A drop with the player quiet for seconds while the edge still had data to send them, and the
server closing first, happened between the player and the edge, not in Cubepals' servers.
`ops.ts join <id> --markdown` prints all of this under "How the session ended", and says which side
it points to. The edge sends a join's end two minutes after the player leaves, so a join read
sooner shows no leaving yet.

On Fly, the `dropped` signal such a session raises also keeps what Fly's own proxy wrote about the
edge around it (`detail.provider`, `app/joins/provider-said.ts`): its lines from five seconds before
the player's side went quiet to thirty after the session ended, read once from Fly's log history
(`FlyLogSource.edgeSaid`), with the addresses taken out. Each opens with one of Fly's proxy error
codes (docs.fly.io/monitoring/error-codes). An empty list is an answer too: the proxy carried the
connection and wrote nothing while the player's side was quiet, so the break was in front of it. The
signal's email says the last line, or that the proxy said nothing. Where the proxy can't be read the
signal is raised without it.

## How wakes and operations went

The `signals` job also reads operations, for the kinds `SIGNALS` turns on
(`app/joins/operation-signals.ts`), each raised once per operation:

- `wake_booted`: a start that booted although its server slept with its memory, with the runtime's
  `reasons` (`other_spec`, `memory_lost`, `resume_booted`, `resume_hung`) and what `changed` since
  it went to sleep (the wake's `changed:*` marks, [waking.md](waking.md)). A refresh (`stale-sleep`),
  which boots so that a player's wake doesn't, never raises it.
- `slow_operation`: an operation past its kind's figure in seconds (`byKindS`), finished or
  still `running`, with the step it is on; a start that resumed is held to `resumeS`.
- `retried_operation`: an operation that took more than one attempt, with its last error.

The kinds `notify` lists are emailed to the admin inbox as one digest a pass, each signal once
(`app/joins/signal-mail.ts`). `ops.ts signals` lists the open ones.

## What ran slow or failed

The control plane keeps one row in `diagnostics` (`packages/db/src/schema/diagnostics.ts`) for each
slow or failed:

| Kind | Kept when | Named by |
|---|---|---|
| `query` | it took 250 ms or more, or Postgres refused it | its shape, `q:` and 12 hex characters |
| `procedure` | a tRPC procedure took a second or more, or answered with a 5xx | its path, `servers.get` |
| `request` | an HTTP request took two seconds or more, or answered with a 5xx | its method and route template, `POST /api/trpc/*` |

Each row says, where it was known:

- `account_id`: whose session the work ran in, or the owner of the server an operation ran on;
- `server_id`: the server a procedure's input named (`serverId`), or the one an operation ran on;
- `request_id`: the request it ran in, the one the API sends back as `x-request-id`;
- `origin`: what it ran under: `trpc:<path>`, `http:<listener> <route>`, `operation:<kind>`,
  `schedule:<job>`, or `process` for anything else;
- `role`: the process (`api`, `worker`, `realtime`, joined by `+` where one runs several);
- `error`: a query's SQLSTATE (`57014` a statement timeout, `40P01` a deadlock, `_OTHER` a dropped
  connection), or the HTTP status a 5xx answered with; null when it was only slow;
- `detail`: a query's statement with every value taken out (parameters as `$n`, literals as `?`),
  and an error's first line.

**A query's shape** is its statement with what varies taken out (`app/diagnostics/statement.ts`):
spacing, literals, and how many values a list or an insert holds. Every run of one query in the
code has the same name, whatever its values; two different queries never do. Its statement reads
like the one `database_now` lists from `pg_stat_statements`, so the two can be matched by eye.

Rows are kept 14 days (`diagnostics-sweep`, hourly). They are written every two seconds, a batch
at a time, so a request never waits on its own record; at most 5 a minute for one thing for one
account, 300 a minute per process, and 1,000 waiting to be written. Past that a row is dropped
rather than kept, so a slow database is never made slower by its own record. Writing them is never
recorded itself.

**How a row knows whose it was.** Work opens a context where it enters the control plane
(`app/diagnostics/context.ts`): an HTTP listener (`interfaces/http/measured.ts`), each tRPC
procedure (`interfaces/trpc/trpc.ts`), each operation (`app/operations/runner.ts`) and each
scheduled pass (`app/scheduled-jobs.ts`). The context learns the request's id, then the account
once the session is read, then the server once an operation is loaded or a procedure's input names
it. The query pool tells the recorder of each query in the context that asked for it, not the one
that happened to give back the connection (`infra/metrics/pools.ts`).

## The database now

`ops.ts database` reads Postgres's own statistics as it is asked:

- **Connections** by application and state. The control plane names its own: `blockly-api`,
  `blockly-worker`, `blockly-realtime` (or the roles one process runs, joined by `+`),
  `blockly-jobs` (pg-boss), `blockly-events`, `blockly-changes` and `blockly-metrics`.
- **What runs long or waits**: queries running more than a second, or waiting on a lock, with the
  pids that hold it.
- **Statements** that took the most time in all since `pg_stat_statements` was last reset, with
  calls, mean, max and cache hits; or why it can't say (not installed, or not loaded at start).
  Supabase has it; a Postgres of our own needs `shared_preload_libraries=pg_stat_statements` and
  `create extension pg_stat_statements`.
- **Tables** that sequential scans read the most rows from: a big number on a big table is an index
  that is missing.

Every query's text passes through the same shaping as the records, so no value anyone typed reaches
an answer.

## How servers tick

Every running server is sampled once a minute, and the samples are kept 7 days (`server_vitals`,
`app/vitals/`). Each says where it came from (`source`):

- **`reporter`**: Paper servers the reporter plugin runs on ([configuration.md](configuration.md),
  Join reporter) sample themselves and post it to the control plane. Everything below is known.
- **`console`**: every other server (vanilla, Fabric, Forge, NeoForge, modpacks, and Paper where
  `JOIN_REPORTER` leaves the plugin off) is asked `tick query` over its own console, in the same
  pass that reads who is on (`presence-sync`). Minecraft 1.20.3 and later answer it, whatever runs
  them. Ticks a second, milliseconds a tick and players are known; chunks, entities, heap and
  collections are null. A server the plugin sampled in the last three minutes isn't asked too, and
  a frozen or sprinting game (`tick freeze`, `tick sprint`) isn't kept.

| Figure | What it says |
|---|---|
| `tps` | Ticks a second over the last minute. 20 is keeping up; under 18 the server is behind, and the minute counts in `laggingMinutes`. From a console: the server's target while its average tick fits in it, `1000 / mspt` when it doesn't. |
| `mspt`, `msptP95`, `msptMax` | Milliseconds a tick: the average, the 95th percentile and the slowest of the last hundred (from a console, the 99th percentile, which `tick query` gives). Past 50 ms on average, a server can't keep up. |
| `players`, `chunks`, `entities` | What it was carrying: players online, chunks loaded and entities in its worlds. |
| `heapUsedMb`, `heapMaxMb` | The JVM's heap in use and its most. A share near 1 with long garbage collection is a server short of memory. |
| `gcMs` | Milliseconds garbage collection paused the game in that minute. |

`ops.ts vitals` starts with the platform now: how many servers are running, how many were sampled
in the last three minutes and from where, how many were behind in their newest sample, and how
many said nothing (`silent`: a version before `tick query`, or a console that didn't answer). Then
it lists the servers that ticked worst since a moment (an hour ago by default), with whose they
are: for one account with `--account`, for the platform without. `ops.ts vitals <server>` gives one
server's minutes. Lag that comes with many entities or chunks is the world's; lag that comes with a
full heap and long collections is memory; lag with neither, on a server few play on, is more likely
the machine (its CPU in Fly's metrics, [metrics.md](metrics.md)). Across the platform, without
naming anyone: `cubepals_server_tick_duration_seconds`.

## Errors in PostHog

Production sends the API's errors to PostHog's EU project as `$exception` events
([configuration.md](configuration.md#product-analytics-optional)): a tRPC procedure's 5xx and
anything the API didn't catch, with `distinct_id` the account it was for when one was signed in,
and `request_id`. To find one account's: `$exception` events where `distinct_id` is its id. A
record here with an `error` of 5xx and a `request_id` is the same failure as the exception with that
`request_id`.

## Operations in PostHog

Each finished operation is sent as `operation_finished` (`app/insight/operations.ts`), with the
account as `distinct_id`, as the funnel's events are: `kind`, `status`, `seconds` from being asked,
`way` (`resumed` or `booted` for a start), `attempts`, `marks` (the steps that say why, such as
`other_spec,changed:drift:image` or `slept`) and `server_id`. A test account's are never sent. How
wakes go, resume rate and wake time by day, is a trend of `operation_finished` where `kind` is
`start`, broken down by `way`.

## What this doesn't see

- A query on pg-boss's own pool (jobs) is timed by pg-boss itself, not kept here
  ([metrics.md](metrics.md), Jobs).
- The website's own rendering runs on Cloudflare, not on the control plane: only its calls to
  `/api` are seen, where they arrive.
- A server before Minecraft 1.20.3 without the reporter plugin has no `tick query`: it counts as
  `silent`, and its log is `console_read`. A console reading has no heap, chunks or entities.
- A crash is the server's latest state (`server_get`), not a history.
