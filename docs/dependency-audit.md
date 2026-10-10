# Dependency audit

Blockly prefers proven implementations to its own protocol and API code: an official SDK, a
client generated from a published spec, or a maintained library. Nothing is adopted on reputation.
Each candidate first runs in a throwaway proof of concept against the real system, covering the
exact behaviour Blockly depends on, including the cases that have broken before. A library or
generated client always sits behind an existing port (`ServerConsole → RconConsole → …`,
`MinecraftRuntime → FlyRuntime → …`), so replacing it never touches `app/` or `domain/`.

Where custom code stays, this file records why, and the code points here. blocklyd's own pieces,
weighed one by one against crates, are in [blocklyd-audit.md](blocklyd-audit.md).

## How the Minecraft checks were run (2026-09-19)

A disposable container built from Blockly's own RuntimeSpec for a real server: image
`itzg/minecraft-server:2026.9.1-java25`, Minecraft 26.3 vanilla, the same RCON and memory settings,
but outside Blockly's control so idle stops and presence polling could not interfere. Each client
ran the same checks directly and through a TCP proxy that misbehaves on purpose:

| Proxy mode | What it does |
|---|---|
| plain | Forwards bytes as they come |
| fragment | Splits every server reply into 1–7 byte writes, 1 ms apart |
| coalesce | Holds server replies and releases them together every 40 ms |
| client-coalesce | Holds the client's writes and releases them together, which exposes pipelining |
| blackhole | Lets the auth reply through, then swallows every answer (server went quiet) |
| cut | Drops the connection the moment a command arrives (server died mid-command) |

## RCON: keep the custom client

**Checks:** auth, wrong password, an 11-command access sequence on one connection (`list`,
whitelist add/list/remove, op/deop, ban/pardon, whitelist on/off, `list uuids`), a 12,187-character
answer spanning several packets (450 scoreboard names, each checked), UTF-8, fragmented and coalesced
streams, a quiet server, a dead server, and ten sessions at once.

| Client | Maintained | Result against 26.3 |
|---|---|---|
| Blockly `RconConsole` | ours | Passes every check |
| `rcon-client` 4.2.5 | README says unmaintained; last release 2024-09 | Truncates answers at 4,096 characters (150 of 450 names) |
| `dathost-rcon-client` 1.0.9 | Released 2026-01 | Crashes on fragmented packets; corrupts long answers; notices a dead server only by timeout |
| `rcon-srcds` 2.1.1 | Released 2026-04 | Crashes on fragmented packets; corrupts coalesced long answers; hangs forever on a quiet or dead server |
| `rcon-node` 1.3.0 | Released 2025-06 | Truncates at 4,096 characters; hangs on a quiet or dead server |
| `@minecraft-skills/rcon` 0.1.9 | Released 2026-09 | Cannot run one command: it pipelines its end marker, and vanilla closes the connection |

No library passed, so `infra/mc-protocol/rcon.ts` stays. The reasons are in its header.

**Two server behaviours the checks uncovered, now handled:**

- **One answer buffer for all RCON connections.** Twenty commands on twenty connections at once:
  87 of 200 answers were correct, 98 were another command's answer and 15 were empty. The server
  runs every command correctly; only the answer capture is shared. No client can fix that, so every
  RCON session now holds its server's lock (`Locks` port, Postgres advisory locks in
  `infra/pg/locks.ts`) across all control-plane processes. Result: 200 of 200 correct.
- **A 1,460-byte packet limit.** Vanilla reads each packet in one read of at most 1,460 bytes and
  drops the connection for anything longer, so a command body can be at most 1,446 bytes. The
  client refuses longer commands before sending them. People's console commands are already capped
  at 256 characters.
- **A server that accepts connections and never answers.** A frozen server's kernel still accepts
  TCP connections, and the client waited for the password's answer with no deadline, holding the
  server's lock. The password now has the same deadline as connecting, and a silent server gives up
  after 5 seconds.

## Readiness: keep the status ping, don't use Docker health

The question was whether Docker's health status, which the itzg image computes with `mc-health`,
could replace Blockly's status ping (`infra/mc-protocol/slp.ts`) for deciding that a server is ready
for routing and players. Every signal was logged each time it changed, through each event:

| Event | Status ping | RCON | Docker health |
|---|---|---|---|
| Cold boot, new world | answers at 23.9 s ("Done" at 23.7 s) | 23.8 s | "healthy" at 25.5 s; Docker 29 checks every 5 s during the start period |
| Restart | fails at 0.8 s, answers at 6.5 s | same | still "healthy" at 0.8 s while the server is down; "starting" at 1.3 s; "healthy" at 7.7 s |
| Crash (`kill -9` on Java) | fails at 0.3 s | same | the container exits at 0.4 s, which Blockly already treats as a crash |
| Frozen (`SIGSTOP` on Java) | fails at 2 s | fails at 5.5 s | "unhealthy" only at 43.5 s, even with a 10 s interval |
| Thawed after a minute | answers briefly | same | vanilla's watchdog kills the server within a second |

Docker health cannot replace the ping:

- **It is not portable.** Fly Machines run only `tcp` or `http` checks (`fly.MachineCheck` in the
  Machines OpenAPI spec). A TCP check passes when the port opens ("Starting Minecraft server" at
  22.2 s), before the world has loaded.
- **It goes stale.** It reported "healthy" while the server was stopping and while it was frozen.
- **It adds nothing.** `mc-health` is itself a status ping, run inside the container.

Crashes are caught by the container exiting, and a server frozen longer than vanilla's tick limit
(60 s) is killed by its own watchdog, which turns a hang into a crash.

**Status ping libraries** (same server, same proxy, plus the real edge with an unknown hostname):

| Client | Maintained | Result |
|---|---|---|
| Blockly `SlpProbe` | ours | Passes every check; a closed connection fails in 0–9 ms |
| `minecraft-protocol` 1.68.0 | Released 2026-08; 72 packages, 450 MB | Timed out on every fragmented or coalesced reply |
| `minecraftstatuspinger` 1.2.2 | Released 2025-03; one maintainer; GPL-3.0-or-later | Passes, but notices a closed connection only at its 5 s deadline |
| `minecraft-server-util` 5.4.4 | No release since 2023 | Not tested: unmaintained |

No library is clearly better than 90 tested lines of a protocol that has not changed since 2013,
so `SlpProbe` stays. Its tests now cover these cases.

## Docker log frames: replaced with dockerode's demuxer

`DockerLogSource.recent` decoded Docker's multiplexed log format (8-byte frame headers) by hand,
while `tail` next to it already used dockerode's `modem.demuxStream` (docker-modem 5.0.7), which
also checks each frame's stream type and falls back to raw output for TTY containers.

**Check:** a container that writes 2,000 stdout lines with non-ASCII text, 2,000 stderr lines in
between, and one 70,000-character line, read back through Docker's real API.

| Decoder | Result |
|---|---|
| Hand-written | 4,001 of 4,001 lines, stdout and stderr each in order |
| dockerode `demuxStream` | Identical |

Both paths now go through dockerode's demuxer, decoding bytes with Node's `StringDecoder` so a
character split across chunks survives. The rewritten adapter was run against real containers:
`recent` returned all 4,001 lines in order, and `tail` followed a running container line by line
and stopped when asked.

One Docker behaviour applies to either decoder: a line longer than 16 KB is stored as 16 KB pieces,
each with its own timestamp, so with timestamps on it reads back with timestamps inside it, and
`tail: n` counts pieces, not lines. Minecraft does not write lines that long.

**Following through restarts.** Docker ends a follow when the container stops, so a console left
open lost everything a restart printed until the server was running again. The tail now waits
for the container's next `StartedAt` and follows again from that moment: `since` takes fractional
seconds, and a real container restarted under it returned exactly the new run's lines. The tail
ends when the container is removed. `infra/docker/docker-logs.test.ts` runs this against real
containers wherever a Docker socket exists (CI included); the old tail fails it.

## Realtime crypto: tickets on `jose`, certificates on `selfsigned`

**Tickets.** Realtime tickets were a hand-rolled `payload.signature` token with HMAC-SHA256. They
are now HS256 JWTs from `jose` 6.2.12 (MIT, zero dependencies, released 2026-09, already installed
through Better Auth): subject = the user, audience = the deployment, one minute to live. Libraries
stay out of `app/`, so tickets are now a port (`app/ports/tickets.ts`) with a `jose` adapter
(`infra/realtime/jose-tickets.ts`). Tests cover expiry, another deployment's ticket, another secret,
a swapped subject, an unsigned `alg: none` token and the old format. On the running stack, a real
ticket from the signed-in web app opened both a WebTransport and a WebSocket session; with three
characters changed, both were refused (close codes 1007 and 4007, reason `ticket`).

**Certificates.** The pinned WebTransport certificate was minted by shelling out to `openssl`,
which Transport.io's own CLI also does ("Node cannot issue an X.509 certificate"), so there was no
official helper to adopt. Tried:

| Library | Result |
|---|---|
| `@peculiar/x509` 2.1.0 (MIT, released 2026-09) | Needs every caller to load the `reflect-metadata` polyfill first |
| `selfsigned` 5.5.0 (MIT, released 2026-01; `@peculiar/x509` 1.14.3 underneath) | ECDSA P-256, SAN, 13-day validity, matching key; Transport.io served HTTP/3 with it; Chrome opened a WebTransport session pinned to its hash and refused a wrong hash |

`selfsigned` replaced `openssl`: the control-plane image needs no openssl binary, and nothing is
written to a temporary directory. Its dependency loads `reflect-metadata`, a global `Reflect`
polyfill, into the control plane. On the running stack, the control plane minted and published a
`selfsigned` certificate, and the browser's pinned session to it opened.

## Fly Machines API: generated from Fly's OpenAPI spec

No hand-written Fly request or response types. The contract comes from Fly's own spec:

```
docs.machines.dev/openapi.json (vendored, pinned)
  → openapi-typescript 7.13.0 → infra/fly/generated/machines.ts (types only)
    → openapi-fetch 0.17.0 → infra/fly/client.ts
      → FlyRuntime (orchestration, hand-written) → MinecraftRuntime
```

- **Pinned spec.** `apps/control/src/infra/fly/machines.openapi.json`: OpenAPI 3.0.1, 70 paths,
  182 schemas, stored with sorted keys so an update reads as a diff. Only
  `bun run openapi:update fly` changes it (it fetches Fly's current spec and regenerates).
- **Reproducible generation.** `bun run openapi:generate`. The generator lives in `tools/openapi`
  with its own lockfile, because `openapi-typescript` needs TypeScript 5's compiler API and the
  repository is on TypeScript 7, whose native compiler has no JavaScript API. It serves every API
  with a published spec: Fly and Modrinth so far.
- **Drift check in CI.** `bun run openapi:check` fails when committed types differ from what their
  pinned spec produces, or when a spec is not in canonical form (`.github/workflows/ci.yml`).
- **One spec defect, fixed at generation.** PUT and PATCH on a machine's metadata share an
  `operationId`, which the generator refuses. Repeated ids get their method appended; paths and
  schemas stay exactly as Fly publishes them.
- **Boundary.** Generated types are importable only inside their own adapter, and `openapi-fetch`
  only inside an adapter that owns a generated contract (`bun run check:boundaries`), so nothing
  Fly-shaped reaches `app/` or `domain/`.

**Checked against the real API** with read-only calls using the local flyctl login: listing the
`blockly` org's apps returned 200 and 0 apps; regions returned 200 and 18 regions whose fields match
the generated schema; the org's machines returned 200 and none; a missing app returned 404 with the
typed error body. Thirteen operations declare no success body (deletes, start, cordon, snapshot
create), so the adapter reads only their status.

### FlyRuntime on the generated client

`infra/fly/fly-runtime.ts` implements the whole `MinecraftRuntime` port as §8 designs it: one app
per server on its own network, a Flycast address, app secrets, one volume, leases on every machine
change, restore and relocate by replacement, and exports through a one-shot helper machine.

What the live API and the real helper image showed, beyond the spec:

- **`/v1/platform/regions` answers `Regions`; the spec says `regions`.** A client trusting the
  generated type would read an empty list and refuse every region at boot. The adapter validates
  this body with zod and accepts either spelling. `checkRegions` then accepted `fra` and `iad` and
  refused an unknown code against the real API.
- **The lease nonce header is undeclared** on machine update, stop and restart; only lease
  extension lists it. The adapter sends `fly-machine-lease-nonce` explicitly.
- **The lease response shape is unsettled.** The spec says a flat `Lease`; flyctl reads
  `{ status, data: Lease }`. The adapter accepts both. Settling it needs a live machine.
- **Machine events are untyped** in the spec. The adapter reads only the exit code, OOM flag and
  requested-stop flag, through zod.
- **Export and restore jobs**, run for real in `curlimages/curl:8.22.0` against a local server
  standing in for a presigned URL: the export uploaded with a Content-Length (presigned S3 and R2
  uploads need one), passed a header containing an apostrophe intact, and reported the uploaded
  bytes' exact SHA-256 and size; restoring that archive into an empty volume gave byte-identical
  files with their `1000:1000` owners; an upload answered with 403 reported `failed 22`.

Orchestration is tested against an in-memory Machines API with leases, hydrating volumes and
429s (`infra/fly/fly-runtime.test.ts`). The first live provision is the one step still to
verify. Every app, volume and machine a provision creates bills while it exists, so the first live
provision waits on a deliberate decision to spend; every Fly call made so far has been read-only.


### Fly logs: NATS for live lines, the HTTP log API for history

Fly publishes no spec or SDK for logs, so the references are flyctl and fly-go, which Fly
maintains: `logs/nats.go` and `logs/entry.go` (the live message), fly-go `resource_logs.go`
(history) and `tokens/tokens.go` (credentials). `infra/fly/fly-logs.ts` reads both the way they do.

- **Live lines: `@nats-io/transport-node` 3.4.0**, the official NATS client (the `nats` package is
  deprecated in its favour). Subject `logs.<app>.<region>.<machine>`, user = org slug, password =
  the token without its scheme, at `[fdaa::3]:4223` inside the org's network (`FLY_NATS_URL`
  elsewhere). Proof of concept against nats-server 2.15.0, on Bun 1.3.11 and Node 22.23.2, 7 of 7:
  an IPv6 literal URL, user and password, a wildcard region, the `app` filter, bad JSON skipped
  without ending the stream, a server restart survived (reconnected and resubscribed in about
  0.9 s with no code of ours), abort ends the iterator, a wrong password fails with
  `AuthorizationError`, and nothing listening fails at once. The same checks now run in CI against
  a NATS container (`infra/fly/fly-logs.test.ts`).
- **History: the HTTP log API, hand-written.** One GET with a zod-checked body is all it takes,
  and there is no spec to generate from. Read-only calls against an existing personal app showed
  (counts and times only):
  - A header mixing macaroons and user tokens, which is what `fly auth token` prints, gets 401;
    `FlyV1 <macaroons>` gets 200. That is fly-go's rule, now in `infra/fly/token.ts`; the Machines
    client sends the same header, and the regions and inventory calls were re-checked live with it.
  - A missing app answers 401, not 404.
  - Entries come oldest first. `next_token` is the last entry's time in nanoseconds, and a
    request returns the entries after it. With no token the window starts about a day back.
    `instance=` and `region=` filter.
  - The page size never showed (73 entries came back in one page), so the adapter pages until an
    empty page or a repeated cursor, at most 20 pages per window. Windows of 10 minutes, 2 hours and
    a day are tried in turn until one holds the lines asked for. Run live through the adapter,
    that returned 2 and then 4 lines for one machine, widening to the day for the second.
  - Providers seen: `app` (the machine's output, including Fly init's own coloured lines) and
    `proxy`; flyctl also renders `runner`.
- **What the console gets.** Only `app` lines, for the server's own machine: the tail subscribes to
  `logs.<app>.*.<machine>` and history asks for `instance=<machine>`, so the helper machines that
  run exports and restores never show. The console classifier drops terminal colour codes.
- **A subscription never ends with its machine**, unlike a Docker log stream, and restore and
  relocate replace the machine. The realtime role now ends a tail when its server leaves
  `starting`, `running` and `stopping` (docs/architecture.md, logs and console).
- **Still to verify on Fly:** the live stream from inside the `blockly` org, with an org token
  from `fly tokens create org`, and that apps on their own private networks publish to the org's
  stream. That needs a running machine in the org, so it follows the first provision.

## Modrinth: generated from Modrinth's OpenAPI spec

Modrinth publishes its API (Labrinth 2.7.0) as OpenAPI 3.0 at `docs.modrinth.com/openapi.yaml`,
maintained in `modrinth/code` and last changed on 2026-09-09. It goes through the same pipeline as
Fly's:

```
docs.modrinth.com/openapi.yaml (vendored as canonical JSON, pinned)
  → openapi-typescript 7.13.0 → infra/modrinth/generated/labrinth.ts (types only)
    → openapi-fetch 0.17.0 → infra/modrinth/client.ts
      → ModrinthCatalog (mapping, hand-written) → ModCatalog
```

The spec generated without changes. `bun run openapi:update modrinth` refreshes it.

**Proof of concept against the live API**, read-only, 12 of 12:
- Tags: game versions (newest release `26.3`) and loaders.
- Search with facets: fabric mods for 26.3 that run on a server.
- A project by slug; a missing one is a 404.
- Bulk projects and bulk versions: an unknown id is simply left out. That is what `absent` is
  built on (§15.3).
- Versions filtered by loader and game version.
- A primary file with a 128-character sha512, a size, and a `cdn.modrinth.com` URL.
- A version by its file's sha512.
- 100 recently updated projects and 300 of their versions: every status, side and dependency
  type inside the spec's enums, and every version with a primary file carrying a sha512.
- Rate limit headers: 300 a minute, reported per window.
- 100 ids in a query string take about 1,100 characters, so bulk lookups go in chunks of 100.

What the live API showed beyond the spec:
- **`client_side`/`server_side` are deprecated** for a per-version `environment` (nine values,
  such as `server_only`, `client_and_server`, `client_or_server_prefers_both`). Live data fills it:
  27 of 598 sampled versions said `unknown`, and the old sides disagreed with it on 11. The port
  carries each version's `environment`; what it means for a server is decided in `minecraft/`.
- **Plugins and datapacks report `project_type: mod`** in project responses, but search filters
  them as `plugin` and `datapack`. A Paper server's search asks for `plugin`.
- **Dependencies may name a project, a version, or both** (Chunky needs Fabric API by project,
  with no version).
- **A missing project or version answers 404 with an empty body.**

`ModrinthCatalog` maps anything the public API returns that isn't publicly visible (rejected,
draft, private, processing, scheduled) to `absent`, and unknown environments to `unknown`. It
retries 429s after the window resets, and 502–504s and dropped connections after a short pause,
three tries in all; then the catalog is `CatalogUnavailable`. A 400 is a bug of ours, not an
outage. Tested against an in-memory Modrinth whose responses are typed by the generated schemas
(`infra/modrinth/modrinth-catalog.test.ts`), and run live through the real class: mod and plugin
search, project, versions with a dependency, version, and states with `absent` for unknown ids.

## blocklyd's wire: generated from its own Rust types

The control plane's types for blocklyd were a hand-kept copy of the node's Rust types, and had
drifted (an exit code the node may send as null was typed as a number). They now come through the
same pipeline, from specs blocklyd writes itself:

```
cubepals/blocklyd: src/protocol/schema.rs (a test; schemars 1.2.2, a dev-dependency only)
  → openapi/node-reads.openapi.json, node-writes.openapi.json, carried by each release
  → bun scripts/blocklyd.ts bump <version>: infra/fleet/node-reads.openapi.json, node-writes.openapi.json
    → openapi-typescript 7.13.0 → infra/fleet/generated/ (types only)
      → infra/fleet/wire.ts (names, and narrowings of what the control plane sends)
```

- **Two specs**, because serde reads a defaulted field as optional and always writes it: what the
  node reads is generated with `defaultNonNullable: false`, like boat's requests.
- **Drift fails three times.** blocklyd's `cargo test` fails when its committed specs aren't what
  the Rust types say (`BLOCKLYD_WRITE_SCHEMA=1` rewrites them), `bun scripts/blocklyd.ts check`
  when the copies here aren't the pinned release's, and `bun run openapi:check` when the generated
  types aren't what the specs say. `openapi:update` doesn't fetch them: a pin moves them.
- **Nothing reaches the binary**: the schemas derive only under `cfg(test)`.

ts-rs (one TypeScript type per Rust type, no serialize/deserialize distinction, `u64` as `bigint`)
and utoipa (an annotation on every handler) were the alternatives; neither fits a pipeline the
repository already has.

## Object storage: the official AWS SDK, R2 in production, RustFS locally

`S3ArchiveStore` (`infra/s3/`) is the `ArchiveStore` for any S3-compatible store, on
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1136.0, the SDK Cloudflare documents
for R2. Download names go through `content-disposition` 3.0.0 (jshttp, the Express organisation),
which writes RFC 6266 headers with an ASCII fallback. Nothing S3-shaped is written by hand.

**The local store.** The architecture named MinIO, but `minio/minio` is archived (last release
2025-10-15), and so is LocalStack. Maintained alternatives, checked 2026-09-19: RustFS 1.0.0
(2026-09-16, Apache-2.0), SeaweedFS 4.47 (2026-09-14, Apache-2.0), Garage (AGPL), the Versity
gateway and S3Mock. RustFS runs in `docker-compose.yml` and in CI: one container, MinIO-style
credentials, and plain `curl --aws-sigv4` creates the bucket. SeaweedFS served as a second,
independent implementation in the proof of concept, which is how the checksum problem below
surfaced.

**Proof of concept**, on RustFS and SeaweedFS, under Bun 1.3.11 and Node 22.23.2, all passing:
- A presigned PUT from the host, and from inside a container (the helper image the Fly export
  job uses), signed for `host.docker.internal`; the stored bytes matched.
- A presigned GET with a download name containing an apostrophe; the store returned the
  `Content-Disposition` it was asked for.
- An expired link is refused with 403.
- Head, head of a missing key (`NotFound`, 404), delete, and delete of a missing key.
- A streamed `PutObject` of known length.

What it showed:
- **The SDK's default checksums break presigned uploads on some stores.** Since 2025 the SDK
  adds a checksum to every request it can, and a presigned PUT then carries a checksum of an
  empty body in its query. RustFS accepted such a link and SeaweedFS refused it with 400, so
  which stores tolerate it is not something to rely on, R2 included. With
  `requestChecksumCalculation: WHEN_REQUIRED`, no checksum rides in a link and both stores take
  the upload. Integrity comes from the sha512 checks instead.
- **Containers and the host call the local store by different names**, and `host.docker.internal`
  doesn't resolve on a Mac host. A presigned link is signed for one host, so the port takes an
  audience (`runtime` or `browser`), and `ARCHIVE_S3_RUNTIME_ENDPOINT` names the store as runtimes
  reach it. In production R2 has one name and the setting stays empty.

**Ingest** downloads to a temporary file while hashing, and stores the bytes under
`artifacts/<sha512>` only if they match; different bytes are an `ArtifactMismatch` and never reach
the store. A second ingest of stored bytes doesn't fetch again. Ingests stop at 512 MiB.

**Tests** (`infra/s3/s3-archive-store.test.ts`) run against a real store wherever
`S3_TEST_ENDPOINT` is set, as CI sets it: 6 of 6 on RustFS and on SeaweedFS, and against the
local compose bucket, which they leave empty. The adapter also ran under Node, ingesting and
serving back 3 MB.

**Still to verify on R2:** everything above needs only an R2 API token with object read and
write on a staging bucket. The same tests then run against it:
`S3_TEST_ENDPOINT=https://<account>.r2.cloudflarestorage.com S3_TEST_BUCKET=<bucket>
S3_TEST_ACCESS_KEY_ID=… S3_TEST_SECRET_ACCESS_KEY=… bun test src/infra/s3`. Browser uploads
will also need a CORS rule on the bucket, which belongs with custom uploads.

## Billing: Polar's new official SDK, pinned to API 2026-10

`PolarBilling` (`infra/polar/`) is the `BillingProvider`, on `@polar-sh/sdk` 1.0.0-alpha.22.

**Which SDK.** The `@polar-sh/sdk` most projects use (0.49.0, the npm `latest` tag, generated by
Speakeasy) was deprecated and its repository archived in September 2026. Polar's TypeScript SDK
now lives in the main `polarsource/polar` repository under the same package name, published on
the `next` tag. It is a pre-release, pinned here to an exact version. What keeps that safe is
that the wire contract is not the package's: Polar versions its API by date, and the SDK exposes
each version as its own module. Blockly imports `@polar-sh/sdk/2026-10`, which sends
`Polar-Version: 2026-10` on every request and types webhook payloads for that version. The SDK
has no dependencies. Generating a client from Polar's OpenAPI spec was the alternative. It would
have meant re-implementing webhook verification, including Polar's two key formats, which the
SDK already handles.

**API version.** Polar releases a version each quarter. Each version spends three months as Next
(which can still break), three as Current (frozen) and three as Deprecated, then is removed.
`2026-10` became Current on 2026-10-01, and `2026-04`, Deprecated since, is removed at the
January 2027 release. Blockly moved to `2026-10` on 2026-10-10: in SDK 1.0.2 the two versions'
types differ only in license keys' `member` fields and `api_version`, none of which Blockly
reads. Moving means changing the import path, with the compiler showing every changed field, and
moving the webhook endpoints' `api_version` with it (`scripts/staging.ts up` does staging's).

**Proof of concept**, offline because it needs no account, on Bun 1.3.11 and Node 22.23.2, 15 of 15:
- Webhooks were signed with the `standardwebhooks` library, independently of Polar's code.
  `validateEvent` accepted a Standard Webhooks signature and Polar's original keying (the UTF-8
  bytes of the whole `whsec_` secret).
- It refused a tampered body, a delivery ten minutes old, and another secret's signature.
- An event type the API version doesn't know raises its own error.
- Against a local stand-in for `api.polar.sh`, the SDK sent `POST /v1/checkouts/`,
  `POST /v1/customer-sessions/` and `GET /v1/customers/external/{id}/state`, each with the
  token and `Polar-Version: 2026-04`.
- Errors are typed: 404 `ResourceNotFound`, 429 `PolarRateLimitError` with `retryAfter`, 5xx
  `PolarServerError`, and `PolarNetworkError` when nothing listens.

What it showed: **`validateEvent` checks the signature and the event type, not the payload.** A
malformed customer state came back as if typed. The adapter checks the fields it reads with zod,
and an authentic but malformed delivery is an error, so Polar retries it; it is never read as
"no plan".

**Design.** Customers are created at checkout with our user id as their external id, so Polar
ids never need mapping back to users. Standing comes from `customer.state_changed`, which
carries the customer's whole state, so deliveries can arrive in any order. `stateOf(userId)`
reads the same state on demand. A plan is a product, named in `POLAR_PRODUCTS`, and the config
check refuses a product for a plan that doesn't exist or a paid plan nothing sells. The server
(`sandbox` or `production`) is never defaulted. Outages, rate limits and network failures are
`BillingUnavailable`; a forged, altered or replayed webhook is `WebhookRejected`. Tested against
the local stand-in with webhooks signed in the test (`infra/polar/polar-billing.test.ts`, 9 of 9).

**Still to verify on Polar:** the sandbox run needs a sandbox organization access token, one
product for the `plus` plan, and a webhook endpoint on API version 2026-10 that sends
`customer.state_changed`, with its secret. With those in `POLAR_*`, the checkout, portal and
standing calls run against sandbox. A subscription made there proves the webhook end to end.

## Jars at boot: what the image does with `MODS` links

No library to adopt here: the itzg image fetches the links itself, with mc-image-helper. What
Blockly's artifact endpoint (§15.2) and install check depend on was observed on 2026-09-19 with
`itzg/minecraft-server:2026.9.1-java25` (mc-image-helper 1.68.0, `cmd=mcopy`), Fabric on 26.3,
Fabric API 0.161.0+26.3 behind a logging stand-in for the endpoint that redirected to Modrinth's
CDN, then again through the real control plane:

| Case | What the image did |
|---|---|
| First boot | `HEAD`, then `GET`; followed the 302 to `cdn.modrinth.com` |
| File name | The link's last path segment, URL-decoded (`%2B` → `+`), query dropped |
| Next boot | `HEAD` only: "already up to date", because the file's mtime was newer than `Last-Modified` |
| Jar truncated to 1000 bytes | Still "already up to date" (no size check); Fabric then failed with `ZipException: zip END header not found` and the process exited 1 |
| `Last-Modified` newer than the file | Downloaded it again, whole; the server booted; the boot after that was a HEAD only again |
| `HEAD` answered 404 | `mcopy` failed and the container exited 1 before starting Minecraft |

What follows for Blockly:
- The endpoint answers `HEAD` from the database with a fixed `Last-Modified`, so installed jars
  never depend on the CDN or the store at boot.
- The install check must hash what is installed: the image would keep a broken file forever.
- Recovery doesn't delete files. The endpoint reports a newer `Last-Modified` for a server whose
  jars were found wrong (`server_runtimes.artifacts_refreshed_at`, rounded up to the next second
  so it is newer than any file already on disk), and the image replaces them itself. That
  covers the truncated jar that crashes a loader before the check could run, on any provider.
- The image ships GNU `sha512sum` (Ubuntu 24.04 base) in both Java variants Blockly runs; it
  escapes names holding a backslash or newline and prefixes their line with `\`.

## Archives on Docker: a pinned helper image, no archiver library

Local archives run through the same `exportSnapshot` and `restore({kind: 'archive'})` as Fly
(§8, §16), in a one-shot container over the snapshot or server volume. The helper is
`curlimages/curl:8.22.0`, already pinned for the compose bucket init: busybox `tar`, `gzip`,
`sha256sum` and `stat`, and curl for the presigned PUT and GET. Nothing in the control plane
packs or unpacks a world, so there is no tar library to adopt for this.

Observed on 2026-09-19 (`docker-runtime.test.ts`, Docker Desktop and RustFS 1.0.0; the same
test runs in CI against RustFS on the runner):

| Case | Result |
|---|---|
| Export of a snapshot volume | `tar -czf` of the volume, its sha256 and size printed, PUT with the presigned link through `host.docker.internal`; the store's `HEAD` size matched |
| Archive restore | The tarball came back with the files' owners (uid 1000), and nothing the archive didn't hold |
| Archive missing (404) or not a tarball | The helper exits non-zero before the volume is touched: the archive is downloaded and listed with `tar -tzf` first |
| A real server's archive (Fabric 26.3, 199 MB volume) | 196,989,336 bytes: `server.properties`, `world/level.dat`, the mod jars; restored and booted |

## Uploads: jars and world downloads

What people upload is read in the control plane, so each format goes through a maintained
library behind the `FileFormats` port (`infra/formats/`); `minecraft/uploads.ts` says what the
decoded data means. Nothing here is custom parsing. Checked on 2026-09-19 against real files:
seven jars from Modrinth's CDN (Fabric API and Lithium for Fabric, Sodium for NeoForge, JEI for
Forge 1.20.1, Quilted Fabric API, Chunky and LuckPerms for Bukkit/Paper) and a 197 MB Blockly
download of a Fabric 26.3 server.

| Need | Library | Observed |
|---|---|---|
| A jar's metadata files | `fflate` 0.8.3 (no dependencies) | `unzipSync` with a name filter read every jar's `fabric.mod.json`, `quilt.mod.json`, `META-INF/neoforge.mods.toml`, `META-INF/mods.toml` or `plugin.yml` in ≤ 1.2 ms; a jar cut to 1000 bytes, one cut at 90 %, and a text file were all "invalid zip data" |
| Forge and NeoForge metadata | `smol-toml` 1.8.0 (no dependencies) | Parsed both real `mods.toml` files, `[[dependencies.<id>]]` arrays included |
| Plugin metadata | `yaml` 2.9.1 (no dependencies) | With the default schema `api-version: 1.20` becomes the number 1.2; the `failsafe` schema keeps every scalar a string, so Blockly uses that |
| `server.properties` | `dot-properties` 1.1.2 (no dependencies; also tried `properties-file` 5.0.7, same results) | The server escapes colons (`level-type=minecraft\:normal`); both unescape it, and handle continuation lines, `\u` escapes and escaped separators |
| Reading a world download without unpacking it | `tar` (node-tar) 7.5.22 | Streamed the 197 MB download, kept `server.properties` and `world/level.dat`, and stopped reading once both were in (191 ms, 298 entries). `strict: true` makes a non-archive an error rather than warnings and an empty result |
| `level.dat` | `prismarine-nbt` 2.8.0 | Gzipped big-endian NBT: `Data.Version.Name` "26.3", `DataVersion` 5023 |
| A modpack's file list, without downloading the pack | `@zip.js/zip.js` 2.17.0 (no dependencies, BSD-3-Clause; last published 2026-09-21) | `HttpRangeReader` read the 66 MB Better MC [FABRIC] BMC2 `.mrpack` from Modrinth's CDN, which answers `Range` with 206 (checked 2026-09-24): 4,614 entry names and the one small config inside it, in 6 requests and 1.75 s. fflate works on whole buffers only, so it would have needed the whole file |

What the metadata looks like in real jars, and what Blockly makes of it:
- Fabric's `depends.minecraft` is a list of alternatives (`["1.21", "1.21.1"]`) or one string
  of space-separated predicates (`>=1.21- <1.21.2-`, where the trailing `-` takes in
  pre-releases). Quilt nests them (`{ all: [">=1.20-", "<1.20.2-"] }`).
- Forge and NeoForge use Maven ranges (`[1.20.1, 1.20.2)`) and declare no environment. Sodium's
  NeoForge jar marks every platform dependency `side = "CLIENT"`, which is how a client-only mod
  shows there; newer Forge also has a top-level `clientSideOnly`.
- A bare Maven version (`versionRange = "1.21.1"`) is only a preference to Maven. Blockly reads
  it as that version: a mod built for one release rarely runs on another.
- Plugins declare the oldest API they need (`api-version: 1.13`), and later servers load them.
- JEI leaves `${file.jarVersion}` in `mods.toml`; the jar's `Implementation-Version` fills it.

The browser puts files straight into the store with a presigned PUT signed for the declared size
(`content-length` in `X-Amz-SignedHeaders`). RustFS 1.0.0 answered 200 for exactly that many
bytes and 403 for more or fewer, so a page can't put more than it said. Browsers need a CORS rule
on the bucket for the web origin; RustFS accepted `PutBucketCors` and answered the preflight
(`docker-compose.yml`'s bucket init sets it locally). R2 supports both; the R2 run is part of the
blocked R2 item.

## Realtime TLS over ACME: `acme-client` and Cloudflare's SDK

In `acme` mode (production, §11) the realtime role gets its WebTransport certificate itself:
Fly terminates TLS only for TCP, and never hands out the keys of its own certificates.

| Candidate | Maintained | Result |
|---|---|---|
| `acme-client` 5.4.0 | Last release 2024-07; ~92k downloads a week; RFC 8555, which hasn't changed | Adopted. Against Pebble 2.10.1 (Let's Encrypt's test CA) validating DNS-01 through pebble-challtestsrv: a P-256 certificate for the hostname in 67 ms, the key matching the leaf, 90 days |
| `lego` (Go CLI) | Active | Not needed: a binary to supervise and files to read, for what a library call does |
| `@peculiar/acme-client` 1.8.2 | Last release 2023-07 | Older |

`acme-client` checks the TXT record through the machine's own resolver before asking the CA to
look (kept on in production, off against Pebble, whose DNS the host can't reach). The Pebble
test (`infra/acme/acme-issuer.test.ts`) runs in CI with both containers pinned to 2.10.1.

The DNS-01 record goes into Cloudflare through Cloudflare's official SDK (`cloudflare` 7.1.0,
2026-08, no dependencies; about 65 MB installed, for every Cloudflare API). Its types say TXT
content is quoted RFC 1035 strings, and records are found by exact name. Running it against a
real zone needs a token with DNS edit on that zone: that is the blocked part of this item.

## Loader builds: each server type's own list, read directly

A revision pins its loader build (§4), resolved when the revision is made (`infra/loaders/`).
The image resolves `LATEST`/`RECOMMENDED` through mc-image-helper at every boot, which is exactly
what pinning replaces.

| Candidate | Result |
|---|---|
| An SDK per server type | None exists for Fabric's, Quilt's or NeoForge's metadata, or Forge's promotions |
| `@xmcl/installer` 6.3.4 | Lists Fabric, Quilt, Forge and NeoForge versions, but it is a launcher's installer: undici, zip and tar handling, a Forge site parser, and no Paper. Not adopted for five one-document reads |
| Paper's Fill v3 OpenAPI | Paper alone; one endpoint (`/v3/projects/paper/versions/{v}/builds`) |
| Direct reads, validated with zod | Adopted: one small JSON document per server type, cached ten minutes |

Checked live on 2026-09-19: Fabric's meta answers `400 []` for a version it doesn't know and
lists loaders newest first with `stable`; Quilt's per-version list isn't in release order and
its newest loaders are betas (0.30.1 is the newest release); Paper's Fill API has STABLE builds
for 26.2 and older and only ALPHA for 26.3; Forge's promotions have `<mc>-recommended` for
every offered version but 26.3; NeoForge's Maven lists every version ascending (april-fools
builds included) with betas marked `-beta`, and only betas for 26.3. Every pin those rules gave
booted on the pinned image: Fabric 0.19.5, Paper build 125, Quilt 0.30.1, NeoForge 26.2.0.88 /
26.1.2.109 / 21.11.45 / 21.10.64 / 21.8.54, and Forge 65.1.0 / 64.1.0 / 61.2.0 / 60.1.0 / 58.1.0.

## Eight things written by hand, weighed against libraries (2026-09-23)

A pass over the places where Blockly had written its own version of something a
package already does. Each was tried, not assumed. Four changed, four stayed, and
what follows is why for each one, so nobody has to re-open the question.

Where a decision turns on "this file may not import packages", the rule is
`scripts/check-boundaries.ts`: `domain/` and `minecraft/` import nothing at all,
and `app/` imports only the database, the contracts, `drizzle-orm`, `zod` and
`node:*`. Third-party code lives in `infra/`, behind a port. That rule is not
negotiable per-case; it is what keeps the core testable without a network, a
container or a clock.

| What | Was | Now | Why |
| --- | --- | --- | --- |
| Rate limiting | a hand-written fixed window in `app/policy/limiter.ts` | `rate-limiter-flexible` in `infra/limits/memory-limits.ts`, behind the `Limits` port | the library's window is the one everyone else's is measured against, and moving to a shared store later is a new adapter, not a rewrite |
| PNG encoding | hand-written chunks, CRC-32 and a `zlib` wrapper | `pngjs` (`PNG.sync.write`) | writing a container format by hand earns nothing; the output is byte-identical and the drawing code is untouched |
| Ids | a hand-written `crypto.getRandomValues` v4 assembler | `uuid` | it is the same bytes with someone else's tests around them |
| "3 hours ago" | a hand-written ladder of thresholds | `Intl.RelativeTimeFormat` | already in the runtime, and right in every language the browser has |
| Invite codes | 8 lines of rejection sampling | kept | `nanoid` does exactly this and was tried on 2026-09-23; it lives in `app/`, so adopting it means a port, an adapter and a fake for one random string |
| Slugs | a hand-written `toLowerCase`/replace | kept | `slugify` is better at Unicode, but this is in `domain/`, which imports nothing; the names it slugs are already `^[a-z0-9-]+$` by contract |
| Version ordering | `minecraft/versions.ts` | kept | `minecraft/` imports nothing, and Minecraft's releases are not semver: `26.3` sits beside `1.21.8`, so a library that assumes they are is right today by luck |
| Secret derivation | HMAC-SHA-256 over a label, in `app/secrets.ts` | kept | it is HKDF-Expand with one block, which is a standard construction, and Node's `crypto.hkdf` would be a fair swap — but changing it rotates the RCON password and artifact token of every server already running, for no observable difference |

The card also considered `@resvg/resvg-js`, which would have replaced the pixel
font and the drawing with an SVG template. Rejected on evidence: without system
fonts in the container it renders a 485-byte blank. Only the encoding moved.

## A player's identity where accounts aren't checked (2026-09-23)

A server with `online-mode=false` knows a player by `UUID.nameUUIDFromBytes("OfflinePlayer:" +
name)`: the MD5 of those bytes, as a version 3 UUID. Blockly derives the same thing in two
parts, `minecraft/identity.ts` (the seed and the version bits, with no packages) and
`app/access/identity.ts` (Node's MD5). The `uuid` package's `v3` was the library to reach for,
and it doesn't fit: RFC 4122's v3 hashes a namespace before the name, and Java's
`nameUUIDFromBytes` hashes the name alone, so every UUID would differ.

It is checked against what real servers wrote rather than against itself: `identity.test.ts`
holds the UUIDs vanilla 26.1 logged in `list uuids` and wrote to its whitelist, operator and ban
files, and the ones Paper 1.21.8 wrote for the same names.

The same measurements are why the whitelist is now written as a file (`minecraft/access.ts`):
in offline mode vanilla's own `whitelist add <name>` asks Mojang about a name it hasn't met and
writes that account's UUID — or, for a name no account has, the lower-cased name's — so the
player who joins with that name is not the one on the list. The runs, on itzg 2026.9.1:
vanilla 26.3 and 26.1, Fabric 26.1 and Paper 1.21.8, each online, offline, and switched both
ways under the same `/data`, joined by mineflayer 4.39 with no account.

## Tooltips: Floating UI (2026-09-23)

The first tooltip in the web app (`ui/tip.tsx`) is `@floating-ui/react` 0.27, not hand-written.
What makes a tooltip hard is not drawing it: it is placing it so it flips and shifts at the
screen's edges, waiting a moment before hover opens it, opening on keyboard focus and on a tap
where there is no hover, closing on Escape and outside taps, and wiring `role="tooltip"` and
`aria-describedby`. Floating UI does each of those and is what most component libraries build
on. Radix's tooltip was the other candidate and was set aside because it deliberately never opens
on touch, and a phone is where this app is often used. Blockly keeps only the look and the
motion, on its own tokens.
