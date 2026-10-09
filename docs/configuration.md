# Configuration and secrets

Every Blockly deployment is configured the same way: environment variables, read once at start
into `DeploymentConfig` (`apps/control/src/config/schema.ts`, `load.ts`). A missing or
inconsistent value stops the start with every problem listed; nothing falls back silently.
Local development is the one exception, and it says so: each stand-in is a line in the log.
Nothing in the code names a deployment, a domain or a port.

| Environment | Where the values come from |
|---|---|
| Local | `.env` at the repository root, a copy of `.env.example` as it is ([local development](local-development.md): what stands in there for outside services) |
| Staging, production | Fly secrets on each app, set by Terraform (`infra/terraform`), plus each app's `infra/fly/*.toml` `[env]`; the web app's `API_UPSTREAM` on Vercel, also set by Terraform. Until Blockly has its domain, staging is made by `scripts/staging.ts` instead ([below](#staging-on-the-providers-own-addresses)) |

For staging and production, what the deployment decides is in
`infra/terraform/environments/<name>/config.auto.tfvars.json` (`settings`). Git ignores that file:
the repository holds `config.auto.tfvars.example.json` beside it, which is copied to that name and
filled in. `apps/control/src/config/environments.test.ts` loads it (or the example, in a fresh
checkout) the way a deployed machine does, with
each role's `fly.toml` values, so an inconsistent environment fails in CI instead of at its first
boot. What only the operator has (ids, emails, the CA's terms) arrives as `operator_settings`,
and every secret as `secrets`, when Terraform is applied.

## Staging, on the providers' own addresses

Staging stays. When nobody is testing, its machines are stopped, not destroyed: its database,
worlds, bucket and secrets are kept, and cost only their storage. `scripts/staging.ts` runs it,
and `scripts/staging-check.ts` checks it:

- `bun scripts/staging.ts up` makes whatever is missing in the `blockly-staging` Fly org and
  deploys this checkout: a Postgres machine, a Mailpit that only the org's private network
  reaches, the control (api and worker), realtime, edge and web apps, a Tigris bucket for
  archives, and the Polar sandbox webhook. The web app and the API answer on `fly.dev`; players
  join `<server>.<edge IPv4, dashed>.nip.io`. The passwords and keys it made stay in
  `local/staging/state.json`, or come from `STAGING_STATE` where there is no such file.
- `bun scripts/staging.ts start` starts the platform again before testing, its database first;
  servers start when someone plays. `bun scripts/staging.ts stop` stops every machine in the
  org afterwards, the servers' included, and says whether any still runs.
- `bun scripts/staging.ts status` shows what exists and where to reach it.
  `bun scripts/staging.ts env` writes what a cloud environment needs to run all of this to
  `local/staging/cloud.env`, to paste into its settings.
- `bun scripts/staging-check.ts` takes one Free server through its life on Fly (made, joined
  through the edge, asleep, woken, rested in the archive store with its machine and volume let
  go, woken from the archive, the same world, killed and started again) and times each wait.
- `bun scripts/staging.ts down` destroys staging, its worlds included: every app in
  the org, the ones the control plane made for servers included, the buckets, staging's org
  tokens and the webhook, then lists what's left. It is only for when staging itself is to go,
  and is never run as cleanup. Fly keeps a destroyed volume's
  snapshots until their retention ends; there is no call to delete them sooner.

This staging differs from the design the tables' Staging column describes, which Terraform makes:
Postgres is Supabase's staging project (Free, eu-central-1), not Managed Postgres, reached
through its session pooler, which carries `LISTEN` too, so there is no `DATABASE_DIRECT_URL`;
`STAGING_DATABASE_URL` names it, and `down` leaves it be; archives go to Tigris, not R2; the web app runs on Fly, not Vercel;
addresses are on `fly.dev` and `nip.io`, not staging's own domain; mail goes to the Mailpit; and
there is no OAuth sign-in, only email.

It needs flyctl signed in with a card on the org, and `POLAR_ACCESS_TOKEN` (sandbox, with
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

### Listeners

| Variable | Local | Staging and production | Set by |
|---|---|---|---|
| `API_LISTEN` | `127.0.0.1:4000` | `0.0.0.0:8080` | toml (control) |
| `INTERNAL_LISTEN` | `127.0.0.1:4001` | `fly-local-6pn:4001` (the organization's private network only) | toml (control) |
| `REALTIME_LISTEN` | `127.0.0.1:7443` | `fly-global-services:443` (UDP reaches only sockets bound there, on the port browsers dial: Fly never rewrites a UDP port) | toml (realtime) |
| `REALTIME_FALLBACK_LISTEN` | `127.0.0.1:7444` | `0.0.0.0:7444` (Fly terminates TLS in front) | toml (realtime) |

### Web origins and auth

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `WEB_CANONICAL_ORIGIN` | `http://localhost:3000` | `https://staging.cubepals.com` | `https://cubepals.com` | tf | Better Auth's base URL is this plus `/api/auth`; https everywhere but loopback |
| `WEB_TRUSTED_ORIGINS` | empty | `https://blockly-staging-*-<team>.vercel.app` | empty | tf | Previews of the staging Vercel project. A pattern must name the project and team: `*.vercel.app` is refused |
| `AUTH_SECRET` | generated | secret | secret | secret | Better Auth's signing key. Rotating it signs everyone out |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | optional | secret | secret | secret | Both or neither; neither offers email only. See OAuth below |
| `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` | optional | optional | optional | secret | Both or neither |
| `AUTH_OAUTH_PROXY_SECRET` | empty | secret | not set | secret | Previews' Google sign-in through the canonical callback (§14). Empty: previews use email only |
| `WEB_PROXY_SECRET` | empty | secret | secret | secret | The web tier sends each browser's address with it, and only then is that address believed. Sign-in's limits (three a person every ten seconds, counted on each api machine, in memory, so about double with two) count by address; empty, the control plane counts by what its host's proxy saw (`fly-client-ip` on Fly), which is the web tier's own address for every browser |
| `SIGNUP_ALLOWLIST` | — | set | — | `staging.ts` | Comma-separated emails and `@domain`s; when set, only they (and `ADMIN_EMAILS`) can make an account, by email or a provider. Staging sets it to its developers (`STAGING_DEVELOPERS`) and the staging check's private domain |
| `ADMIN_EMAILS` | optional | op | op | op | Comma-separated; an account with one of these, once its email is confirmed, is an admin, and stops being one when taken off the list |
| `SMTP_URL` | Mailpit | secret | secret | secret | Holds the mail provider's credentials |
| `MAIL_FROM` | `Cubepals <hello@blockly.localhost>` | `Cubepals Staging <hello@staging.cubepals.com>` | `Cubepals <hello@cubepals.com>` | tf | Every email is HTML with its plain text beside it; its pictures load from `WEB_CANONICAL_ORIGIN` under `/email/`. Staging's subjects also start with `[Staging] `, from `DEPLOYMENT_ID`, with no variable of their own |

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
| `OPERATOR_TOKEN` | — | — | — | secret | Bearer token of the operators' API on the internal listener (`scripts/runtimes.ts`, `scripts/fleet.ts`); `FLEET_OPERATOR_TOKEN` is read too. None turns the API off; required when the fleet runs |
| `DOCKER_SOCKET`, `DOCKER_GAME_NETWORK` | `/var/run/docker.sock`, `blockly-games` | — | — | — | Docker only |
| `FLY_ORG` | — | `blockly-staging` | `blockly-prod` | tf | One organization per environment |
| `FLY_API_TOKEN` | — | secret | secret | secret | An organization token (`fly tokens create org <org>`): the runtime creates and destroys game machines with it |
| `FLY_NATS_URL` | — | default `nats://[fdaa::3]:4223` | same | — | The organization's log stream, inside its network |
| `FLY_MACHINE_LIMIT` | — | computed (`fly_machine_limit`) | computed (`fly_machine_limit`) | computed | The organization's machine limit, as Fly support set it. The Fly runtime reports `(limit − platform machines) / 2` as the most servers it holds, since restores, exports and moves briefly run a second machine per server, and the control plane holds `maxServers` to that (§19.12; [money-guards.md](money-guards.md)). Raise it with Fly first, then the `fly_machine_limit` variable |
| `BOAT_API_TOKEN`, `BOAT_API_URL` | — | — | — | secret | Boat ([boat-runtime-plan.md](boat-runtime-plan.md)): the account's API key; the API's base (`https://boat.dev/api/v1`) |
| `BOAT_RUN_TTL_SECONDS`, `BOAT_START_RESERVE` | — | — | — | — | Auto-stop for a running sandbox (unset on a paid plan; ≤ 7200 on the trial); the share of the day's starts kept for wakes (`0.1`) |
| `FLY_PLATFORM_MACHINES` | — | computed (4) | computed (4) | computed | The machines the platform runs itself (api, worker, realtime, edge), set from the `fly-org` module |
| `RUNTIME_SECRETS_KEY` | generated | secret | secret | secret | Derives every server's RCON password and artifact token, and seals the realtime key. `version:key` (`2:<key>`); a bare key is version 1. Rotate it as [below](#rotating-the-runtime-key) |
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
| `POLAR_ACCESS_TOKEN` | optional | secret | optional (off at launch) | secret | An organization access token with `checkouts:write`, `customer_sessions:write`, `customers:read` and `subscriptions:read`. Absent: plans come from the account's plan column alone |
| `POLAR_WEBHOOK_SECRET` | optional | secret | optional (off at launch) | secret | `whsec_…`, from the webhook endpoint in Polar's dashboard (`<WEB_CANONICAL_ORIGIN>/api/billing/webhook`, API version 2026-04, events `customer.state_changed`, `order.paid` and `order.refunded`) |
| `POLAR_SERVER` | `sandbox` | `sandbox` | `production` | tf | Named explicitly |
| `POLAR_PRODUCTS` | optional | op | optional (off at launch) | op | `plus:<product id>`, every paid plan. Production takes it with the two secrets above or none of them ([production.md](production.md#billing-later)) |

### Product analytics (optional)

PostHog's EU cloud ([metrics.md](metrics.md#insight)). Production alone sends anything; staging
and local stay off unless someone sets the token by hand to try it, and then every event says
which environment it came from, which the project's charts leave out.

| Variable | Local | Staging | Production | Set by | Notes |
|---|---|---|---|---|---|
| `POSTHOG_TOKEN` | empty | empty | the project's `phc_…` token | tf | The project's public token (the kind every page ships). Empty: nothing is sent, no question is asked, and Feedback is hidden. The `environment` on each event comes from `DEPLOYMENT_ID` (`prod` is `production`, `staging` is `staging`, anything else `development`) |
| `POSTHOG_HOST` | — | — | default `https://eu.i.posthog.com` | — | Where events go |

## Edge

| Variable | Local (compose) | Staging and production | Set by |
|---|---|---|---|
| `CONTROL_URL` | `http://host.docker.internal:4001` | `http://api.process.bly-<id>-control.internal:4001` | Terraform (edge) |
| `EDGE_TOKEN` | from `.env` | the control plane's `EDGE_TOKEN` | Terraform (edge) |
| `IDLE_HINT_AFTER` | `10m` (compose knob) | `10m` | toml |
| `MINECRAFT_PORT` | `25565` | `25565` | toml |
| `EDGE_ID` | `local-edge` | the machine's hostname | — |
| `ROUTES_FILE` | `/tmp/routes.json` | same | — |
| `ROUTES_POLL_MS` | `1000` | same | — |
| `AGENT_PORT` | `8090` (mc-router's webhooks) | same | — |
| `NOTICE_PORT`, `SLEEPING_PORT` | `25564`, `25563` (the restarting and sleeping notices) | same | — |
| `RESTARTING_MOTD`, `RESTARTING_JOIN` | `Restarting · back in a moment`, `Restarting · join again in a moment` | same | — |
| `ASLEEP_MOTD`, `LOADING_MOTD` | `Sleeping · join to wake it up`, `Starting up · try again in a moment` | same | — |
| `ROUTER_BIN` | `/mc-router` | same | — |
| `CONNECTION_RATE_LIMIT` | `10` (mc-router's `-connection-rate-limit`) | same | — |

## Web

| Variable | Local | Staging and production | Set by |
|---|---|---|---|
| `API_UPSTREAM` | default `http://127.0.0.1:4000` | the control app's origin (`https://bly-<id>-control.fly.dev`); server-side only, never in the bundle | Terraform (Vercel project) |
| `NEXT_OUTPUT` | — | — | `standalone` in `apps/web/Dockerfile` for self-hosting, where `API_UPSTREAM` is a build argument because Next writes the rewrite at build time |
| `WEB_PROXY_SECRET` | empty | the control plane's value: sent with each browser's address on every `/api/auth` call and session check (`src/proxy.ts`, `src/lib/client-address.ts`) | Terraform (Vercel project, write-only) |
| `DEPLOYMENT_ID` | empty (`development`) | the control plane's value | Terraform (Vercel project). Read at build time: each PostHog event says `production`, `staging` or `development` by it |
| `NEXT_PUBLIC_POSTHOG_TOKEN` | empty; `apps/web/.env.local` to try PostHog | production only: the same token as `POSTHOG_TOKEN` | Terraform (Vercel project), from production's `POSTHOG_TOKEN`. Read at build time; empty sends nothing and hides Feedback |
| `NEXT_PUBLIC_POSTHOG_HOST` | — | default `https://eu.i.posthog.com` | — |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | — | production, once an operator adds them: a personal API key with error tracking write, and the project's id. With both, the build uploads its source maps to PostHog and deletes them (`apps/web/scripts/sourcemaps.ts`); without, it skips that | `production.env`, then Terraform to the Vercel project (secret, production builds only) |
| `WEB_CLIENT_ADDRESS_HEADER` | empty | the header the host's edge sets and overwrites: `x-real-ip` on Vercel, `fly-client-ip` on Fly (staging's web app). Empty, no address is sent | Terraform (Vercel project); `scripts/staging.ts` |

Staging's Vercel project (`blockly-staging`) builds `main` and every preview, all rewriting to
staging's control plane. Production's (`blockly`) builds only its `production` branch.

## Secrets

Generate the random ones with `openssl rand -base64 48` (at least 16 characters each; the
schema refuses shorter). Each has a `secret_versions` marker, a non-secret string that changes
when the value does (a date works), so Terraform re-sends it: Fly returns only a digest.

| Secret | Kind | Rotating it |
|---|---|---|
| `AUTH_SECRET` | random | Signs everyone out |
| `REALTIME_TICKET_SECRET` | random | Fails only connections being opened |
| `EDGE_TOKEN` | random, shared by the control and edge apps | Set both in one apply |
| `RUNTIME_SECRETS_KEY` | random, `version:key` | A version bump, with the old key kept as `RUNTIME_SECRETS_PREVIOUS_KEYS` until nothing runs on it ([below](#rotating-the-runtime-key)) |
| `AUTH_OAUTH_PROXY_SECRET` | random (staging) | A sign-in in flight fails |
| `WEB_PROXY_SECRET` | random, shared by the control plane and the web app | Set both in one apply, then deploy the control app and redeploy Vercel's production deployment together: Vercel gives a changed value only to new deployments. Until both run on it, sign-in counts the web tier's address for everyone |
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

Terraform owns the apps, their addresses and secrets, DNS, the archive bucket and the Vercel
project; `fly deploy` owns machines and releases. Fly's Terraform provider (`ampbase-io/fly`)
has no Managed Postgres resource, so the database is made once with `fly mpg create`; its pooled
URL (`pgbouncer.<cluster>.flympg.net`) becomes the `DATABASE_URL` secret and its direct one
(`direct.<cluster>.flympg.net`) `DATABASE_DIRECT_URL`.

1. Tokens in the environment: `FLY_API_TOKEN` (an org token for the environment's org),
   `CLOUDFLARE_API_TOKEN` (DNS edit on the zone, R2 edit on the account), `VERCEL_API_TOKEN`.
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
   given in part, and an org machine limit below two machines per server plus the platform's
   own (§19.12).
5. Deploy, from the repository root:
   `fly deploy . --config infra/fly/control.toml --dockerfile apps/control/Dockerfile --app bly-<id>-control`
   (migrations run first), then `realtime.toml` (and `fly scale count 1`), then `edge.toml`.
6. Vercel builds the web app from the repository on its own.
