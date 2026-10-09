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
named by `ARCHIVE_S3_BUCKET`; and the Vercel project `blockly`, which builds the `production` branch.

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
| `DATABASE_URL`, `DATABASE_DIRECT_URL` | fly.io → blockly-prod → Managed Postgres → the cluster → Connect: the pooled URL (`pgbouncer.…`) and the direct one (`direct.…`) | Control plane |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | Google Auth Platform → Clients → Create client → Web application. Origin `https://cubepals.com`; redirect `https://cubepals.com/api/auth/callback/google` | Control plane |
| `SMTP_URL` | The mail provider, as `smtps://user:password@host:465` | Control plane |
| `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template, zone cubepals.com | Realtime role: it proves `rt.cubepals.com` to Let's Encrypt |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | **After the first apply** makes the bucket: Cloudflare → R2 → Manage API tokens → Create Account API token: Object Read & Write, the archive bucket only | Control plane: backups, downloads, rested worlds |
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
the archive bucket exists, its two keys are the only ones allowed to be missing.

## 3. Apply

From a clean checkout of the commit to launch (normally `main`), with `terraform` (1.11 or later)
and `flyctl` installed:

```sh
bun scripts/production.ts apply
```

1. The first time, it makes only the archive bucket and stops. Make its R2 token (the table
   above), put its two keys in the file, and run `apply` again.
2. Terraform shows the plan and asks before it changes anything. Answer `yes`.
3. It deploys `bly-prod-control` (its release runs the migrations), then `bly-prod-realtime` (one
   machine, always), then `bly-prod-edge`, all from this checkout.
4. It pushes the commit as the `production` branch. Vercel builds `cubepals.com` from it.

`apply` can be run again at any time: it changes only what differs. It's also how a value changes
later: edit the file, run `apply`. Never run `terraform destroy` here.

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

## Billing, later

Production runs without billing: everyone is on the plan their account says. To start charging,
in Polar's production dashboard (polar.sh, not the sandbox):

1. A product for Plus; its id goes in the file as `POLAR_PRODUCTS=plus:<id>`.
2. Settings → Developers → an organization access token with `checkouts:write`,
   `customer_sessions:write`, `customers:read` and `subscriptions:read`: `POLAR_ACCESS_TOKEN`.
3. Settings → Webhooks → an endpoint `https://cubepals.com/api/billing/webhook`, API version
   2026-04, events `customer.state_changed`, `order.paid` and `order.refunded`. Its secret
   (`whsec_…`) is `POLAR_WEBHOOK_SECRET`.

Then `bun scripts/production.ts apply`. The three come together or not at all; `check` and the
plan both refuse one without the others.
