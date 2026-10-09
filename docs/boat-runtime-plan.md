# Boat as a Minecraft runtime: the plan

Boat (boat.dev) sandboxes are whole Linux VMs with Docker, billed per second while they run and
free while stopped. This plan adds them as a second production runtime beside Fly, behind the
existing `MinecraftRuntime` port, one provider per deployment as today.

It was written after reading the code and after a short live probe on a real Boat sandbox and a
temporary Fly app in `blockly-staging`. Findings from that probe are marked **(probed)**; earlier
observations of Boat are marked **(observed)**; Boat's docs and OpenAPI (`docs.boat.dev/openapi/boat-v1.yaml`, fetched
2026-09-28) are marked **(docs)**.

## 1. Current architecture summary

- **The port.** `apps/control/src/app/ports/runtime.ts` defines `MinecraftRuntime`: opaque
  `RuntimeHandle`/`SnapshotHandle` strings issued by an adapter and stored verbatim
  (`runtimes.handle`, beside `runtimes.provider`), a `RuntimeSpec` (image, entrypoint, env,
  secrets, memory, storage, ports, stop signal and timeout, labels), and lifecycle, storage,
  observation, inventory, `endpoint`, and `tag`/`locate`/`prices`. `RuntimeUnsupported`
  and `RuntimeFull` are its two typed refusals. `scripts/check-boundaries.ts` stops anything above
  `infra/` from branching on a provider id or naming a provider's hosts.
- **Adapters.** `infra/fly/` (one app per server, one volume, one machine, reached on the app's
  Flycast address; handle `fly:v1:<base64url zod-checked JSON>` in `handle.ts`; typed client
  generated from Fly's OpenAPI with `tools/openapi` into `generated/machines.ts`, paced in
  `client.ts`), `infra/docker/` (one container + named volume per server; snapshots are volume
  copies), `infra/fake/` (in-process). Each comes with a `LogSource`; `main.node.ts`
  `providerFor()` pairs a runtime with its logs, console and readiness probe.
- **Wiring.** `config/load.ts` reads `RUNTIME_PROVIDER` into the `runtime` discriminated union in
  `config/schema.ts` (with provider checks such as Fly's machine limit); `main.node.ts` builds the
  adapter and `serverCeiling` feeds `AccessPolicy`.
- **One provider per deployment.** `loadRuntime()` (`app/servers/persistence.ts`) marks a binding
  from another provider `foreign`, and handlers refuse to touch it (`bindingOf` in
  `app/operations/handlers.ts`).
- **Lifecycle.** `domain/server/lifecycle.ts` `decide()` turns commands into operations under the
  server's row lock; a second start while one is in flight is a `noop` ("a second join or press
  waits for the same boot"). Operations run one at a time per server (`app/operations/runner.ts`,
  pg-boss). Handlers (`handlers.ts`): `provision`, `start`, `restart`, `apply`, `stop`, `backup`,
  `archive`, `restore`, `relocate`, `prune_worlds`, `access_sync`, `decommission`, `purge`,
  `store`, `unstore`. `bringUp` calls `ensureProvisioned` (which persists the handle through
  `ProgressSink.handle` and leaves the workload started) and then `BootSequence.run`
  (`app/operations/boot.ts`), which waits for `waitRunning`, then a status ping on
  `endpoint(game, 'control')`, checks installed jars/packs through `exec`, and re-imposes access,
  restarting the workload (stop + start) in four places when it must.
- **Stop.** `stop` handler: `windDown` (access import, `save-all flush` over RCON), `measureDisk`
  (`exec du`), `runtime.stop`, then `stopped{reason}`; a stop that fails for good is forced
  (`abandon` → `forceStop`).
- **Reconcile.** `app/operations/schedules.ts` `reconcile()` (every minute) consumes
  `observeChanged`; only a server's current compute (`sameCompute`) speaks for it; a running
  server whose workload exited is `crashed`; compute running behind a server that holds none is
  stopped (`#stray`). Host loss (`HOST_LOST`) waits `HOST_LOSS_GRACE_MS` then `relocations()`
  rebuilds from the newest snapshot. `presenceSync` reads `list uuids` over RCON.
- **Edge.** `app/edge/service.ts` `routes()` builds every route on every poll from the stored
  handle (`endpoint(game, 'edge')`, `destinationOf` brackets IPv6); `apps/edge/agent.ts` polls
  `/edge/v1/routes` every second with an ETag and SIGHUPs mc-router. `wake()` starts a server as
  `{system, wake}` (capped by `WAKES_PER_HOUR = 12` per server) and waits `wakeWaitMs` (25 s)
  for `running`, then answers the destination read from the handle at that moment.
- **Console.** `RconConsole` (`infra/mc-protocol/rcon.ts`) speaks RCON to
  `endpoint(rcon, 'control')`; the access reconciler writes files through `runtime.exec`.
- **Backups.** Provider snapshots (`snapshot`, `goneSnapshots`, `deleteSnapshot`,
  `snapshotLifetimeDays`) and portable archives in the S3 store (`exportSnapshot` writes a
  `tar.gz` of the data directory; `restore` from `{kind: 'archive'}` extracts one). Resting worlds
  (`store`/`unstore`) keep only the archive and `release` the compute and storage.
- **Metering.** Blockly records power intervals itself (`openInterval`/`closeInterval` in
  `app/servers/usage.ts`) from lifecycle transitions; woken runs are marked for probation.
- **"Make your own server".** `app/setups/service.ts` copies another server's *setup* (version,
  loader, mods, pack), never its world: the new server is provisioned fresh by the runtime.

## 2. Existing Fly runtime behavior that can be reused

- The handle pattern (`infra/fly/handle.ts`): prefixed, versioned, zod-validated base64url JSON.
- The typed client pattern: vendored OpenAPI + `tools/openapi` generation + `openapi-fetch`,
  with a thin pacing/retry wrapper (`infra/fly/client.ts`: 429 waits out `Retry-After`, only
  idempotent methods retry on 502–504).
- List-before-create idempotency, deployment-prefixed names (`bly-<deployment>-<server hex>`),
  `keyFromApp`, and refusing to destroy anything outside the deployment's prefix.
- The helper-job pattern (`#helperJob`): start a long script in the background, poll a result
  line (`ok …`/`failed …`), fail at once when the job vanished. Boat's detached commands replace
  the helper machine; `exportJob`/`restoreJob` define the portable archive format.
- `stateOf`/`observationOf` shape (a state map plus exit and failure details).
- Test style (`infra/fly/fly-runtime.test.ts`): an in-memory provider API behind the real client.

Not reused: leases (Boat has none; one-operation-per-server already serializes), Flycast (Boat
has no private network between sandboxes **(observed)**), regions and placement checks (Boat is EU
only, with no region choice **(docs)**), volume snapshots (Boat has no durable per-backup
snapshot API, see §16), helper machines.

## 3. Boat API capabilities required

All under `https://boat.dev/api/v1`, `Authorization: Bearer` **(docs)**:

| Need | Call |
| --- | --- |
| live start quota, headroom | `GET /limits` → `starts.{minute,hour,day}.{limit,used,remaining}`, `canStart` **(probed)** |
| provision | `POST /sandboxes {type, ttlSeconds, noEnv: true, env}` + `Idempotency-Key` (24 h) |
| name for listing/tags | `PATCH /sandboxes/{id} {name, ttlSeconds}` |
| read state/address | `GET /sandboxes/{id}` → `state`, `ip` (IPv6), `updatedAt`, `archiveAfter`, `lastSnapshotStatus` |
| list/inventory/changes | `GET /sandboxes?limit&cursor` (paginated) |
| suspend | `POST /sandboxes/{id}/stop {}` (never `force`) |
| wake | `POST /sandboxes/{id}/resume {type?, ttlSeconds?}` |
| delete | `DELETE /sandboxes/{id}` + `X-Ascii-Confirm-Delete: <id>` |
| run inside | `POST /sandboxes/{id}/commands {command, timeoutSeconds ≤ 600, detached?}`, `GET …/commands/{pid}` |
| cross-check billing | `GET /sandboxes/{id}/usage?since&until` |

Not needed now: fork, named snapshots (10 per account), snapshot downloads, webhooks, hosting.

## 4. Gap analysis

| Blockly assumes | Boat does | Consequence |
| --- | --- | --- |
| `endpoint()` pure and stable (Flycast) | IPv6 changes on every resume **(owner, probed ×3)** and a stopped sandbox's address may go to someone else | handle must carry the address; a new handle after each start; the edge must never dial a stale one |
| `start`/`stop` are cheap | every create/fork/resume is a *start* against minute/hour/day limits | count, gate and avoid starts (§18) |
| boot restarts = `stop`+`start` | on Boat that is a snapshot, a resume, a start and a new address | a workload restart that keeps the compute |
| stop signals the workload | Boat's stop snapshots the disk without telling Minecraft **(observed)** | adapter stops the container first, bounded, then suspends |
| volume snapshots, restorable, deletable | continuous whole-disk snapshots, superseded ones deleted, no "restore to snapshot N" **(docs)** | Blockly snapshots are files inside the sandbox (as Docker's are volumes) |
| provider firewall | ufw default-deny; **the 25565 rule was gone after a resume (probed)**, survived an in-VM reboot (probed), reset on fork **(observed)** | re-open on every start, idempotently |
| crash = machine exit event | Docker restarts `unless-stopped` containers; Boat recreates running containers on resume **(probed)** | crash reconciliation from container state and sandbox state |
| RCON over private network | no private network; public RCON would be exposed | console through `exec` (§11) |
| config change on a stopped server | no way to change a stopped sandbox (PATCH takes name/ttl/subdomain only) **(docs)** | apply on a stopped Boat server resumes it (a start) |
| TTL | trial: at most 2 h, auto-stop mandatory **(docs)**; paid: `null` allowed | TTL is configuration; also used as a dead man's switch (§7) |

## 5. Exact files/modules likely to change

New, all under `apps/control/src/infra/boat/`:
- `boat.openapi.json`, `generated/boat.ts` (from `tools/openapi`, new `boat` entry in
  `tools/openapi/openapi.ts`)
- `client.ts` (typed client, error type, retry rules), `handle.ts`, `boat-runtime.ts`,
  `starts.ts` (quota gate and instrumentation), `sandbox-scripts.ts` (the shell run inside a
  sandbox), `boat-minecraft.ts` (console, readiness probe and log source over `exec`), tests.

Changed, kept small (named in the PR):
- `app/ports/runtime.ts`: the extension in §6.
- `infra/fly/fly-runtime.ts`, `infra/docker/docker-runtime.ts`, `infra/fake/fake-runtime.ts`:
  `start` returns its handle; `restart`; `stableEndpoints = true`.
- `app/operations/handlers.ts`: save the handle `start` returns.
- `app/operations/boot.ts`: its four stop+start pairs become `restart`.
- `app/edge/service.ts`: route a server with an unstable endpoint only while it runs.
- `app/operations/schedules.ts`: save an address the provider moved.
- `config/schema.ts`, `config/load.ts`, `main.node.ts`, `.env.example`: the `boat` provider.
- `scripts/check-boundaries.ts`: Boat's hosts belong to `infra/boat` only.

## 6. Required changes to `MinecraftRuntime`

The smallest set that keeps Fly, Docker and Fake behavior as it is:

1. **`start(handle): Promise<RuntimeHandle>`** — returns the handle to keep. A provider whose
   compute comes back at a new address issues a new handle; callers save it exactly as they
   already save what `apply` returns. Fly/Docker/Fake return the handle they were given.
2. **`restart(handle): Promise<void>`** — stops the workload as `stop` does (killing it if it
   won't stop) and starts it again *on the same compute*, keeping its endpoint. Boot's four
   stop+start pairs use it. Fly/Docker/Fake: `stop().catch(forceStop)` then `start`. Boat:
   restart the container, no Boat start spent, address unchanged.
3. **`readonly stableEndpoints: boolean`** — whether a stopped server's endpoint still reaches
   that server and nothing else. Fly (Flycast), Docker (container name) and Fake: `true`. Boat:
   `false`: the edge gives such a server's hostname a destination that dials nothing until it is
   `running` again. mc-router (1.47.1 `server/connector.go`) calls the wake webhook only for
   logins, and **dials the route's stored destination for status pings and for a second player
   who joins while a wake is in flight**, so a stale Boat address could otherwise reach another
   tenant's sandbox.
4. **`RuntimeObservation.handle?: RuntimeHandle`** — set by `observe` when the compute is now
   reached at another address than the handle says (Boat restored a sandbox somewhere else
   without being asked). Reconcile saves it under the server's lock, only if the stored handle
   is still the one it asked about.

`endpoint()` stays pure. Nothing above `infra/` learns the word "sandbox".

## 7. Boat adapter design

- **One sandbox per server**, `noEnv: true` (no account secrets inside, per Boat's platform
  guide), per-sandbox env `BLOCKLY_DEPLOYMENT`, `BLOCKLY_SERVER`, named
  `bly-<deployment>-<server hex>` (PATCHed right after create; tags follow the name, see
  `tag`). Created with `Idempotency-Key: bly:<deployment>:<server>:<generation>`; list-before-
  create finds an existing one by name first.
- **Handle** `boat:v1:` + base64url JSON: `{deployment, serverId, sandboxId | null, address |
  null, ports, type, generation}`. `generation` grows each time a released server gets a new
  sandbox, so an idempotency key is never reused for a different sandbox.
- **Size**: memory → Boat type: ≤ 3 GB container → `small` (4 GB VM), ≤ 6 GB → `default`
  (8 GB), else `large` (16 GB); bumped when the data budget (12/50/125 GB) is less than twice
  `storage.sizeGb` plus the image. A type change is a resume with `type` (a new address).
- **Inside the sandbox**, driven by one idempotent script per step through `exec`:
  - world: Docker named volume `blockly-data` (captured by Boat's snapshots **(docs)**);
  - Blockly snapshots: files in the named volume `blockly-snapshots`;
  - the spec: `~/.blockly/workload.env` (0600: env and secrets) and the container, named
    `blockly-workload`, created with `--restart unless-stopped`, memory limit, `--pids-limit`,
    `no-new-privileges`, labels with the spec digest, and **only the game port published**
    (`-p <game>:<game>`); RCON never leaves the container;
  - firewall: `sudo ufw allow <game>/tcp`, checked with `ufw status`.
- **TTL as a dead man's switch.** A sandbox Blockly wants running has `runTtlSeconds` (config:
  `null` on a paid plan, ≤ 7200 on the trial). A sandbox the adapter woke only to do work on a
  stopped server (apply, snapshot, export, restore, delete a snapshot) is *parked*: container
  stopped, TTL set to a few minutes, so Boat stops it by itself if nothing starts it next, which
  also covers a control-plane crash mid-operation. `start` on a parked sandbox clears the park
  (no second Boat start), which is what makes restart-with-changes and starts-onto-a-change cost
  one start, not two.
- **`serverCeiling`**: Boat's concurrent cap is per plan (`/limits` `activeSandboxes`); the
  adapter reads it at boot (`checkAccount`) and reports it like Fly's machine limit. Trial: 2.
- **`snapshotLifetimeDays = null`**, `deleteSnapshot` supported, `isPlaced` always true,
  `relocate` a no-op (or a restore from a snapshot), as `DockerRuntime` does.
- **`tag`**: written into the sandbox name after the prefix, only where it differs. **`locate`**:
  sandbox id, name and Boat's dashboard. **`prices`**: $0.018/0.036/0.072 per hour by type,
  storage 0 (a stopped sandbox is free **(docs)**).

## 8. Lifecycle/state-machine changes

No change to `domain/server/lifecycle.ts`. Boat states map onto `ObservedState`:

| Boat sandbox | container | observed |
| --- | --- | --- |
| `init`, `provisioning`, `provisioned`, `cloning` | — | `starting` |
| `ready`, `idle`, `running` | running / restarting | `running` / `starting` (+`failedAt` after a restart) |
| `ready`, `idle`, `running` | missing within 60 s of a resume (Boat restoring it) | `starting` |
| `ready`, `idle`, `running` | exited/created | `stopped`, or `crashed` for a non-zero, unrequested exit |
| `archiving` | — | `stopping` |
| `archived` | — | `stopped` |
| `error` | — | `crashed` (detail from `error`) |
| `cancelled` / 404 | — | `absent` |
| API or exec unreachable | — | `unknown` |

`observeChanged` uses one listing (sandbox state only; running sandboxes read as `running`),
`observe` adds one `exec` for the container. The adapter never reports `hostLost`: Boat restores
its own machines, and Blockly's snapshots live inside the sandbox, so a rebuild elsewhere from
them is impossible; that recovery is Boat's (§13).

## 9. Networking/edge changes

- **Proven (probed):** a Fly machine in `fra` dialled the sandbox's IPv6 on 25565, and mc-router
  1.47.1 on that machine, given `[addr]:25565` exactly as `destinationOf` writes it, relayed a
  status ping to Minecraft on Boat. Fly machines have IPv6 egress.
- Inbound is IPv6 only; `docker-proxy` listens on `[::]:<game>`, so ufw governs it. Boat's
  `sync-docker-firewall` unit mirrors ufw into Docker's chain for IPv4 **(probed)**.
- `EdgeService.routes()`: when `!runtime.stableEndpoints` and the server isn't `running`, the
  route's destination dials nothing, so pings get the asleep message and a login goes through
  the wake webhook, whose answer is read from the handle once the server runs.
- `destinationOf` already brackets IPv6.

## 10. Dynamic Boat address handling

- `GET /sandboxes/{id}` is the only source of the address; `<subdomain>.on.boat.dev` points at
  Boat's HTTPS proxy, not the VM **(observed)**, and the docs offer nothing stable for raw TCP. The
  stable identifier is the sandbox id, kept in the handle.
- The address in the handle is refreshed by: `ensureProvisioned` (saved through
  `ProgressSink.handle` once the sandbox is up), `start` (returned, saved by the handler),
  `apply`/`restore` (returned, saved as today), and reconcile when Boat moved a running sandbox
  (§6.4).
- Boot restarts (`restart`) keep the sandbox, so its address.
- The address is never trusted while the server isn't running (§9).

## 11. Console/exec strategy

| | Boat `exec` + `rcon-cli` in the container | RCON over public IPv6 | attach to the container's stdin |
| --- | --- | --- | --- |
| exposure | none: RCON stays inside the container | 25575 open to the internet, password in clear | none |
| address dependence | sandbox id only | current IPv6 | sandbox id |
| output | yes | yes | no (read back from logs) |
| cost | ~0.1–1.7 s per call **(probed)** | ms | — |

Chosen: `exec`. `BoatConsole` (a `ServerConsole`) and `BoatProbe` (a `ReadinessProbe`) read the
sandbox id from `endpoint(…, 'control')`, whose host for Boat is the sandbox id (an address no
resolver answers, as the fake runtime's hosts are), and run `docker exec blockly-workload rcon-cli
…` / `mc-monitor status`. `rcon-cli` reads the container's own password, so a key rotation needs
nothing (probed: it answered with and without the password). `runAll` sends its commands in one
`exec`. `BoatLogSource` reads `docker logs` through `exec` (tail polls every 2 s). The port stays
as it is; these three are paired with the runtime in `providerFor()`, as the fake's are.

## 12. Graceful stop design

`BoatRuntime.stop(handle)`:
1. The server is already `stopping` and its operation holds the server's queue (no conflicting
   lifecycle work can run); `windDown` has flushed the world over the console.
2. `exec`: `docker stop -t <spec.stop.timeoutSeconds> blockly-workload` (SIGTERM, the image's
   `STOP_DURATION` of 60 s saves the world; probed: 2.1 s, "All dimensions are saved").
3. Confirm with `docker inspect` that it is not running; bounded by the timeout plus 30 s.
4. Only then `POST /stop` and wait for `archived` (probed: 1.9 s, 4.5 s, 28.8 s for a first full
   snapshot).
5. Reconcile reads `stopped` afterwards.

Minecraft refusing to stop: the stop throws without suspending; the operation retries; once it
fails for good, `abandon` → `forceStop`: `docker kill`, then Boat's ordinary stop. Boat refusing
a stop (its snapshot failing): the sandbox stays up, Boat stops billing and retries itself
**(docs)**; the adapter reports it and never sends `force` (which loses data).

## 13. Crash/reboot reconciliation

| Event | What Boat/Docker do | What Blockly sees and does |
| --- | --- | --- |
| user stop / idle sleep | — | `stop` operation (§12), `stopped{user|idle}` |
| Minecraft process crash | `unless-stopped` restarts it | `running` with `failedAt`; boot diagnoses from logs as on Fly |
| in-VM reboot | state stays `idle`, same address, ufw kept, container back in ~16 s **(probed)** | `unknown` while exec fails, never a crash |
| Boat stops the sandbox (TTL, maintenance) | archived with Minecraft running | listing `stopped` → `#crashed` → `stopped{crash}`; next start resumes and Boat brings the running container back by itself **(probed: ~23 s)** |
| sandbox briefly unreachable | 5xx/timeouts | `unknown`, nothing acted on |
| machine moved by Boat, still running | new address | observation carries the new handle, reconcile saves it (§6.4) |
| control-plane restart | — | the adapter holds no state that matters; reconcile's first pass is a full one |

A Boat reboot is never a deliberate stop: only Blockly's own `stop` operation records one.

## 14. Firewall handling

Idempotent `sudo ufw allow <game>/tcp` + check, run by every path that brings compute up:
create, resume (`start`, `ensureProvisioned`), fork (unused now), restore onto a new sandbox,
and `restart`. Nothing else is opened; RCON is not published at all.

## 15. Fork/clone design

"Make your own server" copies a setup, not a world, so it stays provider-independent and does
**not** use Boat fork: a fork would carry the source's world, access files, RCON password and
Docker state. Fork could later speed up provisioning from a prepared template sandbox (image
already pulled), but a fresh create was ready in under a second and pulled the 1.24 GB image in
~6 s **(probed)**, so it isn't worth a template's upkeep now. If fork is ever used, the fork gets
its own name, env, idempotency key, handle (new sandbox id and address), re-opened firewall
**(owner: fork reset ufw)**, and a new RCON password through the spec.

## 16. Backup strategy

- Boat's own snapshots are continuous and superseded ones are deleted, and there is no "restore
  snapshot N" **(docs)**, so they can't be Blockly's backups. They remain Boat's recovery for the
  sandbox itself.
- **Blockly snapshots on Boat** are `tar.gz` files of the data volume in the `blockly-snapshots`
  volume (so Boat's snapshots carry them across stop/resume), the same format `exportJob`
  writes. Taken while the world is flushed with saving off (`capture`), as today.
- **Archives** (the portable format) are unchanged: `exportSnapshot` uploads that file to the
  presigned URL from inside the sandbox; `restore` from an archive downloads and extracts it.
  Worlds move between Fly, Docker and Boat through archives, which is the migration path.
- Work on a stopped server (snapshot, delete, export) resumes and parks the sandbox: a start.
- Disk: snapshots share the sandbox's data budget; §7's type rule leaves room for it.

## 17. Billing/metering integration

Unchanged: power intervals from transitions. `prices()` gives the list price per type.
`GET /sandboxes/{id}/usage` is the cross-check (used in the live test; an admin read can come
later). Parked time (a few minutes after work on a stopped server) is Boat time Blockly doesn't
bill as play time; it is logged with its reason.

## 18. Start-quota strategy and instrumentation

Kept inside `infra/boat/starts.ts`; nothing above the port changes for it.
- **Source of truth**: `GET /limits` (`starts.{minute,hour,day}`, `canStart`), fleet-wide and
  surviving control-plane restarts. Cached a few seconds, re-read after each start. A bigger plan
  raises the numbers there, so no configuration changes with the plan.
- **Gate**: before every create/resume, if `canStart` is false or any window has no starts left,
  throw `RuntimeFull` (owners read "There was no room for it where it runs just then. Try again
  in a few minutes."). Starts that serve no player (apply/snapshot/export/delete on a stopped
  server) keep a configurable reserve (`BOAT_START_RESERVE`, default 10% of the day) for wakes.
- **429 `rate_limited`**: a minute window is waited out inside the call (bounded, with backoff
  and jitter), since a wake is waiting anyway; an hour or day window throws `RuntimeFull`.
- **Idempotent starts**: `start` reads the sandbox first and resumes only an `archived` one; an
  `archiving` one is waited out first; a 409 on resume is treated as a resume in flight and
  polled. Creates carry an `Idempotency-Key`. Concurrent wakes are already one operation
  (`decide()` noop under the row lock), and the adapter adds a per-sandbox in-process single
  flight so reconcile and an operation never resume the same sandbox twice.
- **Instrumentation**: one structured log line per start (`boat start: kind=resume
  reason=start server=… sandbox=… minute=1/5 hour=6/25 day=6/75`), warnings at 80% of any
  window, and per-server per-UTC-day counts in the log line (process-local). Fleet-wide numbers
  come from `/limits`, which the line carries.
- **Minimum idle periods vs a bigger plan**: an idle `small` costs little per hour, so keeping a
  server up longer to save one start is cheap, but a plan's daily starts divided by the wakes per
  server is how many servers it holds. Stretching idle time only makes sense for a few servers that wake dozens
  of times a day, and only after the logs show quota pressure. Which plan to buy is the
  operator's decision; nothing here assumes one.

## 19. Failure modes

| Failure | Handling |
| --- | --- |
| start quota exhausted | `RuntimeFull` before any call; owner told plainly; retried later by the queue |
| 429 per-minute | waited out inside the start, bounded |
| resume 409 (already resuming) | poll until ready |
| stop refused (snapshot failing) | error, retried; Boat doesn't bill; never `force` |
| container not restored after resume | every verb on a sandbox Boat has saved waits for it, up to 360 s from the first look (a command answers `wait` after 100 s and is asked again); then recreate it from `~/.blockly`. A sandbox Boat never saved has nothing coming back and doesn't wait |
| early `docker start` during Boat's restore | wait until the container exists, then start; retry if it stays `created` |
| exec `409 boat_starting` | wait for `ready`/`idle` first; retry |
| exec `502 boat_direct_failed` | not retried blindly: all Boat scripts are idempotent, so they are |
| long jobs (tar, upload) | detached command + status polling, never one 600 s exec |
| a parked sandbox nobody starts | Boat's TTL stops it |
| sandbox deleted outside Blockly | `absent`; a start fails, the server fails, the owner can restore an archive |
| address reused by someone else | never routed while not running (§9) |
| data budget full | snapshot fails; type rule leaves room; alert via failed backups |

## 20. Security considerations

- The Boat API key lives only in the control plane's secrets (`BOAT_API_TOKEN`); sandboxes are
  `noEnv`, so they hold no account secrets or credentials.
- Only the game port is open; RCON never leaves the container; SSH is Boat's.
- Secrets reach the sandbox through `exec` into a 0600 file, never through Boat env (which forks
  and templates inherit **(docs)**) or the command line of a visible process.
- Mods run in a container with `no-new-privileges`, a pids limit and a memory limit, as on
  Docker; the VM's `sudo` is the sandbox user's, not the container's.
- Destroy/release refuse any sandbox not named with the deployment's prefix; deletes send the
  confirm header naming that sandbox only.
- Stale addresses are never routed (§9).

## 21. Migration/rollback strategy

- One provider per deployment stays. A deployment switches by setting `RUNTIME_PROVIDER=boat`;
  existing Fly bindings become `foreign` and are left alone, as today.
- Moving a world between providers is an archive: export on the old deployment, import (upload)
  on the new. Nothing Boat-specific is ever the only copy of a world that rests.
- Rolling back is setting `RUNTIME_PROVIDER` back; Boat bindings become foreign. The port
  changes are backwards-compatible for Fly/Docker/Fake.
- Canary: a separate deployment id on Boat for a handful of servers, compared with Fly.

## 22. Test plan

- Unit (`infra/boat/boat-runtime.test.ts`): an in-memory Boat API (sandboxes, limits, commands
  answered by a scripted sandbox) behind the real client: provisioning is idempotent (list,
  idempotency key, name); start resumes only when archived, returns the new address, re-opens the
  firewall, waits for the restored container; concurrent starts resume once; stop stops the
  container before the sandbox and refuses to suspend a container that won't stop; quota gate
  throws `RuntimeFull` without calling resume; 429 per-minute is waited out, per-day is not;
  observe maps states; observeChanged/inventory list only the deployment; destroy refuses other
  prefixes; handles round-trip; endpoint gives the address to the edge and the sandbox id to the
  control plane; parking sets a TTL.
- Port changes: existing Fly/Docker/Fake tests plus new ones for `restart` and the returned
  handle; `app/edge/edge.test.ts`: an unstable endpoint routes nowhere unless running;
  `app/operations/lifecycle.test.ts`: a start that moves the address saves it; reconcile saves an
  address the provider moved and never an older one.
- Config tests (`config/config.test.ts`) for the `boat` variant.
- Live: the whole lifecycle against a real sandbox, and the edge from a temporary Fly machine
  (§24).

## 23. Observability/metrics/logging plan

- Every Boat start: one log line with kind, reason, server, sandbox and `/limits` windows.
- Warnings at 80% of any window; `RuntimeFull` failures land on operations, and a burst of them
  surfaces in the existing `blocked_operations` alert.
- Every stop: how long the container took to stop and how long Boat took to archive.
- Every address change: old → new, logged with the server.
- Next step (not in this change): an admin alert `boat_starts_low` read from `/limits`.

## 24. Phased implementation order

1. Vendor Boat's OpenAPI, generate types, typed client with the retry rules. Tests.
2. Port extension (§6) with Fly/Docker/Fake and the application call sites. All existing tests.
3. `BoatRuntime` core: handle, provision, start, stop, observe, list, destroy, endpoint; starts
   gate; unit tests.
4. Storage: snapshot, restore, export, release, parking. Unit tests.
5. Console/probe/logs over exec; config and `main.node.ts` wiring; boundaries.
6. Live test on a real sandbox (create → Minecraft → firewall → ping → console → graceful stop →
   suspend → resume → new address → firewall → edge from Fly again → restart → snapshot/export →
   quota and concurrent starts → usage), then cleanup and the report.

## 25. Risks and unresolved questions

- **Rate limits on the API itself** (not starts) aren't documented; presence reads and boot
  pings go through `exec`. Ask Boat.
- **Stale-address reuse**: how soon Boat hands a freed IPv6 to another sandbox. Ask Boat; the
  edge design doesn't depend on the answer.
- **Machine loss**: whether Boat always brings a sandbox back itself, and what state/API answer
  a lost one shows. Ask Boat.
- **Container restore timing** after resume (~13 s probed) dominates a wake (~22 s total).
  Ask Boat whether the Docker manifest could be restored before `ready`.
- **Slower Hetzner machines** (not selectable) may land under a paying player **(docs)**.
- **Quota vs sleep**: starts per day is the real limit on how many sleeping servers a plan holds.
- **Data budget**: world plus snapshots on one disk.
- **Trial limits** make a production canary impossible before a paid plan (2 sandboxes, TTL ≤ 2 h).
