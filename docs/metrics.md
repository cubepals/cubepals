# Metrics

What Cubepals counts and times, served in Prometheus's format so Fly's managed Prometheus holds it beside every machine's CPU, memory and network. Dashboards and alerts are built from the names below.

## How they get there

- The control plane (api and worker), realtime and the edge each serve `/metrics` on `METRICS_LISTEN` (`0.0.0.0:9091` in `infra/fly/*.toml`). The port is in no `[[services]]` or `[http_service]` block, so Fly publishes nothing there: only its private network scrapes it.
- Each app's `[metrics]` (control: one `[[metrics]]` for both process groups) tells Fly to scrape every 15 seconds. Unset, `METRICS_LISTEN` serves nothing, as in local runs and tests.
- The library is OpenTelemetry's JS SDK with its Prometheus exporter. Instrumentation calls the API's global meter (`apps/control/src/app/platform/telemetry.ts`, `apps/edge/metrics.ts`), which does nothing until a process registers a provider, so no service takes a metrics dependency. prom-client would also fit; OpenTelemetry was kept because the control plane already carries its API (pg-boss needs it) and traces can follow with no change to the call sites.
- Query them at `https://api.fly.io/prometheus/<org>/` with a Fly token, like the built-in metrics.
- pg-boss reports its own jobs on the same provider (`messaging_*`, below): nothing in Blockly counts them.
- The web app runs as a Cloudflare Worker, not on Fly's machines, so nothing here measures it; its `/api` calls are counted where they arrive, at the api.

Labels never name a server, player or address. Fly sets `app`, `region`, `host` and `instance` itself and overwrites a custom label of those names, so a server's region is `server_region` and the region a player's edge is in is `edge_region`.

Counters get Prometheus's `_total` suffix; histograms are `_bucket`, `_sum` and `_count`. For p95 of joins: `histogram_quantile(0.95, sum by (le) (rate(cubepals_join_duration_seconds_bucket[15m])))`.

Where OpenTelemetry's semantic conventions name a figure (HTTP, RPC, database clients, messaging), it keeps their name, labels and advised buckets, with each dot an underscore: `http.server.request.duration` is `http_server_request_duration`, `http.route` is `http_route`. The exporter adds no unit suffix to those names; every duration among them is in seconds.

## Questions these answer

| Question | PromQL |
|---|---|
| Is the API up? | `sum(rate(cubepals_http_requests_total{listener="api",http_route="/api/health/live",status_class="2xx"}[5m])) > 0`, and the share of 5xx: `sum(rate(cubepals_http_requests_total{listener="api",status_class="5xx"}[5m])) / sum(rate(cubepals_http_requests_total{listener="api"}[5m]))` |
| API p99 | `histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_bucket{listener="api"}[5m])))`; by procedure: `histogram_quantile(0.99, sum by (le, rpc_method) (rate(rpc_server_call_duration_bucket[5m])))` |
| Edge p99 | `histogram_quantile(0.99, sum by (le, edition) (rate(cubepals_edge_first_byte_seconds_bucket{intent="join"}[5m])))` |
| Is the database saturated? | `max(cubepals_db_connections) / max(cubepals_db_max_connections)`; waits for a pool: `sum by (app, db_client_connection_pool_name) (db_client_connection_pending_requests)`; query p99: `histogram_quantile(0.99, sum by (le) (rate(db_client_operation_duration_bucket[5m])))` |
| Are jobs failing? | `sum by (messaging_destination_name) (rate(messaging_process_duration_count{error_type!=""}[15m]))` |

## Control plane

Counted where each thing happens, in whichever of the api and worker ran it. Sum across instances.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_join_duration_seconds` | histogram | `path` (`direct`, `held`, `unknown`), `edge_region` | From the player's handshake at the edge to the server's own word that they are in the world. Observed once per join; a join only the server reported has no handshake and is left out. |
| `cubepals_wake_duration_seconds` | histogram | `edge_region` | From the edge asking for a wake to the server being ready, as the edge reported it. Once per held join that was let in. |
| `cubepals_wake_answers_total` | counter | `outcome` (`ready`, `starting`, `restarting`, `asleep`, `denied`), `reason` | What the control plane answered each wake ask. `reason` is why a join was `denied` (`unknown`, `suspended`, `paused`, `quota`, `deleted`, `failed`, `broken`) or, for `starting`, what the start waits behind (`rest`, `stop`, `backup`); `none` otherwise. A held join asks again every few seconds, so this counts asks, not joins. |
| `cubepals_operation_duration_seconds` | histogram | `kind`, `outcome` (`succeeded`, `failed`, `cancelled`) | From an operation being queued to it ending, the figure `bun scripts/ops.ts health` reports. |
| `cubepals_operation_failures_total` | counter | `kind`, `step` | Operations that failed for good, by the step they had reached (`none` before the first). |

## HTTP

Every listener the control plane runs: `api` (the public API: tRPC and plain routes), `internal` (the edge's protocol and the operators' APIs) and `worker` (a worker's health). Labels are the route *template* the request matched (`/api/public/servers/:slug`, `/*` when no route did), never the path asked for, so no id or name reaches a label. A method HTTP doesn't define is `_OTHER`.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_http_requests_total` | counter | `listener`, `http_route`, `http_request_method`, `status_class` (`2xx`, `3xx`, `4xx`, `5xx`) | Requests answered, health checks included. Errors are its `4xx` and `5xx`. A handler that throws past every other counts as `5xx`. |
| `http_server_request_duration` | histogram | the same | Seconds from a request arriving to its answer, health checks (`/api/health`, `/api/health/live`, `/health`) left out. Buckets: OpenTelemetry's advice, 5 ms to 10 s. |
| `rpc_server_call_duration` | histogram | `rpc_system` (`trpc`), `rpc_method`, `status_class` | Seconds each tRPC procedure took, by its path as the router defines it (`servers.list`). The web app batches calls, so one request to `/api/trpc/*` can hold several; each is timed here on its own. A path the router doesn't define never runs, and is never a label. |

## Realtime connections

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_realtime_connect_duration_seconds` | histogram | `transport` (`webtransport`, `websocket`), `outcome` (`accepted`, `origin`, `ticket`) | Seconds the realtime role took to let a browser in, or refuse it and why: a page that isn't Cubepals' own (`origin`), or a ticket it couldn't verify (`ticket`). The count is the connects. |

## Database, from the app's side

Per process, in every role. `db_client_connection_pool_name` is `queries` (the control plane's own queries) or `jobs` (pg-boss's); `role` is the process's roles (`api`, `worker`, `realtime`, joined by `+` where one process runs several).

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `db_client_connection_count` | gauge | `db_client_connection_pool_name`, `role`, `db_client_connection_state` (`used`, `idle`) | Connections the pool holds. |
| `db_client_connection_max` | gauge | `db_client_connection_pool_name`, `role` | The most the pool may hold (`DATABASE_POOL_MAX`). |
| `db_client_connection_pending_requests` | gauge | `db_client_connection_pool_name`, `role` | Queries waiting for the pool to give them a connection. Above zero for long means the pool is too small or the database too slow. |
| `db_client_operation_duration` | histogram | `db_system_name` (`postgresql`), `db_client_connection_pool_name` (`queries`), `role`, `db_operation_name`, `error_type` | Seconds each query on the `queries` pool took. `db_operation_name` is the statement it opens with (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `WITH`, `BEGIN`, `COMMIT`, …; `_OTHER` for the rest), never its text. A failed query has `error_type`: its SQLSTATE class (`23` integrity, `40` rollback, `57` operator intervention, …), or `_OTHER` with none, as when a connection drops. Buckets: OpenTelemetry's advice, 1 ms to 10 s. |

## Database, from Postgres

Read by the worker role alone, every 30 seconds, over one connection of its own, with one statement that reads only Postgres's statistics views; a scrape reports the last read and never waits on the database. Nothing is reported until a read succeeds. With more than one worker, take the `max`.

Postgres is read rather than Supabase's metrics endpoint: the same figures come from every database the control plane runs on (staging's is Postgres on a Fly Machine), and Fly's Prometheus scrapes only machines in the organization, which that endpoint is not.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_db_connections` | gauge | | Client connections Postgres holds now, from every app and person. |
| `cubepals_db_max_connections` | gauge | | Postgres's `max_connections`. |
| `cubepals_db_oldest_transaction_seconds` | gauge | | Age of the oldest open transaction, idle ones included; 0 with none. A role without `pg_read_all_stats` sees only its own role's. |
| `cubepals_db_cache_hit_ratio` | gauge | | Share of reads served from Postgres's memory since its statistics were last reset. |
| `cubepals_db_size_bytes` | gauge | | The database's size on disk. |
| `cubepals_db_replication_lag_seconds` | gauge | | How far the furthest replica's replay lags; absent with no replica. |

## Jobs

pg-boss reports these itself, on OpenTelemetry's messaging conventions, in every process that works or sends jobs.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `messaging_process_duration` | histogram | `messaging_destination_name` (the queue), `error_type`, and pg-boss's own (`messaging_system`, `messaging_operation_name`, `messaging_operation_type`, `db_namespace`, `pgboss_schema`) | Seconds a worker took over each batch of jobs. A failed one has `error_type`, the class of what it threw (`Error`, `TypeError`, …); its count is the failures. Its buckets stop at 10 s: a server operation, which runs for minutes, is timed whole by `cubepals_operation_duration_seconds`. |
| `messaging_client_operation_duration` | histogram | the same, with the operation (`send`, `fetch`, `complete`, `fail`, …) | Seconds each of pg-boss's own operations took. |
| `messaging_client_consumed_messages_total`, `messaging_client_sent_messages_total` | counter | `messaging_destination_name`, and pg-boss's own | Jobs taken and sent. |
| `pgboss_queue_jobs` | gauge | `messaging_destination_name`, `pgboss_job_state` (`deferred`, `ready`, `blocked`, `active`, `failed`), and pg-boss's own | Jobs in each queue by state, as pg-boss last cached them. `cubepals_queue_depth` is the worker's own read of the same queue. |

Scheduled passes (`job_health`) are not pg-boss jobs: `bun scripts/ops.ts health` and `/api/health` report them.

## Process

Every process: the control plane's (labelled with its `role`) and the edge agent's (`role="edge"`). OpenTelemetry's runtime instrumentation isn't used: it reads Node's event-loop utilization, which Bun, the edge agent's runtime, reports as zero. A timer's lateness reads the same under both.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_event_loop_lag_seconds` | histogram | `role` | How much later than asked the event loop ran a timer, sampled every half second. A p99 near a second is a process too busy to answer. |
| `cubepals_heap_used_bytes` | gauge | `role` | JavaScript heap in use. |

## Figures from the database

Read when Prometheus scrapes, by the worker role only. With more than one worker each reports the same figures: take the `max`, not the sum.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_servers` | gauge | `state`, `server_region` | Servers now. `state`: `running`, `asleep`, `resting` (world in the archive), `failed`, `busy` (starting, stopping or changing), `trashed` (in the trash, not yet purged). |
| `cubepals_players_online` | gauge | `server_region` | Players the servers last reported on them, for servers not trashed. |
| `cubepals_queue_depth` | gauge | `queue` | Jobs waiting to be worked, by queue. |
| `cubepals_operations_open` | gauge | `kind`, `status` (`queued`, `running`) | Server operations not yet ended. |
| `cubepals_operations_oldest_queued_seconds` | gauge | `kind` | Age of the oldest queued operation of the kind; absent when none is queued. |

## Realtime

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_realtime_browsers` | gauge | | Browsers connected now. |
| `cubepals_realtime_console_tails` | gauge | | Server consoles followed for someone watching. |

## Edge

Per edge machine; sum or take quantiles across instances.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_edge_hold_duration_seconds` | histogram | `outcome` (`let_in`, `turned_away`, `gave_up`), `reason` | How long the waiting room held a join. `reason` is why a join was turned away (the key of the line the player read: `starting`, `rest`, `stop`, `backup`, `restarting`, `unreachable`, `failed`, `broken`, `unknown`, `deleted`, `paused`, `suspended`, `quota`, `asleep`); `none` for the others. |
| `cubepals_edge_held_joins` | gauge | | Joins the waiting room holds now. |
| `cubepals_edge_route_poll_duration_seconds` | histogram | `answered` | How long asking the control plane for routes took. |
| `cubepals_edge_route_poll_age_seconds` | gauge | | Seconds since the control plane last answered a route poll. Rising means the edge works from routes it can no longer refresh. |
| `cubepals_edge_connections_total` | counter | `edition` (`java`, `bedrock`), `outcome`, `reason`, `edge_region` | Each connection the front door takes, counted once, when its greeting ends. `accepted` (`reason="none"`): what it was handed to answered. `refused` by the edge: `address` (too many from one address at once), `busy` (its server takes no more just now), `wrong_game` (a client the server can't take). `failed`: `silent` (closed having sent nothing, as a port check does), `closed` (closed mid-greeting), `bad_greeting` (not Minecraft), `greeting_timeout`, `backend` (what it was handed to closed before answering), `left` (the player went first). Bedrock players' connections come through Geyser. Fly's own connections are left out. |
| `cubepals_edge_proxied_bytes_total` | counter | `edition`, `direction` (`up` from players, `down` to them), `edge_region` | Bytes passed between players and what the edge handed them to, counted as each connection closes. |
| `cubepals_edge_first_byte_seconds` | histogram | `edition`, `intent` (`join`, `ping`), `edge_region` | From the edge accepting a connection to the first byte back through it: the server's, or the waiting room's while it wakes. |
| `cubepals_edge_geyser_up` | gauge | `edge_region` | 1 while Geyser runs and answers, so Bedrock players can join; 0 while it starts, restarts or failed to. Absent where the edge takes no Bedrock players. |
