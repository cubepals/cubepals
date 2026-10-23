# Configuration and secrets

Every Blockly deployment is configured the same way: environment variables, read once at start
into `DeploymentConfig` (`apps/control/src/config/schema.ts`, `load.ts`). A missing or
inconsistent value stops the start with every problem listed; nothing falls back silently.
Local development is the one exception, and it says so: each stand-in is a line in the log.
Nothing in the code names a deployment, a domain or a port.

| Environment | Where the values come from |
|---|---|
| Local | `.env` at the repository root, a copy of `.env.example` as it is ([local development](local-development.md): what stands in there for outside services) |
| Staging, production | Fly secrets on each app, set by Terraform (`infra/terraform`), plus each app's `infra/fly/*.toml` `[env]`; the web app's values with each deploy of its Cloudflare Worker (`scripts/lib/web-worker.ts`). Until Blockly has its domain, staging is made by `scripts/staging.ts` instead ([below](#staging-on-the-providers-own-addresses)) |

For staging and production, what the deployment decides is in
`infra/terraform/environments/<name>/config.auto.tfvars.json` (`settings`). Git ignores that file:
the repository holds `config.auto.tfvars.example.json` beside it, which is copied to that name and
filled in. `apps/control/src/config/environments.test.ts` loads it (or the example, in a fresh
checkout) the way a deployed machine does, with
each role's `fly.toml` values, so an inconsistent environment fails in CI instead of at its first
boot. What only the operator has (ids, emails, the CA's terms) arrives as `operator_settings`,
and every secret as `secrets`, when Terraform is applied.

## Staging, on the providers' own addresses

Staging stays. When nobody is testing, its machines are stopped, not destroyed: its database
machine included, with its volume, and the worlds, bucket and secrets are kept, and cost only
their storage. `scripts/staging.ts` runs it,
and `scripts/staging-check.ts` checks it:

- `bun scripts/staging.ts up` makes whatever is missing in the `blockly-staging` Fly org and
  deploys this checkout: a Postgres machine, a Mailpit that only the org's private network
  reaches, the control (api and worker), realtime and edge apps, a Tigris bucket for
  archives, and the Polar sandbox webhook; and, built alongside them, the web app as the
  Cloudflare Worker `blockly-web-staging`, with staging's values, as production's is. The API answers on
  `fly.dev`, the web app on staging.cubepals.com (a proxied record its route answers), and
  players join `<server>.play.staging.cubepals.com`, whose wildcard
  records `up` points at the edge. The passwords and keys it made stay in
  `local/staging/state.json`, or come from `STAGING_STATE` where there is no such file.
- `bun scripts/staging.ts start` starts the platform again before testing, its database first,
  and waits until the database accepts connections (a few seconds); servers start when someone
  plays. `bun scripts/staging.ts stop` stops every machine in the org afterwards, the servers'
  included and the database last, and says whether any still runs. Neither touches the
  web Worker, which costs nothing idle.
- `bun scripts/staging.ts status` shows what exists and where to reach it.
  `bun scripts/staging.ts env` writes what a cloud environment needs to run all of this to
  `local/staging/cloud.env`, to paste into its settings.
- `bun scripts/staging-website.ts deploy` deploys the web Worker alone, from this checkout, with
  the secret it already has; the web-staging workflow runs it on each push to main.
  `bun scripts/staging-website.ts preview <n>` uploads this checkout as pull request `<n>`'s
  preview version, not live, at `https://pr-<n>.preview.cubepals.com`, and at its commit's
  `https://<sha7>.preview.cubepals.com`, which keeps that version after newer pushes; the
  workflow runs it on each pull request from this repository and names the addresses in a comment.
  `up` tells the control plane to trust those addresses (`WEB_TRUSTED_ORIGINS`) and lets their
  Google sign-in come back through staging's callback (`AUTH_OAUTH_PROXY_SECRET`). A preview
  talks to staging's control plane, which doesn't start for it: start staging to use one.
- `bun scripts/staging-check.ts` takes Free servers through their life on Fly and times each
  wait: three at once, each on its own account, one made, joined through the edge, asleep and
  woken; one rested in the archive store with its machine and volume let go, woken from the
  archive and found the same world; one killed and started again.
- `bun scripts/staging.ts down` destroys staging, its worlds included: every app in
  the org, the ones the control plane made for servers included, the buckets, staging's org
  tokens and the webhook, then lists what's left. It is only for when staging itself is to go,
  and is never run as cleanup. Fly keeps a destroyed volume's
  snapshots until their retention ends; there is no call to delete them sooner.

This staging differs from the design the tables' Staging column describes, which Terraform makes:
Postgres is not Managed Postgres but Postgres 17 on a Fly Machine of its own, in the app
`bly-staging-db` with a 1 GB volume, in the control plane's region (`fra`). The control plane and
realtime reach it at `bly-staging-db.flycast:5432` on the org's private network, directly: there is
no pooler, so there is no `DATABASE_DIRECT_URL` and `DATABASE_POOL_MAX` stays 5. Nothing outside the org
reaches it; the staging scripts open a `fly proxy` to it (`fly proxy 5432 -a bly-staging-db` by hand).
The password is derived from staging's auth secret, so it is the same in every state that holds
that secret; it is set as a Fly secret on the database app and in `DATABASE_URL` on the control and
realtime apps, kept in `STAGING_STATE`, and never printed. Flycast starts the machine for a
connection, so a pull request's preview that wakes the stopped API also finds its database; `stop`
and the nightly stop it again. The migrations need nothing but Postgres itself: no extension and no
role beyond the one that owns the database. There are no backups, because staging is seeded
again; `down` destroys the database with the rest. `STAGING_DATABASE=supabase` (a variable of the
workflows' `staging` environment, or in `local/secrets/staging.env`) switches back to the Supabase
staging project, through its session pooler, which `STAGING_DATABASE_URL` names; `down` leaves that
project be. Archives go to Tigris, not R2;
the web Worker is `staging.ts`'s, not Terraform's; the API and realtime are on `fly.dev`, not staging's own domain; mail goes to the Mailpit; and
Google is its only OAuth sign-in.

It needs flyctl signed in with a card on the org, `CLOUDFLARE_API_TOKEN` (DNS on cubepals.com)
and `CLOUDFLARE_WORKERS_API_TOKEN` (Workers Scripts, Workers Routes and R2 on its account) in
`local/secrets/staging.env` or the environment, and `POLAR_ACCESS_TOKEN` (sandbox, with
`webhooks:read` and `webhooks:write` beside the scopes below) and `POLAR_PRODUCTS` in `.env`.

## Control plane: every variable

Legend for **Set by**: `toml` is the app's `infra/fly/*.toml`; `tf` is the environment's
committed `settings`; `op` is `operator_settings`; `secret` is `secrets`; `computed` is the
Terraform stack.

### Identity and roles

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `DEPLOYMENT_ID` | `local` | `staging` | `prod` | tf | 2–16 of `a-z0-9-`. Names apps (`bly-<id>-…`) and provider resources, prefixes cookies, is the realtime ticket audience. Changing it strands everything named after the old one |
| `ROLES` | `api,worker,realtime` | per process group | per process group | toml | `api`, `worker`, `realtime`, comma-separated. Staging and production run `api` and `worker` as process groups of the control app and `realtime` as its own app |
| `DATABASE_URL` | compose Postgres | Fly Managed Postgres, pooled | Fly Managed Postgres, pooled | secret | Queries go through it (Managed Postgres's PgBouncer URL) |
| `DATABASE_DIRECT_URL` | — (`DATABASE_URL`) | Fly Managed Postgres, direct | Fly Managed Postgres, direct | secret | Past the pooler: the live-update listener's `LISTEN` and the release command's migrations. The pooler closes a client idle for ten minutes and breaks `LISTEN` in transaction mode (docs.fly.io/postgres) |
| `DATABASE_POOL_MAX` | `10` | `10` | `10` | toml | Connections each of a process's two pools (queries, the job queue's) may hold. A session-mode pooler such as Supabase's gives each one a server connection, and every process shares its limit, so a deployment on one sizes it down. The pooler must be session mode: advisory locks hold a connection's session for the length of the work |
| `SERVER_OPERATIONS_CONCURRENCY` | default `32` | default | default | — | Server operations each worker process runs at once, starts and wakes first. An operation spends nearly all its time waiting on the provider and a boot, holding no database connection while it waits; new Fly apps go out at one a second (`infra/fly/client.ts`). Each worker machine runs this many, so a rolling deploy briefly runs twice as many |
| `SERVER_WAKES_CONCURRENCY` | default `8` | default | default | — | Starts and wakes each worker runs at once on top of the above, on a lane of their own, so a queue of new servers never delays a player joining. They still wait for what their own server queued first |

### Listeners

| Variable | Local | Staging and production | Set by |
|---|---|---|---|
| `API_LISTEN` | `127.0.0.1:4000` | `0.0.0.0:8080` | toml (control) |
| `INTERNAL_LISTEN` | `127.0.0.1:4001` | `fly-local-6pn:4001` (the organization's private network only) | toml (control) |
| `REALTIME_LISTEN` | `127.0.0.1:7443` | `fly-global-services:443` (UDP reaches only sockets bound there, on the port browsers dial: Fly never rewrites a UDP port) | toml (realtime) |
| `REALTIME_FALLBACK_LISTEN` | `127.0.0.1:7444` | `0.0.0.0:7444` (Fly terminates TLS in front) | toml (realtime) |
| `METRICS_LISTEN` | unset (nothing is served) | `0.0.0.0:9091` (no service names it, so only Fly's private network reaches it; the edge reads it too) | toml (control, realtime, edge) |

### Web origins and auth

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `WEB_CANONICAL_ORIGIN` | `http://localhost:3000` | `https://staging.cubepals.com` | `https://cubepals.com` | tf | Better Auth's base URL is this plus `/api/auth`; https everywhere but loopback |
| `WEB_TRUSTED_ORIGINS` | empty | `https://pr-*.preview.cubepals.com`, `https://pr-*-blockly-web-staging.<subdomain>.workers.dev` and `https://???????.preview.cubepals.com` (staging.ts) | empty | tf | Other origins that serve the environment's web app: on staging, each pull request's preview and each previewed commit's. `*` stands for one or more letters, digits or dashes, `?` for one letter or digit, inside one label. A pattern's wildcards name the site; on workers.dev that includes the account's subdomain, so `https://*.workers.dev`, `https://pr-*.workers.dev` and `https://???.workers.dev` are refused |
| `AUTH_SECRET` | generated | secret | secret | secret | Better Auth's signing key. Rotating it signs everyone out |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | optional | secret | secret | secret | Both or neither; neither offers email only. See OAuth below |
| `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` | optional | optional | optional | secret | Both or neither |
| `AUTH_OAUTH_PROXY_SECRET` | empty | secret | not set | secret | Previews' Google sign-in through the canonical callback (§14). Empty: previews use email only |
| `WEB_PROXY_SECRET` | empty | secret | secret | secret | The web tier sends each browser's address with it, and only then is that address believed. Sign-in's limits (three a person every ten seconds, counted on each api machine, in memory, so about double with two) count by address; empty, the control plane counts by what its host's proxy saw (`fly-client-ip` on Fly), which is the web tier's own address for every browser |
| `SIGNUP_ALLOWLIST` | — | set | — | `staging.ts` | Comma-separated emails and `@domain`s; when set, only they (and `ADMIN_EMAILS`) can make an account, by email or a provider. Staging sets it to its developers (`STAGING_DEVELOPERS`) and the staging check's private domain |
| `ADMIN_EMAILS` | optional | op | op | op | Comma-separated; an account with one of these, once its email is confirmed, is an admin, and stops being one when taken off the list |
| `ADMIN_ALERT_EMAILS` | optional | optional | optional | op | Comma-separated; every email for the people running Cubepals (platform alerts, the spend watchdog) goes to these instead of each admin's account email. Who is an admin doesn't change. Empty, admin mail goes to each admin's own email |
| `SMTP_URL` | Mailpit | secret | secret | secret | Holds the mail provider's credentials |
| `MAIL_FROM` | `Cubepals <hello@blockly.localhost>` | `Cubepals Staging <hello@staging.cubepals.com>` | `Cubepals <hello@cubepals.com>` | tf | Every email is HTML with its plain text beside it; its pictures load from `WEB_CANONICAL_ORIGIN` under `/email/`. Staging's subjects also start with `[Staging] `, from `DEPLOYMENT_ID`, with no variable of their own |
| `MAIL_ACCOUNT_FROM` | `MAIL_FROM` | `MAIL_FROM` | `Cubepals <account@cubepals.com>` | tf | Who confirming an email, a reset and a changed password come from, an address of their own apart from the everyday mail. A reply goes to `MAIL_FROM`. Unset or empty, it is `MAIL_FROM`. The address needs the same domain the provider already sends `MAIL_FROM` from |
| `MAIL_NOTICE_FROM` | `MAIL_FROM` | `MAIL_FROM` | `Cubepals <noreply@beacon.cubepals.com>` | tf | Who the notices of what Cubepals changed on someone's server come from (a new address, out of Browse): an address nobody reads, so they carry no Reply-To and say so. Production's subdomain has a null MX, so a reply bounces. Unset or empty, it is `MAIL_FROM`. The provider must already send from its domain |

### Realtime

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `REALTIME_PUBLIC_URL` | `https://127.0.0.1:7443/` | `https://rt.staging.cubepals.com/` | `https://rt.cubepals.com/` | tf | What browsers dial for WebTransport. Locally an IP, not `localhost`: WebTransport doesn't fall back from `::1` |
| `REALTIME_FALLBACK_URL` | `ws://127.0.0.1:7444/transport-io` | `wss://rt.staging.cubepals.com/transport-io` | `wss://rt.cubepals.com/transport-io` | tf | The WebSocket fallback, on TCP 443 in deployed environments |
| `REALTIME_TLS_MODE` | `pinned` | `pinned` | `acme` | tf | `pinned`: self-signed, browsers pin its hash (the api serves it). `acme`: a CA certificate the realtime role gets itself. `provided`: `REALTIME_TLS_CERT` and `REALTIME_TLS_KEY` files |
| `REALTIME_TLS_HOSTNAME` | `localhost` | `rt.staging.cubepals.com` | `rt.cubepals.com` | tf | In `acme` mode it must be `REALTIME_PUBLIC_URL`'s host, with an A record and no AAAA (checked at start) |
| `REALTIME_TICKET_SECRET` | generated | secret | secret | secret | Signs the 60-second tickets browsers connect with; rotating it only fails connections in flight |
| `ACME_DIRECTORY_URL` | — | — | Let's Encrypt (default) | — | Point at Let's Encrypt's staging directory to rehearse |
| `ACME_EMAIL` | — | — | op | op | The CA's contact for the account |
| `ACME_AGREE_TOS` | — | — | op (`true`) | op | The operator's acceptance of the CA's terms; nothing accepts them by default |
| `ACME_DNS_PROVIDER` | — | — | `cloudflare` | tf | The only provider |
| `CLOUDFLARE_DNS_API_TOKEN` | — | — | secret | secret | DNS edit on the zone only: it writes and removes `_acme-challenge` TXT records |
| `CLOUDFLARE_ZONE_ID` | — | — | computed | computed | The zone holding `REALTIME_TLS_HOSTNAME`: `TF_VAR_cloudflare_zone_id` |

The issued certificate is stored in `realtime_certificate` with its key sealed under
`RUNTIME_SECRETS_KEY`, reused across restarts, and renewed at two thirds of its life by a
restart.

### Play addresses and regions

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `PLAY_DOMAIN` | `play.localhost` | `play.staging.cubepals.com` | `play.cubepals.com` | tf | Players join `<slug>.<PLAY_DOMAIN>`; wildcard A/AAAA records point at the edge. No platform host may sit under it |
| `PLAY_DOMAIN_ALIASES` | empty | empty | empty | tf | Old play domains, still routed while players move (§11) |
| `PLAY_PORT` | `25565` | `25565` | `25565` | tf | |
| `REGIONS` | `eu:Europe,us:North America` | `eu:Europe,us:North America` | same | tf | The regions people choose from, `key:Label`; exactly one on Docker, which runs everything on one machine, except in local development |
| `RUNTIME_REGION_MAP` | `eu:local,us:local` | `eu:fra,us:iad` | same | tf | Each region's placement on the default runtime; every region needs one. The default's own `<NAME>_REGION_MAP` (`FLY_REGION_MAP`) stands in for it. No other runtime reads it: each needs its own `<NAME>_REGION_MAP` (`FLEET_REGION_MAP`, `BOAT_REGION_MAP`), and places only the regions that names; the start is refused without one ([runtimes.md](runtimes.md)) |

### Runtime

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `RUNTIME_PROVIDER` | `docker` | `fly` | `fly` | tf | The default runtime, where new servers go unless a placement rule says otherwise. `fake` in tests; `boat` for Boat's sandboxes (`BOAT_*` below); `fleet` for hosts running blocklyd ([below](#fleet)) |
| `RUNTIME_PROVIDERS` | `RUNTIME_PROVIDER` | — | — | tf | Every runtime the deployment runs at once, comma-separated (`fly,fleet`), the default among them ([runtimes.md](runtimes.md)) |
| `OPERATOR_TOKEN` | — | — | random (`production.ts init`) | secret | Bearer token of the operators' APIs on the internal listener (`scripts/ops.ts`, `scripts/runtimes.ts`, `scripts/fleet.ts`); `FLEET_OPERATOR_TOKEN` is read too. None turns the APIs off; required when the fleet runs |
| `DOCKER_SOCKET`, `DOCKER_GAME_NETWORK` | `/var/run/docker.sock`, `blockly-games` | — | — | — | Docker only |
| `FLY_ORG` | — | `blockly-staging` | `blockly-prod` | tf | One organization per environment |
| `FLY_API_TOKEN` | — | secret | secret | secret | An organization token (`fly tokens create org <org>`): the runtime creates and destroys game machines with it |
| `FLY_NATS_URL` | — | default `nats://[fdaa::3]:4223` | same | — | The organization's log stream, inside its network |
| `FLY_MACHINE_LIMIT` | — | computed (`fly_machine_limit`) | computed (`fly_machine_limit`) | computed | The organization's machine limit, as Fly support set it. The Fly runtime reports `limit − platform machines − 2` as the most servers it holds: one machine a server, and two kept for a restore's, an export's or a move's machine while it runs. The control plane holds `maxServers` to that (§19.12). Raise it with Fly first, then the `fly_machine_limit` variable |
| `BOAT_API_TOKEN`, `BOAT_API_URL` | — | — | — | secret | Boat: the account's API key; the API's base (`https://boat.dev/api/v1`) |
| `BOAT_RUN_TTL_SECONDS`, `BOAT_START_RESERVE` | — | — | — | — | Auto-stop for a running sandbox (unset on a paid plan; ≤ 7200 on the trial); the share of the day's starts kept for wakes (`0.1`) |
| `FLY_SUSPEND` | — | default `true` | default `false` | — | Whether a server put to sleep (idle, nobody joined, its owner's stop) is suspended rather than stopped, so a join wakes it in about a second instead of 40. The default follows `DEPLOYMENT_ID`: on everywhere but `prod`, whose switch is turned on once staging has run it. `false` turns it off; nothing else changes. Admins switch it on the platform page without a deploy; this is the default while they haven't, and "Use the default" there returns to it |
| `FLY_PLATFORM_MACHINES` | — | computed (4) | computed (4) | computed | The machines the platform runs itself (api, worker, realtime, edge), set from the `fly-org` module |
| `RUNTIME_SECRETS_KEY` | generated | secret | secret | secret | Derives every server's RCON password and artifact token, and seals the realtime key. `version:key` (`2:<key>`); a bare key is version 1. Rotate it as [below](#rotating-the-runtime-key) |
| `FLOODGATE_KEY` | — | secret | — | optional secret | The key Paper servers share with the edge to take Bedrock players in: 16 bytes as base64, one per environment, written to each server as `plugins/floodgate/key.pem` at its start and never logged. Without it, no server is given Floodgate and no page says that Bedrock players can join. Changing it reaches a server at its next start |
| `RUNTIME_SECRETS_PREVIOUS_KEYS` | — | secret, only while rotating | same | same | Earlier `version:key`s still accepted, comma-separated: servers not yet moved onto the current key keep working |
| `ARTIFACTS_RUNTIME_FACING_URL` | `http://host.docker.internal:4000` | computed (`https://bly-staging-control.fly.dev`) | computed | computed | Where game runtimes download mod files |
| `ARTIFACTS_MIRROR` | `false` | `true` | `false` | tf | Keep a copy of every catalog jar; needs an archive store, and is the operator's licensing decision |
| `CATALOG_USER_AGENT` | default | default | default | — | Identifies Blockly to Modrinth (`blockly-control/<DEPLOYMENT_ID>`, with the repository's address) |

### Fleet

`fleet` in `RUNTIME_PROVIDERS` (or as `RUNTIME_PROVIDER`): servers on Linux hosts running
[blocklyd](https://github.com/cubepals/blocklyd) ([fleet.md](fleet.md), [fleet-operations.md](fleet-operations.md)).
It needs an archive store and `OPERATOR_TOKEN`, and `FLEET_REGION_MAP` maps product regions to the
regions nodes enroll into (`RUNTIME_REGION_MAP` may, where the fleet is the default runtime).

| Variable | Default | Notes |
|---|---|---|
| `FLEET_CA_CERT`, `FLEET_CA_KEY` | — | The deployment's fleet CA (`bun scripts/fleet.ts ca`), PEM; `\n` escapes are accepted. The key is a secret |
| `FLEET_NODE_LISTEN` | `[::]:8443` | The node endpoint (enrollment, heartbeats, renewal), on the `api` role: every address, IPv6 and IPv4, since Fly's private network is IPv6. On a host without IPv6, `0.0.0.0:8443`. Open it on the private network only |
| `FLEET_ENDPOINT_HOSTS` | — | Comma-separated names and addresses nodes dial the node endpoint by; its certificate names them. At least one |
| `FLEET_JOIN_URL` | `https://<first of FLEET_ENDPOINT_HOSTS>:<FLEET_NODE_LISTEN's port>` | Where new hosts reach the node endpoint to join: the URL join tokens carry and the pasted line fetches from ([fleet-operations.md](fleet-operations.md#2-adding-a-node)). Set it when hosts reach the endpoint some other way; its certificate names this host too |
| `FLEET_BLOCKLYD_BIN` | `/usr/local/lib/blocklyd/blocklyd` | The static blocklyd the node endpoint hands to joining hosts (`GET /fleet/v1/blocklyd`). The control plane's image carries the blocklyd release it pins there (`bun scripts/blocklyd.ts version`); without the file the endpoint answers 404 and says so |
| `FLEET_SUSPEND` | `off` | `on` suspends a fleet server put to sleep, with its memory kept, on a node whose blocklyd can (the `suspend` feature), so its next start resumes it where it was; `off`, or a node that can't, stops it ([waking.md](waking.md#on-the-fleet)) |
| `FLEET_UPGRADES` | `on` | `on` offers that blocklyd to nodes on an older version, one node per region at a time, in heartbeat answers ([fleet-operations.md §9](fleet-operations.md#9-upgrading-blocklyd)); `off` offers nothing, and nodes keep what they run |
| `FLEET_PLACEMENT` | `balanced` | `balanced`, `binpack` or `spread` |
| `FLEET_HEADROOM_MB` | `0` | Memory a new placement must leave free on its node beside the servers running there; starts may use it |
| `FLEET_MEMORY_OVERCOMMIT` | `4` | How many times its memory the servers placed on a node may add up to. Only running servers hold memory; a start finds room or moves first ([fleet.md §5](fleet.md#5-placement)). `1` holds memory for every placed server |
| `FLEET_CPU_MILLIS_PER_GB` | `250` | CPU a server is counted for, per GB of memory |
| `FLEET_CPU_OVERCOMMIT`, `FLEET_CPU_PRESSURE` | `1`, `0.8` | CPU promised beyond a node's cores; the share past which `balanced` prefers other nodes |
| `FLEET_DISK_OVERCOMMIT` | `1` | Disk promised to worlds beyond a node's size |
| `FLEET_HEARTBEAT_SECONDS` | `5` | How often nodes beat |
| `FLEET_LEASE_SECONDS` | `120` | How long after a beat a node may restart a failed server on its own; more than three beats |
| `FLEET_SUSPECT_SECONDS`, `FLEET_UNAVAILABLE_SECONDS` | `15`, `45` | Silence before a node reads suspect, then unavailable. Neither makes it lost: only an operator does |
| `FLEET_NODE_CERT_DAYS`, `FLEET_RENEW_DAYS` | `30`, `10` | Node certificates' life, and when renewal starts |

### Archive store (optional capability)

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `ARCHIVE_S3_ENDPOINT` | RustFS `http://127.0.0.1:9000` | computed (R2) | computed (R2) | computed | Empty turns archives, downloads and uploads off (§15.4) |
| `ARCHIVE_S3_RUNTIME_ENDPOINT` | `http://host.docker.internal:9000` | — | — | — | Only when game runtimes reach the store by another name |
| `ARCHIVE_S3_BUCKET` | `blockly-local` | `blockly-staging-archives` | `blockly-prod-archives` | tf | Terraform creates it with a CORS rule for the web origin |
| `ARCHIVE_S3_REGION` | `auto` | `auto` | `auto` | tf | |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | compose | secret | secret | secret | An R2 API token's S3 credentials, made in the Cloudflare dashboard |

### Billing (optional capability)

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `POLAR_ACCESS_TOKEN` | optional | secret | optional (off at launch) | secret | An organization access token with `checkouts:write`, `customer_sessions:write`, `customers:read`, `subscriptions:write`, `products:read`, `orders:read`, `payments:read`, `refunds:write`, `events:write` and `discounts:write`. Absent: plans come from the account's plan column alone |
| `POLAR_WEBHOOK_SECRET` | optional | secret | optional (off at launch) | secret | `whsec_…`, from the webhook endpoint in Polar's dashboard (`<WEB_CANONICAL_ORIGIN>/api/billing/webhook`, API version 2026-10, events `customer.state_changed`, `order.created`, `order.updated`, `order.paid`, `order.refunded`, `subscription.active`, `subscription.past_due`, `subscription.canceled`, `subscription.uncanceled` and `subscription.revoked`) |
| `POLAR_SERVER` | `sandbox` | `sandbox` | `production` | tf | Named explicitly |
| `POLAR_PRODUCTS` | optional | op | optional (off at launch) | op | `core:<product id>,plus:<product id>`, one for each paid plan on sale; a plan without one is not for sale yet, and the control plane says so at start. Production takes it with the two secrets above or none of them ([production.md](production.md#billing-later)) |
| `GIFTS_BY_EMAIL` | `false` | `false` | `false` | tf | Gifts emailed to the person they are for, bought with or without an account. Off, a gift is a code emailed to the account that bought it, and Polar's order for a gift a guest started is not kept |

### Room for new servers

When there is no room, a create is refused at once rather than queued, and creates close by
themselves until there is (`apps/control/src/app/platform/room.ts`).

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `WAKE_RESERVE` | `2` | `2` | `2` | — | Servers and running places new servers leave to the servers people already have, so a start or a wake is never refused because creates filled the room |
| `CREATE_WAIT_SECONDS` | `60` | `60` | `60` | — | How long the oldest create still waiting for a worker may have waited before creates count as full |

### Private tuning

Numbers that belong to the business, not the code: how free accounts are linked, caps on
abuse and money, and how room is shared when it runs short. Each is one line of JSON in one variable. Production refuses to start without
them (`ECONOMICS_TUNING` apart); elsewhere unset is a harmless default (`apps/control/src/domain/account/tuning.ts`). Any
deployment refuses a value that isn't the shape below. The values themselves are kept privately.

| Variable | Local | Staging | Production | Set by | Shape |
|---|---|---|---|---|---|
| `FREE_LINK_TUNING` | default | default | secret | secret | `{ "weights": { "mainPlayer", "inbox", "signedUpClose", "network" }, "link", "medium", "high", "signedUpCloseMs", "mainShare", "mainForS", "networkKeptMs" }`: the weights are non-negative; `link`, `medium`, `high` and `mainShare` are in [0, 1], with `link < medium < high`; the rest are positive whole numbers |
| `ABUSE_LIMITS` | default | default | secret | secret | `{ "chipIn": { "payerDayCents", "serverDayCents" }, "extraCeiling": { "untilRenewed", "renewed" }, "giftsPerDay", "wrongCodesPerHour", "wakesPerHour", "pingWakeHoldHours", "knownAddressDays", "inviteJoinsPerHour", "joinReportsPerSecond", "joinReportBytes" }`: whole numbers, positive but for `untilRenewed`, which is at most `renewed`; `pingWakeHoldHours`, `knownAddressDays`, `inviteJoinsPerHour`, `joinReportsPerSecond` and `joinReportBytes` may be left out for their defaults |
| `ECONOMICS_TUNING` | default | default | optional secret | secret | `{ "paymentFee": { "percent", "fixedCents" }, "archiveGbMonthCents" }`: the fee taken from each order, as a percent of its total plus a fixed amount in cents, and what a GB-month of backups costs, in cents. Unset in production, the runtime economics report leaves fees and margin out |
| `CAPACITY_TUNING` | default | default | secret | secret | `{ "freeShare", "tightShare", "tightIdleMinutes" }`: the share of the room for new servers free plans may fill, the share of running room past which room is tight, and how long a free server nobody is on stays up while it is. The shares are in [0, 1]; the minutes a positive whole number |
| `SIGNALS` | unset | optional secret | optional secret | secret | `SignalsConfig` in `packages/contracts/src/join-records.ts`: which kinds of join signal run, each by its key, with its limits, and the watched addresses. Optional everywhere: unset, or not that shape, no signal runs and the log says so once |

### Files for official servers (optional)

`OFFICIAL_SERVER_FILES` is one line of JSON: sections, each an object from a path under `/data` to
the file's content. The `*` section is for every official server; a section named by a server's id
or slug is for that server, and wins at a path both name. Servers an operator flags `official` get
their files at every start, over the revision's files at the same paths. Other servers never do,
whatever a revision holds at the same paths or the settings name for them. The files are never
stored in a revision, so no revision read or export has them. A world download leaves them out,
for a server named in the settings even after it stops being official. A change reaches a server at
its next start; a running server isn't restarted for it.

```json
{ "*": { "plugins/Example/config.yml": "a: 1\n" }, "<server id or slug>": { "plugins/Example/config.yml": "a: 2\n" } }
```

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `OFFICIAL_SERVER_FILES` | unset | unset | secret | secret | Section names are `*`, a server id or a slug; paths are relative, with no `..`; contents are text. Unset, or not that shape, official servers start with the public defaults and an admin alert says so. Production alerts for unset only once a server is flagged |

### Stop cheaters (optional)

`STOP_CHEATERS` is one line of JSON: the punishments file Stop cheaters writes for Grim on servers
where it is on (`plugins/GrimAC/punishments.yml`), and when a player's removals become a ban.

```json
{ "punishments": "<Grim's punishments.yml as text>", "ban": { "reason": "impossible", "removals": 1, "withinMinutes": 1, "minutes": 1 } }
```

The file's commands remove a player through the join reporter's console command,
`cubepals-remove %player% <movement|speed|impossible>`, which kicks them with words saying they can
rejoin and tells the control plane. When a player's `impossible` removals on one server reach
`removals` within `withinMinutes`, and the server runs the moderation tools, Cubepals bans them
from that server for `minutes`, recorded as any ban is and liftable from the player's page. The
numbers above only show the shape; the real ones are in the private records. The file is written
at every start where Stop cheaters is on, never stored in a revision, and left out of world
downloads; on an official server, `OFFICIAL_SERVER_FILES` at the same path wins. A change reaches a
server at its next start; a running server isn't restarted for it.

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `STOP_CHEATERS` | unset | unset | secret | secret | Unset, or not that shape, servers get the public default: Grim's own groups with alerts and logs only, and no removal or ban. In production an admin alert says so while any server has Stop cheaters on |

### Join reporter (optional)

The join reporter is a Paper plugin Cubepals builds (`apps/reporter`) and places beside a server's
own plugins, so the server tells the control plane its half of each join: when the player logged
in, finished configuring, came into the world and left. It goes on Paper servers that play no
modpack, at their next full boot: a running server isn't restarted for it, and a sleeping one
still wakes from memory and gets it at the boot after. It posts to `/runtime/v1/servers/<id>/joins`
with the server's own token, as the server's jar links carry. With `CUBEPALS_REPORT_URL` unset the
plugin does nothing.

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `JOIN_REPORTER` | `off` | optional | optional | op | `off`, `official` (the servers flagged official) or `all`; unset is `off`. Needs an archive store, where the jar is kept |

### Product analytics (optional)

PostHog's EU cloud. Production alone sends anything; staging and local stay off unless someone
sets the token by hand to try it, and then every event says which environment it came from,
which the project's charts leave out.

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `POSTHOG_TOKEN` | empty | empty | the project's `phc_…` token | tf | The project's public token (the kind every page ships). Empty: nothing is sent, no question is asked, and Feedback is hidden. The `environment` on each event comes from `DEPLOYMENT_ID` (`prod` is `production`, `staging` is `staging`, anything else `development`) |
| `POSTHOG_HOST` | — | — | default `https://eu.i.posthog.com` | — | Where events go |

## Edge

| Variable | Local (compose) | Staging and production | Set by |
|---|---|---|---|
| `CONTROL_URL` | `http://host.docker.internal:4001` | `http://api.process.bly-<id>-control.internal:4001` | Terraform (edge) |
| `EDGE_TOKEN` | from `.env` | the control plane's `EDGE_TOKEN` | Terraform (edge) |
| `WEB_CANONICAL_ORIGIN`, `PLAY_DOMAINS` | unset: browsers aren't answered | the web app's origin; `PLAY_DOMAIN` and its aliases, comma-separated. A browser opening `<slug>.<domain>` is sent to `<origin>/server/<slug>` when a server has that address, and to `<origin>/` otherwise | Terraform (edge) |
| `BROWSER_PORT` | `8080` (Fly's HTTP service on 80 and 443) | same | — |
| `IDLE_HINT_AFTER` | `10m` (compose knob) | `10m` | toml |
| `MINECRAFT_PORT` | `25565` | `25565` | toml |
| `FLOODGATE_KEY` | unset: Bedrock players aren't taken | the same key as the control plane's, base64 of 16 bytes. With it the agent starts Geyser (`apps/edge/bedrock.ts`) and answers Bedrock on UDP `BEDROCK_PORT` | Terraform (edge) |
| `BEDROCK_PORT`, `BEDROCK_BIND` | `19132`, `fly-global-services` | same: the one address Fly delivers UDP to | toml |
| `BEDROCK_VALIDATE_LOGIN` | `true` | `true`. `false` skips Xbox sign-in and is for a test edge whose headless clients have no account (`tools/bedrock-join`); the Bedrock E2E workflow sets it on staging for its run and back after | — |
| `BEDROCK_PONGS_PER_SECOND`, `BEDROCK_PONGS_BURST`, `BEDROCK_TOTAL_PONGS_PER_SECOND`, `BEDROCK_TOTAL_PONGS_BURST`, `BEDROCK_OPENS_PER_SECOND`, `BEDROCK_OPENS_BURST`, `BEDROCK_MOST_PLAYERS` | `2`, `10`, `200`, `400`, `1`, `10`, `2000` | same: pongs sent per address and in all, new connections opened per address, players held at once | — |
| `GEYSER_JAR`, `GEYSER_DIR`, `GEYSER_WARM`, `GEYSER_HEAP` | the image's jar, `/tmp/geyser`, the game files fetched at image build, `768m` | same, with `GEYSER_HEAP` set in the toml to fit the machine. The jar's build is pinned in `apps/edge/Dockerfile` and raised with `bun scripts/geyser.ts bump` | — |
| `EDGE_ID` | `local-edge` | the machine's hostname | — |
| `ROUTES_POLL_MS` | `1000` | same | — |
| `AGENT_PORT` | `8090` (mc-router's webhooks) | same | — |
| `NOTICE_PORT`, `SLEEPING_PORT` | `25564`, `25563` (the restarting and sleeping notices) | same | — |
| `RESTARTING_MOTD`, `RESTARTING_JOIN` | `Restarting · back in a moment`, `Restarting · join again in a moment` | same | — |
| `ASLEEP_MOTD`, `LOADING_MOTD` | `Sleeping · join to wake it up`, `Starting up · try again in a moment` | same | — |
| `EXAMPLE_MOTD`, `EXAMPLE_JOIN` | `Just an example address` and `Make your own at cubepals.com` on two lines; `You found our example address. Make a server of your own at cubepals.com and send your friends its address.` (Cubepals' example address, `your-server` under each of `PLAY_DOMAINS`: `apps/edge/example-address.ts`) | same | — |
| `ROUTER_BIN` | `/mc-router` | same | — |
| `CONNECTION_RATE_LIMIT` | `1000` (mc-router's `-connection-rate-limit`, every server together) | same | — |
| `PROXY_PROTOCOL` | empty | `1`: Fly's proxy opens each connection with a PROXY line | toml |
| `ROUTER_PORT` | `25561` (mc-router, behind the agent's front door) | same | — |
| `ROUTER_API_PORT` | `25560` (mc-router's API, on the machine only: how routes change) | same | — |
| `CONNECT_TIMEOUT_MS`, `IDLE_TIMEOUT_MS` | `10000`, `60000` (a connection the edge makes: to connect, then with nothing passing either way) | same | — |
| `ADDRESS_CONNECTIONS_PER_SECOND`, `ADDRESS_CONNECTIONS_BURST`, `ADDRESS_GREETING` | `5`, `30`, `10` (per address, an IPv6 one by its /64) | same | — |
| `SERVER_CONNECTIONS_PER_SECOND`, `SERVER_CONNECTIONS_BURST`, `SERVER_OPEN_CONNECTIONS` | `20`, `100`, `300` (per server) | same | — |
| `BUSY_JOIN` | `This server is busy right now · join again in a moment` | same | — |

## Web

| Variable | Local | Staging and production | Set by |
|---|---|---|---|
| `API_UPSTREAM` | default `http://127.0.0.1:4000` | the control app's origin (`https://bly-<id>-control.fly.dev`); server-side only, never in the bundle. Read at build time too: the `/api` rewrite is written into the build | The Worker's deploy (`scripts/lib/web-worker.ts`), build and vars |
| `NEXT_OUTPUT` | — | — | `standalone` in `apps/web/Dockerfile` for self-hosting, where `API_UPSTREAM` is a build argument because Next writes the rewrite at build time |
| `WEB_PROXY_SECRET` | empty | the control plane's value: sent with each browser's address on every `/api/auth` call and session check (`src/lib/before-next.ts`, `src/lib/client-address.ts`) | The Worker's deploy, as a secret (a secrets file, never a var) |
| `DEPLOYMENT_ID` | empty (`development`) | the control plane's value | The Worker's build. Read at build time: each PostHog event says `production`, `staging` or `development` by it |
| `GIT_COMMIT_SHA` | — (`dev`) | the commit deployed | The Worker's build: the version PostHog's events and source maps carry |
| `NEXT_PUBLIC_POSTHOG_TOKEN` | empty; `apps/web/.env.local` to try PostHog | production only: the same token as `POSTHOG_TOKEN` | The Worker's build, from production's `POSTHOG_TOKEN`. Read at build time; empty sends nothing and hides Feedback |
| `NEXT_PUBLIC_POSTHOG_HOST` | — | default `https://eu.i.posthog.com` | — |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | — | production, once an operator adds them: a personal API key with error tracking write, and the project's id. With both, the build uploads its source maps to PostHog and deletes them (`apps/web/scripts/sourcemaps.ts`); without, it skips that | `production.env`, then production's Worker build only (never Terraform) |
| `WEB_CANONICAL_ORIGIN`, `WEB_INDEXABLE` | as the control plane's; `WEB_INDEXABLE` empty | the site's address; `WEB_INDEXABLE=1` in production alone, from `web.indexable` | The Worker's build (robots, the sitemap) and vars |
| `WEB_CLIENT_ADDRESS_HEADER` | empty | `cf-connecting-ip`, which Cloudflare's edge sets and overwrites. Empty, no address is sent | The Worker's deploy, as a var |
| `WEB_FORWARDED_HOST` | empty | empty; a pull request's preview alone: its branded hosts, `pr-<n>.preview.cubepals.com` and its commit's `<sha7>.preview.cubepals.com`, a comma between them, one of which the previews' router (`apps/web/preview-router.ts`) says in `x-forwarded-host`. The `/api` calls of a request saying one tell the control plane that host | The preview's upload (`scripts/staging-website.ts`), as a var |

Production's Worker is `blockly-web`, deployed by `scripts/production.ts`; staging's is
`blockly-web-staging` (`wrangler.jsonc`'s `staging` environment), deployed by `scripts/staging.ts`.
Each is built with its environment's values and checked against them before it goes out. A page's
server render waits at most `RENDER_READ_MS` (`src/lib/upstream.ts`) on each answer from the
control plane, and is sent without the ones that take longer.

`blockly-web-previews` (`apps/web/preview-router.jsonc`) answers for `*.preview.cubepals.com`, each
pull request's preview at its own address, and sends each request on to that preview's workers.dev
alias. `scripts/staging-website.ts deploy` deploys it with staging's website and keeps its proxied
wildcard record.

## Secrets

Generate the random ones with `openssl rand -base64 48` (at least 16 characters each; the
schema refuses shorter). Each has a `secret_versions` marker, a non-secret string that changes
when the value does (a date works), so Terraform re-sends it: Fly returns only a digest.

| Secret | Kind | Rotating it |
|---|---|---|
| `AUTH_SECRET` | random | Signs everyone out |
| `REALTIME_TICKET_SECRET` | random | Fails only connections being opened |
| `EDGE_TOKEN` | random, shared by the control and edge apps | Set both in one apply |
| `FLOODGATE_KEY` | 16 random bytes, base64 (`openssl rand -base64 16`), shared by the control and edge apps | Set both in one apply, then restart the edge and every Paper server: until each holds the new key, Bedrock players are refused there |
| `RUNTIME_SECRETS_KEY` | random, `version:key` | A version bump, with the old key kept as `RUNTIME_SECRETS_PREVIOUS_KEYS` until nothing runs on it ([below](#rotating-the-runtime-key)) |
| `AUTH_OAUTH_PROXY_SECRET` | random (staging) | A sign-in in flight fails |
| `WEB_PROXY_SECRET` | random, shared by the control plane and the web app | Set both in one apply, which deploys the control app and the website with it. Until both run on it, sign-in counts the web tier's address for everyone |
| `DATABASE_URL` | Fly Managed Postgres, pooled | Restart both apps |
| `DATABASE_DIRECT_URL` | Fly Managed Postgres, direct | Restart both apps |
| `FLY_API_TOKEN` | `fly tokens create org` | Restart the control app |
| `SMTP_URL` | mail provider | Next email |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | R2 API token | Next request |
| `AUTH_GOOGLE_CLIENT_*`, `AUTH_GITHUB_CLIENT_*` | provider console | Next sign-in |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` | Polar dashboard | Next call, next webhook |
| `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare, DNS edit on the zone | Next renewal |
| `FLEET_CA_KEY` | `bun scripts/fleet.ts ca` | Re-provisions the fleet: every node enrolls again ([fleet.md §3](fleet.md#3-trust)) |
| `OPERATOR_TOKEN` | random | Next operator call |

## OAuth callbacks, per environment

Each environment has its own OAuth clients (§14): a client never serves two environments.

| Environment | Google client: authorized redirect URI | JavaScript origin |
|---|---|---|
| Local | `http://localhost:3000/api/auth/callback/google` | `http://localhost:3000` |
| Staging | `https://staging.cubepals.com/api/auth/callback/google` | `https://staging.cubepals.com` |
| Production | `https://cubepals.com/api/auth/callback/google` | `https://cubepals.com` |

Previews register nothing: their sign-in goes out and back through staging's callback
(`oAuthProxy`, `AUTH_OAUTH_PROXY_SECRET`) and the preview gets the session. GitHub, where used,
takes `<WEB_CANONICAL_ORIGIN>/api/auth/callback/github` the same way.

## When a provider region is deprecated, or a host fails

A deprecated Fly region fails the control plane's boot check (§2). Map the product region onto a
live one in `RUNTIME_REGION_MAP` (`eu:fra` rather than `eu:ams`) and deploy: every server whose
machine is still in the old region moves there on its own, the product region unchanged, an
idle one within minutes and a busy one once its players leave (`relocations`, every minute,
three at a time; each is audited as `server.relocation_scheduled`). A move waits while the new
region has no room for it; one the provider refuses anyway leaves the server as it was.

A machine whose host Fly can't reach is noticed when its console stops answering. After ten
minutes without the host, the server is rebuilt on another host in its region from its newest
snapshot, and its owner gets an email saying what was lost (`server.rebuilt_from_backup`). With
no room in the region, it waits, and is rebuilt as soon as there is. A server with no snapshot
can't be rebuilt: it fails in `relocating`, and the stuck-work page shows it.

On the `fleet` runtime a silent node is never taken for lost: its servers wait until an operator
has fenced the host and declared it lost ([fleet-operations.md §5](fleet-operations.md#5-declaring-a-node-lost)).
From then on it is the same: ten minutes later each server is rebuilt on another node from its
newest uploaded snapshot, and its owner is told.

## Rotating the runtime key

Every server's console password and mod download links derive from `RUNTIME_SECRETS_KEY`, and
a running server keeps the ones it booted with. A rotation is a version bump plus an apply
(§19.16): nothing stops, and nothing is refused along the way.

1. Generate the new key, and give it the next version: `RUNTIME_SECRETS_KEY=2:<new key>`.
2. Keep the old one accepted: `RUNTIME_SECRETS_PREVIOUS_KEYS=1:<old key>` (add it to
   `TF_VAR_secrets`, and change both `secret_versions` markers). Apply, then deploy.
3. Watch Admin → Platform → Runtime key. Each running server moves onto the new key at its next
   update: an idle one within minutes (drift applies up to five at a time), a busy one when its
   players leave. Stopped servers boot on the new key. The realtime key is sealed again under the
   new key the next time the realtime role starts; its certificate stays.
4. When the page says nothing runs on version 1 any more, drop `RUNTIME_SECRETS_PREVIOUS_KEYS`
   from `TF_VAR_secrets`, and apply.

A leaked key is the same procedure: until step 4, it opens only the jar downloads of servers
still on it (§19.16), and their consoles over the private network.

## Applying an environment

Production does all of this with `bun scripts/production.ts apply`, from one file of values
([production.md](production.md)); what follows is what it runs.

Terraform owns the apps, their addresses and secrets, DNS, the archive bucket, production's
database dumps bucket ([production.md](production.md#database-dumps)) and the website's Worker,
cache bucket and routes; `fly deploy` owns machines and releases, and wrangler the Worker's versions. Fly's Terraform provider (`ampbase-io/fly`)
has no Managed Postgres resource, so the database is made once with `fly mpg create`; its pooled
URL (`pgbouncer.<cluster>.flympg.net`) becomes the `DATABASE_URL` secret and its direct one
(`direct.<cluster>.flympg.net`) `DATABASE_DIRECT_URL`.

1. Tokens in the environment: `FLY_API_TOKEN` (an org token for the environment's org),
   `CLOUDFLARE_API_TOKEN` (DNS and Workers Routes edit on the zone, R2 and Workers Scripts edit
   on the account).
2. State: an R2 bucket of the operator's, named in `backend.hcl` (not committed):
   ```hcl
   bucket                      = "blockly-terraform-state"
   key                         = "staging.tfstate"
   region                      = "auto"
   endpoints                   = { s3 = "https://<account id>.r2.cloudflarestorage.com" }
   skip_credentials_validation = true
   skip_region_validation      = true
   skip_requesting_account_id  = true
   use_path_style              = true
   ```
3. The environment's values: copy its `config.auto.tfvars.example.json` to
   `config.auto.tfvars.json` and put in your own. Then
   `terraform -chdir=infra/terraform/environments/<name> init -backend-config=backend.hcl`
4. `terraform apply` with `TF_VAR_secrets` and `TF_VAR_secret_versions` (JSON objects keyed
   by `secret_names`), `TF_VAR_operator_settings` (JSON), `TF_VAR_cloudflare_account_id` and
   `TF_VAR_cloudflare_zone_id`, and `TF_VAR_hcloud_token` once `fleet-nodes.auto.tfvars.json`
   lists a fleet node. Secrets in `optional_secret_names` (billing, GitHub sign-in) may be left
   out. The plan refuses a missing secret, one with a name the environment doesn't use, billing
   given in part, and an org machine limit that leaves no room for a server beside the platform's
   machines and the two kept for helpers (§19.12).
5. Deploy, from the repository root:
   `fly deploy . --config infra/fly/control.toml --dockerfile apps/control/Dockerfile --app bly-<id>-control`
   (migrations run first), then `realtime.toml` (and `fly scale count 1`), then `edge.toml`.
6. Build and deploy the website's Worker with the environment's values: `production.ts` does it
   with `scripts/lib/web-worker.ts`, which passes the same values to the build and the deploy.
