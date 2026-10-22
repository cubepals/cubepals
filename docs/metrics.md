# Metrics

What Cubepals counts and times, served in Prometheus's format so Fly's managed Prometheus holds it beside every machine's CPU, memory and network. Dashboards and alerts are built from the names below.

## How they get there

- The control plane (api and worker), realtime and the edge each serve `/metrics` on `METRICS_LISTEN` (`0.0.0.0:9091` in `infra/fly/*.toml`). The port is in no `[[services]]` or `[http_service]` block, so Fly publishes nothing there: only its private network scrapes it.
- Each app's `[metrics]` (control: one `[[metrics]]` for both process groups) tells Fly to scrape every 15 seconds. Unset, `METRICS_LISTEN` serves nothing, as in local runs and tests.
- The library is OpenTelemetry's JS SDK with its Prometheus exporter. Instrumentation calls the API's global meter (`apps/control/src/app/platform/telemetry.ts`, `apps/edge/metrics.ts`), which does nothing until a process registers a provider, so no service takes a metrics dependency. prom-client would also fit; OpenTelemetry was kept because the control plane already carries its API (pg-boss needs it) and traces can follow with no change to the call sites.
- Query them at `https://api.fly.io/prometheus/<org>/` with a Fly token, like the built-in metrics.

Labels never name a server, player or address. Fly sets `app`, `region`, `host` and `instance` itself and overwrites a custom label of those names, so a server's region is `server_region` and the region a player's edge is in is `edge_region`.

Counters get Prometheus's `_total` suffix; histograms are `_bucket`, `_sum` and `_count`. For p95 of joins: `histogram_quantile(0.95, sum by (le) (rate(cubepals_join_duration_seconds_bucket[15m])))`.

## Control plane

Counted where each thing happens, in whichever of the api and worker ran it. Sum across instances.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `cubepals_join_duration_seconds` | histogram | `path` (`direct`, `held`, `unknown`), `edge_region` | From the player's handshake at the edge to the server's own word that they are in the world. Observed once per join; a join only the server reported has no handshake and is left out. |
| `cubepals_wake_duration_seconds` | histogram | `edge_region` | From the edge asking for a wake to the server being ready, as the edge reported it. Once per held join that was let in. |
| `cubepals_wake_answers_total` | counter | `outcome` (`ready`, `starting`, `restarting`, `asleep`, `denied`), `reason` | What the control plane answered each wake ask. `reason` is why a join was `denied` (`unknown`, `suspended`, `paused`, `quota`, `deleted`, `failed`, `broken`) or, for `starting`, what the start waits behind (`rest`, `stop`, `backup`); `none` otherwise. A held join asks again every few seconds, so this counts asks, not joins. |
| `cubepals_operation_duration_seconds` | histogram | `kind`, `outcome` (`succeeded`, `failed`, `cancelled`) | From an operation being queued to it ending, the figure `bun scripts/ops.ts health` reports. |
| `cubepals_operation_failures_total` | counter | `kind`, `step` | Operations that failed for good, by the step they had reached (`none` before the first). |

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
