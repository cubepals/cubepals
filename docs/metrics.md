# Metrics

The questions the product turns on, and the query that answers each from what
the control plane already keeps (architecture §15.5, telemetry): a durable column or an audit
entry, read with SQL against a read replica or a copy. None of these run inside the product. The
product funnel, feedback and errors go to PostHog as well ([Insight](#insight)).

Every query takes the plan in force the way `loadStanding` does: a paying subscription's plan,
else the account's own. `plan_of` below is that rule; paste it in front of any query that needs it.

Test accounts are Cubepals' own, made or marked by an admin to test production with
(`account_standing.test_account`). They aren't customers: leave them out of every count
(`and not s.test_account`). The product does the same where it counts: free places at sign-up,
the runtime economics report, and what goes to PostHog and the billing provider.

```sql
with plan_of as (
  select s.user_id,
         coalesce(
           (select b.plan_key from billing_subscriptions b
             where b.user_id = s.user_id
               and b.status in ('active', 'trialing')
               and (b.current_period_end is null or b.current_period_end > now() - interval '3 days')
             order by b.updated_at desc limit 1),
           s.plan) as plan
    from account_standing s
)
```

## Insight

PostHog's EU cloud holds three things: the funnel, feedback, and errors. Production alone sends
them (`POSTHOG_TOKEN`, `NEXT_PUBLIC_POSTHOG_TOKEN`, [configuration.md](configuration.md)); every
event carries `environment` (`production`, `staging`, `development`), and the project's test-account
filter leaves out all but production. With no token nothing is sent. Nothing about a test account
is sent: its funnel events stay unsent, its feedback goes nowhere, and it is never asked how it's
going.

**The funnel**, sent by the control plane with the account's id as `distinct_id`, never its email.
Each is written once, in the transaction of what it describes, to `insight_events` (unique on
event and subject), and the worker's `insight-send` job sends what is unsent every minute; PostHog
being away only delays them. The names are a contract with the dashboard:

| Event | Once per | Kept where (`apps/control/src/app/insight/record.ts`) |
|---|---|---|
| `signed_up` | account | `AccountService.opened`, as Better Auth makes the account |
| `server_created` | server | `MinecraftServerService.createMinecraftServer`'s transaction (`from`, `loader`) |
| `server_first_started` | server | `openInterval`: the first power interval a server ever opens is its first successful start |
| `moment_first_wake` | account | `openInterval` with `woken`: a connection woke one of its servers |
| `moment_first_friend_joined` | account | the presence sync: a name the server itself reports on any of the account's servers that isn't the first name ever seen on them. Nothing links an account to a Minecraft player, so the first name counts as the owner's, as the north-star query below counts |
| `moment_first_week` | account | the presence sync, while someone is on: `server_usage_days` with play on the account's servers falls in two calendar weeks (Monday–Sunday, UTC). One indexed query a minute per server with players on, skipped once the account has it |
| `plan_upgraded` | account and plan | `BillingService.syncSubscription` from the provider's webhook alone, with `plan` |

```sql
-- What is waiting to be sent, and what went:
select event, count(*) filter (where sent_at is null) as waiting, count(sent_at) as sent
  from insight_events group by 1 order by 1;
```

**Feedback** is PostHog's `Feedback` survey (`survey sent`, with the survey's `$survey_id` and the
answer under its `$survey_response_<question id>`), sent the moment it is written from the
sidebar, with the sender's `email` (feedback alone carries one), `plan`, `page` and `app_version`.
Three a minute per account.

**"How's it going?"** follows the three moments: each leaves a row in `insight_asks`, and the next
time the owner opens the app a card asks about the newest, at most once a fortnight, never while
they are making a server or paying (the create and checkout pages, a server still provisioning, a
checkout started within the hour that hasn't changed the plan yet), and never again once put away.
The answer is the `Good moment` survey; `survey shown` and
`survey dismissed` go too.

**Errors:** the browser's uncaught errors and what the app's error boundaries catch, through
`posthog-js`; the control plane's unhandled errors and every 5xx, with the route and the request's
id (`x-request-id`), never its body.

The browser runs cookieless (`cookieless_mode: 'always'`): no cookie, local or session storage,
no identify, no recordings (posthog-js makes none in cookieless mode), no autocapture of clicks,
dead clicks or text, no heatmaps. It sends pageviews, page leaves, web vitals and errors.

## Getting started

**Where accounts come from** (the `ref` or `utm_source` on the link that brought them, kept in the
week after sign-up; null when no link said):

```sql
select date_trunc('week', created_at) as week, coalesce(signup_source, '(none)') as source, count(*)
  from account_standing
 group by 1, 2
 order by 1 desc, 3 desc;
```

**Servers made, and how** (template, curated, modpack, upload, copy, invite, direct; null before it
was kept):

```sql
select date_trunc('week', created_at) as week, created_from, count(*)
  from minecraft_servers
 group by 1, 2
 order by 1 desc, 2;
```

**Which curated pack.** The audit entry carries the pack's key and the release it pinned:

```sql
select data->>'curated' as pack, data->>'release' as release, count(*)
  from audit_log
 where action = 'server.created' and data ? 'curated'
 group by 1, 2
 order by 3 desc;
```

**Which template.** The audit entry carries the key:

```sql
select data->>'template' as template, count(*)
  from audit_log
 where action = 'server.created' and data->>'from' = 'template'
 group by 1 order by 2 desc;
```

**First join, and a friend joining** (the north star: a server where a second player joined):

```sql
select m.id,
       m.created_at,
       min(p.first_seen_at) as first_join,
       (array_agg(p.first_seen_at order by p.first_seen_at))[2] as friend_join
  from minecraft_servers m
  left join server_players p on p.server_id = m.id
 group by m.id, m.created_at;
```

The share of servers made in a week that a second player joined:

```sql
select date_trunc('week', m.created_at) as week,
       count(*) as made,
       count(*) filter (where (select count(*) from server_players p where p.server_id = m.id) >= 2) as friends
  from minecraft_servers m
 group by 1 order by 1 desc;
```

## Usage and cost

**Server-hours by plan and size, this month.** An open interval counts up to now; a wake nobody
joined (`woken`) is shown apart, since it is what a stranger knocking costs.

```sql
-- with plan_of as (...)
select po.plan, i.memory_tier, i.woken,
       round(sum(extract(epoch from (coalesce(i.stopped_at, now()) - greatest(i.started_at, date_trunc('month', now())))) / 3600)::numeric, 1) as hours
  from power_intervals i
  join minecraft_servers m on m.id = i.server_id
  join plan_of po on po.user_id = m.owner_id
 where coalesce(i.stopped_at, now()) > date_trunc('month', now())
 group by 1, 2, 3 order by 1, 2, 3;
```

**Plan usage distribution** (hours a Plus account used of its 60, in the meter's units: a large
size counts two):

```sql
-- with plan_of as (...)
select m.owner_id,
       round(sum(extract(epoch from (coalesce(i.stopped_at, now()) - greatest(i.started_at, date_trunc('month', now())))) / 3600
                 * case when i.memory_tier in ('6g', '8g') then 2 else 1 end)::numeric, 1) as units
  from power_intervals i
  join minecraft_servers m on m.id = i.server_id
  join plan_of po on po.user_id = m.owner_id and po.plan = 'plus'
 where coalesce(i.stopped_at, now()) > date_trunc('month', now())
 group by 1 order by 2 desc;
```

**Storage footprint.** What each world takes, measured as it stops, against the disk it has:

```sql
select m.status, count(*) as servers,
       round(sum(r.disk_used_bytes) / 1e9, 1) as used_gb,
       sum(coalesce(r.storage_gb, 0)) as grown_gb
  from minecraft_servers m
  join server_runtimes r on r.server_id = m.id
 group by 1;
```

**What a resting world costs instead** (its copy in the archive store):

```sql
select count(*) as resting, round(sum(b.size_bytes) / 1e9, 2) as stored_gb
  from backups b
  join minecraft_servers m on m.id = b.server_id and m.status = 'stored'
 where b.trigger = 'stored' and b.tier = 'archive' and b.status = 'ready';
```

**Free cost drivers.** Free servers that still hold a disk, by how long since anyone played: the
ones past two weeks are the next store sweep's.

```sql
-- with plan_of as (...)
select case when m.last_active_at > now() - interval '1 day' then 'today'
            when m.last_active_at > now() - interval '14 days' then 'this fortnight'
            else 'past two weeks' end as last_played,
       m.status, count(*)
  from minecraft_servers m
  join plan_of po on po.user_id = m.owner_id and po.plan = 'free'
 where m.status not in ('deleted', 'purged')
 group by 1, 2 order by 1, 2;
```

**Who would be warned.** Free worlds a retention sweep would write to now (30 days before a
year unplayed), whether or not it is turned on:

```sql
-- with plan_of as (...)
select m.id, m.name, m.last_active_at, m.last_active_at + interval '365 days' as deletes_on
  from minecraft_servers m
  join plan_of po on po.user_id = m.owner_id and po.plan = 'free'
 where m.status not in ('deleted', 'purged')
   and m.last_active_at < now() - interval '335 days'
 order by m.last_active_at;
```

## Resting and waking

**How often, and how long.** The `store` and `unstore` operations' own timestamps:

```sql
select kind, status, count(*),
       percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at)) as median_s,
       percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at)) as p95_s
  from server_operations
 where kind in ('store', 'unstore') and finished_at is not null
 group by 1, 2;
```

A wake that failed put its world back to rest; each is also an audit entry:

```sql
select action, count(*) from audit_log
 where action in ('server.store_incomplete', 'server.kept_unplayed')
 group by 1;
```

### Measured on Fly

What the pages say a wait takes comes from these. Six servers on staging, 2026-10-07, each a new
Free account's plain Minecraft server in `fra`, timed by `bun scripts/staging-waits.ts --rest`
(three with a new world, three with 1 GB more world, the most a Free disk keeps) from the request
to the server running, as its page follows it. Staging ran control `v4` (image
`sha256:a41b4860…`, deployed 2026-10-04 02:39 UTC) and web `v1` (2026-10-03 23:57 UTC): the
numbers are for that build, not a later main. Starts and wakes were asked for through the API,
not by a join through the edge, which the machine that measured couldn't reach.

| Wait | Runs (s) | Median | Slowest |
| --- | --- | --- | --- |
| A new server's first start (app, volume, machine, world made) | 77, 79, 98, 102, 106, 412 | 100 s | 412 s |
| A stopped server's start | 37, 39, 40, 46, 49, 136 | 43 s | 136 s |
| Wake from rest, new world (copy 119 MB) | 59, 78, 84 | 78 s | 84 s |
| Wake from rest, 1 GB world (copy 1,143 MB) | 136, 138, 169 | 138 s | 169 s |
| Rest (`store`), new world | 123, 130, 133 | 130 s | 133 s |
| Rest (`store`), 1 GB world | 450, 460, 580 | 460 s | 580 s |

- **The slowest start** is one machine: its first boot sat 362 s in `booting`, and its next start
  was refused by Fly with 412 "machine still stopping" and went through on the retry, 123 s later.
  The other five never did either.
- **A wake** is the copy coming back, then a new machine, boot and load: `unstore:storage` was 16
  to 18 s for 119 MB and 79 to 86 s for 1,143 MB, and the rest of the wake 41 to 83 s.
- **Release.** Every rested server held no machine and no volume (`fly machines list` and
  `fly volumes list` on its app), and every woken one held one of each. Letting go raced Fly's
  own destroy, though: two of six stores' first attempt found the machine or volume still there
  and passed on the next, and one exhausted its attempts on 412 "volume is currently bound to
  machine" and ended as `server.store_incomplete`, which rests the world anyway and clears what
  is left at the wake.

The per-step split comes from `servers.get`, polled twice a second; each start and wake matches
the operation's own `finished_at - created_at` to within a second. A rest is the `store`
operation's own time, since the sweep picks the server up a few seconds after it is asked to.

## Paying

**Why people pay.** Each checkout records the edge the person met:

```sql
select data->>'reason' as reason, count(*) as checkouts
  from audit_log
 where action = 'billing.checkout_started'
 group by 1 order by 2 desc;
```

**Conversion.** Checkouts that became a plan change within a day:

```sql
select c.data->>'reason' as reason,
       count(*) as checkouts,
       count(p.id) as converted
  from audit_log c
  left join lateral (
    select a.id from audit_log a
     where a.action = 'account.plan_changed'
       and a.subject_id = c.subject_id
       and a.at between c.at and c.at + interval '1 day'
       and a.data->>'to' = c.data->>'plan'
     limit 1) p on true
 where c.action = 'billing.checkout_started'
 group by 1 order by 2 desc;
```

**Revenue, by month.** What Polar was paid, from its order webhooks, refunds taken off. Tax is
Polar's to remit, so what the plans earned is `net_cents`; Polar's own fee is not in the order.

```sql
select date_trunc('month', ordered_at) as month, currency,
       count(*) as orders,
       sum(net_cents - least(refunded_cents, net_cents)) / 100.0 as earned,
       sum(tax_cents) / 100.0 as tax,
       sum(refunded_cents) / 100.0 as refunded
  from billing_orders
 group by 1, 2
 order by 1 desc;
```

**Revenue by where the account came from:**

```sql
select coalesce(s.signup_source, '(none)') as source,
       count(distinct o.user_id) as payers,
       sum(o.net_cents - least(o.refunded_cents, o.net_cents)) / 100.0 as earned
  from billing_orders o
  join account_standing s on s.user_id = o.user_id
 group by 1
 order by 3 desc;
```

## The fleet

On the `fleet` runtime ([fleet.md](fleet.md)), what the nodes cost and how full they are. A node's
monthly price is the `monthly_cost_cents` label it enrolled with.

**Density.** Servers and promised memory per node, against what it can give:

```sql
select n.name, n.region_key, n.lifecycle,
       count(p.workload) filter (where p.state = 'placed') as servers,
       coalesce(sum(p.memory_mb) filter (where p.state in ('placing', 'placed')), 0) as promised_mb,
       (n.capacity->>'allocatableMemoryMb')::int as allocatable_mb,
       (n.labels->>'monthly_cost_cents')::numeric / 100 as monthly_cost
  from fleet_nodes n
  left join fleet_placements p on p.node_id = n.id
 where n.lifecycle <> 'retired'
 group by n.id order by n.region_key, n.name;
```

**What a played hour costs, per node, this month** (the month's price so far over the server-hours
its placements ran):

```sql
with month as (
  select date_trunc('month', now()) as start,
         extract(epoch from now() - date_trunc('month', now()))
           / extract(epoch from interval '1 month') as elapsed
)
select n.name,
       round((n.labels->>'monthly_cost_cents')::numeric / 100 * month.elapsed, 2) as cost_so_far,
       round(sum(extract(epoch from (coalesce(i.stopped_at, now()) - greatest(i.started_at, month.start))) / 3600)::numeric, 1) as server_hours,
       round((n.labels->>'monthly_cost_cents')::numeric / 100 * month.elapsed
             / nullif(sum(extract(epoch from (coalesce(i.stopped_at, now()) - greatest(i.started_at, month.start))) / 3600), 0)::numeric, 4) as per_server_hour
  from month, fleet_nodes n
  join fleet_placement_history h on h.node_id = n.id
  join power_intervals i on i.server_id::text = h.workload
   and i.started_at >= h.started_at and (h.ended_at is null or i.started_at < h.ended_at)
 where coalesce(i.stopped_at, now()) > month.start
 group by n.id, month.start, month.elapsed order by per_server_hour desc nulls last;
```

**Backups that haven't left their node** (anything older than an hour here wants a look):

```sql
select status, count(*), min(captured_at) as oldest
  from fleet_archives
 where purpose = 'snapshot' and status in ('creating', 'local', 'uploading', 'failed')
 group by 1;
```

**What happened to the fleet this month:**

```sql
select kind, count(*)
  from fleet_events
 where at > date_trunc('month', now())
   and kind in ('node.lost', 'node.rebooted', 'node.returned_while_lost', 'placement.displaced',
                'fork.detected', 'copy.orphaned', 'epoch.conflict', 'node.duplicate_identity',
                'snapshot.upload_failed', 'placement.move_requested', 'move.exported')
 group by 1 order by 2 desc;
```
