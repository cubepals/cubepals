# Production, from nothing

How production comes up on cubepals.com the first time, and how to check it. Every variable:
[configuration.md](configuration.md).

Production is Terraform (`infra/terraform/environments/production`) plus three `fly deploy`s, and
`bun scripts/production.ts` runs all of it from one file of values. Servers run on Fly alone: no
Boat, no Hetzner nodes, no `OPERATOR_TOKEN` or `FLEET_*` values. Billing is off until Polar's
values are added ([below](#billing-later)).

What Terraform makes: the Fly apps `bly-prod-control`, `bly-prod-realtime` and `bly-prod-edge`
with their addresses, certificate and secrets; the DNS records for `cubepals.com`,
`www.cubepals.com` (a redirect), `rt.cubepals.com` and `*.play.cubepals.com`; the R2 bucket
named by `ARCHIVE_S3_BUCKET`; the private R2 bucket `blockly-prod-database-dumps`, where the
database is dumped every night ([below](#database-dumps)); and the Vercel project `blockly`, which
builds the `production` branch.

## 1. Accounts (once)

Each of these needs an account or a card, so nothing here does them.

1. **Fly.** `fly orgs create blockly-prod`, and a card on it. Ask Fly support to set its machine
   limit to what `fly_machine_limit` says ([money-guards.md](money-guards.md#the-provider-ceiling-fly_machine_limit)).
2. **Database.** `fly mpg create --org blockly-prod --region fra --name bly-prod-db`, choosing
   the plan it offers. Terraform can't make it: Fly's provider has no Managed Postgres.
3. **Cloudflare.** R2 turned on for the account (it asks for a card even on the free tier), and a
   bucket named `blockly-terraform-state` for Terraform's state.
4. **Vercel.** The team in `config.auto.tfvars.json` (`vercel_team`), on a plan that allows a
   commercial site, with Vercel's GitHub app allowed on `cubepals/cubepals`. Without that app,
   Terraform can't make the project.
5. **Google sign-in.** In console.cloud.google.com, a project for Cubepals. Under Google Auth
   Platform: Branding (name Cubepals, support email, authorized domain `cubepals.com`), then
   Audience → **Publish app**. While it says "Testing", only listed test users can sign in.
6. **Mail.** An SMTP provider that sends as `hello@cubepals.com`, with the DNS records it asks
   for (SPF, DKIM) added in Cloudflare by hand. None is chosen yet.

## 2. The values

The environment's decided values (Fly org, Vercel team, repository, machine limit, non-secret
settings) live in `infra/terraform/environments/production/config.auto.tfvars.json`, which git
ignores. Copy `config.auto.tfvars.example.json` beside it to that name and put in your own values;
`production.ts` stops and says so while it is missing. The secrets go in a separate file:

```sh
bun scripts/production.ts init
```

writes `local/production/production.env` (never committed, readable only by you). It already holds
the random secrets (`AUTH_SECRET`, `WEB_PROXY_SECRET`, `REALTIME_TICKET_SECRET`, `EDGE_TOKEN`,
`RUNTIME_SECRETS_KEY`). Above each empty value it says where to get it. The same list:

| Value | Where to get it | Where it goes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` | Cloudflare → cubepals.com → Overview, right column | Terraform: the bucket, the records, and the realtime role's DNS-01 zone |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → Custom: Zone · DNS · Edit on cubepals.com, Account · Workers R2 Storage · Edit | Terraform's Cloudflare provider only |
| `VERCEL_API_TOKEN` | vercel.com → Account Settings → Tokens, scoped to the team | Terraform's Vercel provider only |
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

Optional, and left out at launch: `POLAR_*` ([below](#billing-later)) and
`AUTH_GITHUB_CLIENT_ID`/`_SECRET` (a GitHub OAuth app, callback
`https://cubepals.com/api/auth/callback/github`).

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
2. Terraform shows the plan and asks before it changes anything. Answer `yes`.
   Then it gives the Database dump workflow its secrets ([below](#database-dumps)).
3. It deploys `bly-prod-control` (its release runs the migrations), then `bly-prod-realtime` (one
   machine, always), then `bly-prod-edge`, all from this checkout.
4. It pushes the commit as the `production` branch. Vercel builds `cubepals.com` from it.

`apply` can be run again at any time: it changes only what differs. It's also how a value changes
later: edit the file, run `apply`. Never run `terraform destroy` here.

A change to the website alone goes without a staging pass or a Fly deploy:

```sh
bun scripts/production.ts web
```

From a clean checkout of main's latest commit, once main's CI has passed on it, it pushes the commit
as the `production` branch for Vercel to build. It refuses when anything the Fly apps are built from
changed since the last deploy (`apps/control`, `apps/edge`, `packages`, `infra/fly`, the lockfile):
that goes through `apply`, after a nightly.

Every website build is asked of Vercel's API after the push: on this project the builds a push
to `production` starts end skipped, while one asked for through the API builds.

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
```

Each Fly app goes back to the image its previous release ran, and the website is built again from
the commit it was built from before (Vercel's own instant rollback would stop later builds from
going live until undone). A rollback doesn't undo a migration or a secret, and the `production`
branch still names the newer commit: fix forward, then deploy again.

## 4. Check it

1. `dig +short rt.cubepals.com` gives one IPv4 address and `dig +short AAAA rt.cubepals.com`
   nothing; `dig +short anything.play.cubepals.com` gives the edge's address.
2. `https://bly-prod-control.fly.dev/api/health` answers, and `https://cubepals.com` loads once
   Vercel's build is done (vercel.com → the `blockly` project → Deployments).
   `https://www.cubepals.com` goes to `https://cubepals.com`.
3. `fly logs -a bly-prod-realtime` shows the certificate for `rt.cubepals.com` issued.
4. **Sign in with Google** at `https://cubepals.com` with the address in `ADMIN_EMAILS`. Admin
   appears in the menu.
5. **Sign in by email** with another address: the mail arrives from `hello@cubepals.com`.
6. **Create a server.** Its page shows it starting and then running, live (that's realtime).
7. **Join it** from Minecraft at `<its name>.play.cubepals.com`.
8. **A backup:** on the server's Backups page, make one; it's listed, and downloads.
9. **A wake:** leave the server empty until it sleeps. Minecraft's server list says
   "Sleeping · join to wake it up". Join, and it wakes.

## Database dumps

Every night at 03:30 UTC, the Database dump workflow (`.github/workflows/database-dump.yml`, running
`scripts/database-dump.ts`) dumps the database with `pg_dump --format=custom`, has `pg_restore`
read the dump back, and uploads it to `blockly-prod-database-dumps` as
`blockly-<UTC time>.dump`. The bucket is private, and deletes each dump after 30 days. The run
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

1. Download the dump: Cloudflare → R2 → `blockly-prod-database-dumps` → the dump → Download.
   Check it reads: `pg_restore --list <file> | head`.
2. Stop what writes to the database, so nothing changes under the restore:
   `fly machine stop $(fly machine list -a bly-prod-control -q) -a bly-prod-control`, and the same
   for `bly-prod-realtime`.
3. Turn the dump into SQL, then empty the schemas it puts back and run it, all in one
   transaction: if anything fails, the database is left as it was.

   ```sh
   pg_restore --no-owner --no-privileges --file=restore.sql <file>
   psql "$DATABASE_DIRECT_URL" --single-transaction -v ON_ERROR_STOP=1 \
     -c 'drop schema if exists drizzle, pgboss cascade' -c 'drop schema public cascade' \
     -c 'create schema public' -f restore.sql
   ```

   The same works into a new, empty database (another Supabase project, say); then point
   `DATABASE_URL` and `DATABASE_DIRECT_URL` at it and `apply`. `pg_restore --clean` would drop
   each object in turn instead, and fails on the job queue's partitioned tables.
4. Start the machines again (`fly machine start`, as in step 2), and delete `restore.sql` and the
   dump: they hold everyone's data. Everything after the dump's time is gone. Servers' worlds are
   not in it: they live in their own backups.

## Billing, later

Production runs without billing: everyone is on the plan their account says. To start charging,
in Polar's production dashboard (polar.sh, not the sandbox):

1. A product for Plus; its id goes in the file as `POLAR_PRODUCTS=plus:<id>`.
2. A meter "Extra play": filter `name eq "play.extra"`, aggregation `sum` of `hours`, unit
   `custom` with the label "hour". On the Plus product, beside its $15 price, a metered price on
   that meter: `unit_amount` 25 (cents an hour) and `cap_amount` 5000 ($50 a period, twice the
   most a player may allow in a month, as a last resort). Blockly sends `play.extra` events and
   needs no id of either ([money-guards.md](money-guards.md#extra-play)).
3. A one-time product "Cubepals balance" with a custom (pay-what-you-want) price and the metadata
   `purpose: balance`. A payment Polar can no longer collect (its subscription ended) is paid
   with it, at the amount owed ([money-guards.md](money-guards.md#extra-play)).
4. Settings → Developers → an organization access token with `checkouts:write`, `customer_sessions:write`, `customers:read`, `subscriptions:read`, `products:read`, `orders:read`, `payments:read`, `refunds:write` and `events:write`:
   `POLAR_ACCESS_TOKEN`.
5. Settings → Webhooks → an endpoint `https://cubepals.com/api/billing/webhook`, API version
   2026-10, events `customer.state_changed`, `order.created`, `order.updated`, `order.paid`, `order.refunded`, `subscription.active`, `subscription.past_due`, `subscription.canceled`, `subscription.uncanceled` and `subscription.revoked`. Its secret (`whsec_…`) is `POLAR_WEBHOOK_SECRET`.

Then `bun scripts/production.ts apply`. The three come together or not at all; `check` and the
plan both refuse one without the others.
