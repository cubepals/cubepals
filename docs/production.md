# Production, from nothing

How production comes up on cubepals.com the first time, and how to check it. Every variable:
[configuration.md](configuration.md).

Production is Terraform (`infra/terraform/environments/production`) plus three `fly deploy`s, and
`bun scripts/production.ts` runs all of it from one file of values. Servers run on Fly alone: no
Boat, no Hetzner nodes, no `FLEET_*` values. `OPERATOR_TOKEN` is set, for the operators' API
([below](#from-the-command-line)). Billing is off until Polar's values are added
([below](#billing-later)).

What Terraform makes: the Fly apps `bly-prod-control`, `bly-prod-realtime` and `bly-prod-edge`
with their addresses, certificate and secrets; the DNS records for `cubepals.com`,
`www.cubepals.com` (a redirect), `rt.cubepals.com` and `*.play.cubepals.com`; the R2 bucket
named by `ARCHIVE_S3_BUCKET`; the private R2 bucket `blockly-prod-database-dumps`, where the
database is dumped every night ([below](#database-dumps)); and the website's Cloudflare Worker
`blockly-web`, with the R2 bucket `blockly-web-cache` for Next's data cache and the routes
`cubepals.com/*` and `www.cubepals.com/*`. What the Worker runs isn't Terraform's: `production.ts`
builds it from the checkout and deploys it with wrangler ([The website](#the-website)).

## 1. Accounts (once)

Each of these needs an account or a card, so nothing here does them.

1. **Fly.** `fly orgs create blockly-prod`, and a card on it. Ask Fly support to set its machine
   limit to what `fly_machine_limit` says.
2. **Database.** `fly mpg create --org blockly-prod --region fra --name bly-prod-db`, choosing
   the plan it offers. Terraform can't make it: Fly's provider has no Managed Postgres.
3. **Cloudflare.** R2 turned on for the account (it asks for a card even on the free tier), a
   bucket named `blockly-terraform-state` for Terraform's state, and the Workers Paid plan, which
   the website's server rendering needs (the free plan allows 10 ms of CPU a request).
4. **Google sign-in.** In console.cloud.google.com, a project for Cubepals. Under Google Auth
   Platform: Branding (name Cubepals, support email, authorized domain `cubepals.com`), then
   Audience → **Publish app**. While it says "Testing", only listed test users can sign in.
5. **Mail.** An SMTP provider that sends as `hello@cubepals.com`, with the DNS records it asks
   for (SPF, DKIM) added in Cloudflare by hand. None is chosen yet.

## 2. The values

The environment's decided values (Fly org, repository, machine limit, non-secret settings, and
whether the website's hosts are proxied to its Worker yet) live in `infra/terraform/environments/production/config.auto.tfvars.json`, which git
ignores. Copy `config.auto.tfvars.example.json` beside it to that name and put in your own values;
`production.ts` stops and says so while it is missing. The secrets go in a separate file:

```sh
bun scripts/production.ts init
```

writes `local/production/production.env` (never committed, readable only by you). It already holds
the random secrets (`AUTH_SECRET`, `WEB_PROXY_SECRET`, `REALTIME_TICKET_SECRET`, `EDGE_TOKEN`,
`FLOODGATE_KEY`, `OPERATOR_TOKEN`, `RUNTIME_SECRETS_KEY`). Run again, it makes any random one the file doesn't hold
yet and keeps the rest. Above each empty value it says where to get it. The same list:

| Value | Where to get it | Where it goes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` | Cloudflare → cubepals.com → Overview, right column | Terraform: the bucket, the records, and the realtime role's DNS-01 zone |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → Custom: Zone · DNS · Edit and Zone · Workers Routes · Edit on cubepals.com; Account · Workers R2 Storage · Edit and Account · Workers Scripts · Edit | Terraform's Cloudflare provider only |
| `CLOUDFLARE_WORKERS_API_TOKEN` | The same page, another custom token: Account · Workers Scripts · Edit and Account · Workers R2 Storage · Edit | The website's deploys and rollbacks (wrangler) only |
| `TF_STATE_ACCESS_KEY_ID`, `TF_STATE_SECRET_ACCESS_KEY` | Cloudflare → R2 → Manage API tokens → Create Account API token: Object Read & Write, `blockly-terraform-state` only | Terraform's state backend only |
| `FLY_API_TOKEN` | `fly tokens create org blockly-prod` | Terraform's Fly provider, `fly deploy`, and the control plane, which makes servers' machines with it |
| `DATABASE_URL`, `DATABASE_DIRECT_URL` | Supabase → cubepals prod → Connect → Session pooler (port 5432), as the role `blockly` on the database `blockly`: the same URL for both, since session mode carries `LISTEN`, migrations and `pg_dump` | Control plane |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | Google Auth Platform → Clients → Create client → Web application. Origin `https://cubepals.com`; redirect `https://cubepals.com/api/auth/callback/google` | Control plane |
| `SMTP_URL` | The mail provider, as `smtps://user:password@host:465` | Control plane |
| `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template, zone cubepals.com | Realtime role: it proves `rt.cubepals.com` to Let's Encrypt |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | **After the first apply** makes the bucket: Cloudflare → R2 → Manage API tokens → Create Account API token: Object Read & Write, the archive bucket only | Control plane: backups, downloads, rested worlds |
| `DUMP_S3_ACCESS_KEY_ID`, `DUMP_S3_SECRET_ACCESS_KEY` | **After the first apply**, the same way: Object Read & Write, `blockly-prod-database-dumps` only | The Database dump workflow only, as secrets of the repository's `production` environment |
| `ADMIN_EMAILS` | Your own address; sign in with it and you are an admin | Control plane |
| `ACME_EMAIL`, `ACME_AGREE_TOS` | An address for Let's Encrypt, and `true` once you accept its Subscriber Agreement (letsencrypt.org/repository) | Realtime role |
| `FREE_LINK_TUNING`, `ABUSE_LIMITS`, `CAPACITY_TUNING` | The private records: production's own, one line of JSON each ([configuration.md](configuration.md#private-tuning)) | Control plane |

Optional, and left out at launch: `POLAR_*` ([below](#billing-later)) and
`AUTH_GITHUB_CLIENT_ID`/`_SECRET` (a GitHub OAuth app, callback
`https://cubepals.com/api/auth/callback/github`). Optional too: `ADMIN_ALERT_EMAILS`, where admin
mail (platform alerts, the spend watchdog) goes when the inbox you read isn't the address you sign
in with; left out, it goes to each admin's own email.
`ECONOMICS_TUNING`, `OFFICIAL_SERVER_FILES` and `STOP_CHEATERS` come from the private records, one
line of JSON each ([tuning](configuration.md#private-tuning),
[files](configuration.md#files-for-official-servers-optional),
[Stop cheaters](configuration.md#stop-cheaters-optional)); left out, the economics report leaves
fees and margin out, official servers start with the public defaults, and Stop cheaters only alerts
and logs.

```sh
bun scripts/production.ts check
```

names what is missing or wrongly shaped, and runs the control plane's own configuration check on
the values, as each production machine will at its first start. It never prints a value. Until
the buckets exist, their tokens' keys are the only ones allowed to be missing.

## 3. Apply

From a clean checkout of the commit to launch (normally `main`), with `terraform` (1.11 or later)
and `flyctl` installed:

```sh
bun scripts/production.ts apply
```

1. The first time, it makes only the two buckets and stops. Make their R2 tokens (the table
   above), put their keys in the file, and run `apply` again.
2. It builds the website from this checkout with production's values and checks the build
   (`robots.txt` lets crawlers in, `/api` goes to `bly-prod-control`), so a build that fails stops
   it before anything changes.
3. Terraform shows the plan and asks before it changes anything. Answer `yes`.
   Then it gives the Database dump workflow its secrets ([below](#database-dumps)).
4. It deploys `bly-prod-control` (its release runs the migrations), then `bly-prod-realtime` (one
   machine, always), then `bly-prod-edge`, all from this checkout.
5. It pushes the commit as the `production` branch and deploys the website's build: live when it
   returns.

`apply` can be run again at any time: it changes only what differs. It's also how a value changes
later: edit the file, run `apply`. Never run `terraform destroy` here.

A change to the website alone goes without a staging pass or a Fly deploy:

```sh
bun scripts/production.ts web
```

From a clean checkout of main's latest commit, once main's CI has passed on it, it builds and
checks the website, pushes the commit as the `production` branch and deploys the build. It refuses
when anything the Fly apps are built from changed since the last deploy (`apps/control`,
`apps/edge`, `packages`, `infra/fly`, the lockfile), or Terraform did: that goes through `apply`,
after a nightly.

### The website

`cubepals.com` is the Cloudflare Worker `blockly-web` (`apps/web/wrangler.jsonc`), built by
OpenNext. `production.ts` builds it where it runs, with the values the rest of production is made
from (`API_UPSTREAM` is `bly-prod-control`'s address; `WEB_CANONICAL_ORIGIN`, `DEPLOYMENT_ID` and
`POSTHOG_TOKEN` from the settings; `WEB_INDEXABLE` from `web.indexable`), and deploys it with
wrangler: the same values as the Worker's vars, `WEB_PROXY_SECRET` in a secrets file, and the
version tagged with its commit. The Worker answers `www.cubepals.com` itself, with a 308 to
`https://cubepals.com` that keeps the path and query.

Terraform holds the Worker, its cache bucket and its routes, never its versions. A route only sees
traffic Cloudflare proxies, so `"proxied": true` under `web` in `config.auto.tfvars.json` is what
sends `cubepals.com` and `www` to the Worker, under the zone's own certificate. `false` makes the
records DNS-only, and nothing behind them serves the site. The Worker has no `workers.dev`
address (`apps/web/wrangler.jsonc`): `cubepals.com` is how a deploy is checked, the pages,
sign-in and `/api/health`, and `bun scripts/production.ts rollback website` undoes one.

If `blockly-web` or `blockly-web-cache` was made by hand before Terraform made them, import them
(`terraform import`) rather than letting the apply fail on a name that is taken.

### A fix that can't wait for the nightly

```sh
bun scripts/production.ts hotfix
```

It deploys the checked-out commit once CI has passed on it, with no staging pass: only the Fly apps
the change is built into (control and realtime for `apps/control`, edge for `apps/edge`, all three
for `packages` or the lockfile), the website if the change reaches it, then it checks that
production answers. It never applies Terraform. When main holds other backend work that hasn't
been on staging, make a branch from `production`, cherry-pick the fix onto it, open a pull request
so CI runs, and run `hotfix` from that branch. The fix still lands on main the usual way, and the
next nightly covers it there.

### Going back

```sh
bun scripts/production.ts rollback          # the Fly apps and the website
bun scripts/production.ts rollback fly      # the Fly apps alone
bun scripts/production.ts rollback website  # the website alone
bun scripts/production.ts rollback fly edge # the edge app to its previous image, whatever deployed it
```

A rollback undoes the last deploy. Every image `apply` and `hotfix` build is tagged with the
deploy's time and commit, so the Fly apps that deploy changed go back to the images they ran
before it, and the apps it didn't change stay as they are; it says which. A second rollback
goes back one deploy further. The `production` branch moves back to the commit that is live
again. The website goes to the Worker version that was live before, at once and without a build
(`wrangler rollback`; any of the last 100 versions). A rollback doesn't undo a migration or a
secret: fix forward, then deploy again.

Until the first `apply` or `hotfix` built with this tagging has run, the images the Fly apps run
don't say which deploy made them, so a bare `rollback` or `rollback fly` leaves every Fly app as
it is and says so. Name the apps instead:

```sh
bun scripts/production.ts rollback fly control realtime edge
```

## 4. Check it

1. `dig +short rt.cubepals.com` gives one IPv4 address and `dig +short AAAA rt.cubepals.com`
   nothing; `dig +short anything.play.cubepals.com` gives the edge's address.
2. `https://bly-prod-control.fly.dev/api/health` answers, and `https://cubepals.com` loads. `https://www.cubepals.com` goes to
   `https://cubepals.com`.
3. `fly logs -a bly-prod-realtime` shows the certificate for `rt.cubepals.com` issued.
4. **Sign in with Google** at `https://cubepals.com` with the address in `ADMIN_EMAILS`. Admin
   appears in the menu.
5. **Sign in by email** with another address: the mail arrives from `hello@cubepals.com`.
6. **Create a server.** Its page shows it starting and then running, live (that's realtime).
7. **Join it** from Minecraft at `<its name>.play.cubepals.com`.
8. **A backup:** on the server's Backups page, make one; it's listed, and downloads.
9. **A wake:** leave the server empty until it sleeps. Minecraft's server list says
   "Sleeping · join to wake it up". Join, and it wakes.
10. **A whole life:** `bun scripts/production-check.ts` ([below](#from-the-command-line)).

## From the command line

The control plane's operators' API answers on its internal listener, behind `OPERATOR_TOKEN`, so
accounts and servers can be looked after without signing in to the website. Every action goes
through the same services the website's own do, and the audit log records it as
`operator:<name>`, the name being `OPERATOR` (or `USER`) on the machine that asked.

```sh
bun scripts/ops.ts --production account you@example.com     # standing, plan, limits, servers
bun scripts/ops.ts --production plan you@example.com plus    # comp onto Plus; `free` takes it back
bun scripts/ops.ts --production limits you@example.com --servers 3 --running 2
bun scripts/ops.ts --production create you@example.com "Test world"   # Free survival for five unless told
bun scripts/ops.ts --production rest <server>                # its world to the archive store now
bun scripts/ops.ts --production purge <server> --confirm "Test world" # out of the trash, for good, now
```

Production's health reads the same way, as the admin Health page (`/admin/health`) shows it: what
servers are doing now, how long creates, starts, wakes, rests and the rest took (count, median,
p90, slowest and a trend, split by region and by how the server was made), what failed, the
slowest work, and running hours and spend against the guards. `--json` prints what the API sent.

```sh
bun scripts/ops.ts --production health [--window 24h|7d|30d]
bun scripts/ops.ts --production operations --kind wake --since 7d --slow 120 --status succeeded
bun scripts/ops.ts --production operation <op>             # where its time went, step by step
```

Each operation keeps every step its handler reported, with when it began
(`server_operations.steps`, `[{ step, at }]`, each attempt opening with `attempt`): a step lasts
until the next one's `at`, the last until `finished_at`, and the wait in the queue is `created_at`
to the first. Operations from before the steps were kept have none.

Joins read the same way. Each one puts together what the edge saw (the address, the hostname
asked for, the wake it started, when it was handed over and left) with what the server's own
reporter plugin saw (logging in, configuring, arriving in the world, leaving), where
`JOIN_REPORTER` lets the plugin run. A join is kept 35 days.

```sh
bun scripts/ops.ts --production joins --server <server> --since 24h   # one a line, the newest first
bun scripts/ops.ts --production join <player> --at 2026-10-20T21:14Z --markdown
bun scripts/ops.ts --production signals [--since 7d]       # what is open; `signals close <n>`
```

`join` takes a join's id, or a player's name or uuid for their join nearest `--at` (their latest
without it), and prints it as an incident report: who joined, how they reached the server, each
step in order with its time, what crossed a limit, and what nobody recorded. That report is meant
to be pasted into an incident as it is. A signal is a join, a wake or a server that looked wrong
(a slow join, a player leaving while loading, wakes nobody joined), with its figure and the limit
it crossed. The limits come from `SIGNALS` ([configuration](configuration.md)); with none set, no
signal is raised, and the log says so once. A signal left open a day closes as expired; one dealt
with sooner is closed with `signals close`. The MCP server's `joins_list`, `join_get` and `signals_list` answer the same.

The top of `scripts/ops.ts` lists every command. `--production` opens `fly proxy` to
`bly-prod-control`'s internal listener with production's own `FLY_API_TOKEN` and `OPERATOR_TOKEN`,
read from `local/production/production.env`; neither is printed, and a shell's own Fly token never
reaches it. Without `--production`, `OPERATOR_API` and `OPERATOR_TOKEN` say where, as for
`scripts/runtimes.ts`.

The same commands also cover a server's console, identity, mods and players pages, Browse and its
allowlist, and the switches on `/admin/platform`. `accounts create <email> --confirm <email>
[--name]` makes an account with no password for a person, who signs in with the email link or
Google; it is for a person to run, never a script. What takes something away from someone is
named again first: `trash`, `purge`, `ban` and `listing unlist` with `--confirm <the server's
name>`, `platform set` with `--confirm platform`. A console command is one line.

An agent reaches all of it through `scripts/ops-mcp.ts`, an MCP server over stdio only, with one
tool per command. It reads the same values, won't start without them, and never prints or answers
with a token. Tools that can't be undone say so, and take the same `confirm`. Its actions are
`operator:<OPERATOR or USER>` in the audit log, `operator:mcp` when neither is set. In Claude Code,
from the repository:

```sh
claude mcp add cubepals-ops -e OPERATOR=you -- bun "$PWD/scripts/ops-mcp.ts" --production
```

In Claude Desktop, under `mcpServers` in `claude_desktop_config.json` (with `bun` and `fly` on the
PATH it starts servers with):

```json
"cubepals-ops": {
  "command": "bun",
  "args": ["/path/to/cubepals/scripts/ops-mcp.ts", "--production"],
  "env": { "OPERATOR": "you" }
}
```

```sh
bun scripts/production-check.ts [--owner you@example.com]
```

runs a real server's life on production as `operator:production-check`, for the first address in
`ADMIN_EMAILS` unless `--owner` names another account: a server named "Production check" and the
time is made, joined through the edge at its own `<slug>.play.cubepals.com` until it answers,
stopped, rested in the archive store with Fly left holding no machine or volume of it, joined
again and timed coming back from the archive, then sent to the trash and purged, after which Fly
holds no app `bly-prod-<its id without dashes>`. Each wait is reported, as the staging check does.
Whatever fails, the server it made is trashed and purged before it exits. It counts against the
account's plan like any server: a Free account that already has one needs
`ops.ts limits <account> --servers 2` first.

## Database dumps

Every night at 03:37 UTC, the Database dump workflow (`.github/workflows/database-dump.yml`, running
`scripts/database-dump.ts`) dumps the database with `pg_dump --format=custom`, has `pg_restore`
read the dump back, and uploads it to `blockly-prod-database-dumps` as
`blockly-<UTC time>.dump`. The job queue's finished jobs, completed or cancelled, are left out of
it: the jobs still to run, running or failed go beside it as `blockly-<UTC time>.jobs.sql`, read in
the same snapshot. The bucket is private, and deletes each dump after 30 days. The run
fails, and GitHub emails, when any step does, and when the database is past 400 MB of Supabase
Free's 500: the dump is still taken, and it's time to make room or move to a bigger plan.

Its values are secrets of the repository's `production` environment, which `apply` sets from the
file: `DATABASE_URL` (the file's `DATABASE_DIRECT_URL`: pg_dump needs a session of its own),
`DUMP_S3_ENDPOINT`, `DUMP_S3_BUCKET`, `DUMP_S3_ACCESS_KEY_ID` and `DUMP_S3_SECRET_ACCESS_KEY`. Only
`main`'s workflows, and `production`'s, can read them. Until they're set, the run says so and
passes. After the first full apply, run it once by hand: `gh workflow run database-dump.yml`, then
check the bucket lists the dump. The repository is public, and so are the run's logs: they show
sizes, the key and whether each step passed, nothing else.

### Restoring one

1. Download the dump and the jobs beside it: Cloudflare → R2 → `blockly-prod-database-dumps` →
   `blockly-<time>.dump` and `blockly-<time>.jobs.sql` → Download. Check the dump reads:
   `pg_restore --list <file> | head`.
2. Stop what writes to the database, so nothing changes under the restore:
   `fly machine stop $(fly machine list -a bly-prod-control -q) -a bly-prod-control`, and the same
   for `bly-prod-realtime`.
3. Turn the dump into SQL, then empty the schemas it puts back and run it, all in one
   transaction: if anything fails, the database is left as it was.

   ```sh
   pg_restore --no-owner --no-privileges --file=restore.sql <file>
   psql "$DATABASE_DIRECT_URL" --single-transaction -v ON_ERROR_STOP=1 \
     -c 'drop schema if exists drizzle, pgboss cascade' -c 'drop schema public cascade' \
     -c 'create schema public' -f restore.sql -f <jobs file>
   ```

   A dump taken before the jobs went beside it holds them all, and has no jobs file: leave out its
   `-f`.

   The same works into a new, empty database (another Supabase project, say); then point
   `DATABASE_URL` and `DATABASE_DIRECT_URL` at it and `apply`. `pg_restore --clean` would drop
   each object in turn instead, and fails on the job queue's partitioned tables.
4. Start the machines again (`fly machine start`, as in step 2), and delete `restore.sql` and the
   dump: they hold everyone's data. Everything after the dump's time is gone, and so are the jobs
   that had finished by then, which nothing reads again. Servers' worlds are not in it: they live
   in their own backups.

## Billing, later

Production runs without billing: everyone is on the plan their account says. To start charging,
in Polar's production dashboard (polar.sh, not the sandbox):

1. A product for Plus; its id goes in the file as `POLAR_PRODUCTS=plus:<id>`.
2. A meter "Extra play": filter `name eq "play.extra"`, aggregation `sum` of `hours`, unit
   `custom` with the label "hour". On the Plus product, beside its $25 price, a metered price on
   that meter: `unit_amount` 25 (cents an hour) and `cap_amount` 5000 ($50 a period, twice the
   most a player may allow in a month, as a last resort). Blockly sends `play.extra` events and
   needs no id of either.
3. A one-time product "Cubepals balance" with a custom (pay-what-you-want) price and the metadata
   `purpose: balance`. A payment Polar can no longer collect (its subscription ended) is paid
   with it, at the amount owed.
   Gifts are one-time products too, one per gift on sale: a fixed price in dollars and the
   metadata `purpose: gift`, `plan: plus` and `months` (`1` for "Cubepals Plus, a month as a
   gift", at Plus' price, $25). The gift page offers every such product Polar holds, so a new gift (a
   year of Plus) is a product and nothing else; archiving one takes it off sale.
4. A one-time product "Cubepals Plus, a year" with a fixed $250 price and the metadata
   `plan: plus` and `term: year`. Blockly finds it by that metadata, so no id is configured; until
   it exists, a year of Plus can't be bought and the checkout page says so. Polar sells it as one
   order with no subscription, and Blockly keeps the year (`plan_years`): nothing renews it, and
   no metered price goes on it. A refund in Polar's dashboard ends the year at the whole months
   left (a twelfth of what was paid each), as the Refunds page says.
5. A one-time product "Cubepals chip-in" with a custom (pay-what-you-want) price, minimum $5, and
   the metadata `purpose: chip_in`. Friends chip in to a server with it, at the amount they chose,
   tax included.
6. Settings → Developers → an organization access token with `checkouts:write`, `customer_sessions:write`, `customers:read`, `subscriptions:write`, `products:read`, `orders:read`, `payments:read`, `refunds:write`, `events:write` and `discounts:write`:
   `POLAR_ACCESS_TOKEN`.
7. Settings → Webhooks → an endpoint `https://cubepals.com/api/billing/webhook`, API version
   2026-10, events `customer.state_changed`, `order.created`, `order.updated`, `order.paid`, `order.refunded`, `subscription.active`, `subscription.past_due`, `subscription.canceled`, `subscription.uncanceled` and `subscription.revoked`. Its secret (`whsec_…`) is `POLAR_WEBHOOK_SECRET`.

Then `bun scripts/production.ts apply`. The three come together or not at all; `check` and the
plan both refuse one without the others.
