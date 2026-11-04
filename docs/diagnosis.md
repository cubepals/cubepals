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
| Why is this one person having a bad time? | `ops.ts diagnose <email or id> [--since 24h\|7d\|<ISO>]` | `account_diagnose` |
| Which queries, procedures or requests are slow or failing, and for whom? | `ops.ts diagnostics summary [--by name\|account\|server\|origin\|kind]` | `diagnostics_summary` |
| What exactly happened to that one? | `ops.ts diagnostics --name <q:…> \| --account <email> \| --server <id>` | `diagnostics_list` |
| Is the database itself struggling? | `ops.ts database [--order total\|mean\|calls\|max]` | `database_now` |
| Why did this join fail or take so long? | `ops.ts join <player or join id> --markdown` | `join_get` |
| Why did this start or wake fail or take so long? | `ops.ts operations --server <id> --status failed`, then `ops.ts operation <id>` | `operations_list`, `operation_get` |
| What does the server's own log say? | `ops.ts console <server> --lines 200` | `console_read` |
| Is the platform as a whole up and fast? | `ops.ts health`, and the metrics ([metrics.md](metrics.md)) | `health` |

`diagnose` is the one to run first for a person. It puts together, for the account and its servers
since the moment given (a day ago by default):

- who it is (email, plan, standing, whether it is a test account) and its servers;
- the operations on its servers that failed, and the slowest that succeeded;
- joins that stopped before the world or were turned away, newest first;
- the signals raised on its servers ([production.md](production.md#from-the-command-line), `signals`);
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

## Errors in PostHog

Production sends the API's errors to PostHog's EU project as `$exception` events
([configuration.md](configuration.md#product-analytics-optional)): a tRPC procedure's 5xx and
anything the API didn't catch, with `distinct_id` the account it was for when one was signed in,
and `request_id`. To find one account's: `$exception` events where `distinct_id` is its id. A
record here with an `error` of 5xx and a `request_id` is the same failure as the exception with that
`request_id`.

## What this doesn't see

- A query on pg-boss's own pool (jobs) is timed by pg-boss itself, not kept here
  ([metrics.md](metrics.md), Jobs).
- The website's own rendering runs on Cloudflare, not on the control plane: only its calls to
  `/api` are seen, where they arrive.
- A server's tick rate, memory and crashes are the game's, not the control plane's: a join's tick
  is in its record (`join_get`), and the server's log is `console_read`.
