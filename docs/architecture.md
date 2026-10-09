# Blockly — architecture and domain model

How Blockly is built: the domain it models, the layers it keeps apart, and the reasons behind
the parts that look surprising. The code cites this document by section — a comment ending in
`(§15.3)` means the trust and listing section here — so the numbering is part of the interface
and does not move.

For the current picture of how Blockly runs, read the canonical overview,
[Blockly-Architecture.pdf](architecture/Blockly-Architecture.pdf) (its source is in
`docs/architecture/`); this file stays the design the code cites.

Where a decision was forced by how someone else's platform actually behaves, §2 gives the
finding and its source. Those were read on 2026-09-19.

**Scope.** This document covers the whole system:
- auth, account standing, entitlements and billing
- abuse controls and kill switches
- lifecycle, provisioning, power, worlds, revisions, mods, dependency resolution and rollback
- backups, logs, console, realtime and presence
- listings, trust and moderation
- setups, modpacks, sharing and invites
- edge routing, wake-on-join and idle shutdown
- reconciliation, orphan cleanup, deletion and purge
- the provider abstraction, deployment configuration and environments

§20 orders these by dependency. That is the order they can be built in, not a statement about
which of them are in and which are out.

---

## 0. The decisions everything else follows from

1. **A Minecraft server is not a provider machine.** `MinecraftServer` is what someone owns and
   names; `ServerRuntime` is the compute currently behind it, `ServerRevision` the configuration
   it boots, `Operation` the work in flight. A machine can be replaced without the server
   changing, which is what makes restore, relocation and crash recovery ordinary (§4, §8).
2. **One app per server, one volume, at most one machine.** Creating is list-before-create with
   an idempotency key, so a retry never leaves two (§8).
3. **The control plane is the only writer of power state.** Nothing else starts or stops a
   server: no provider autostart or autostop, and neither of the game image's own autopause and
   autostop. A server runs when Blockly's state machine says it runs, and a player's connection
   wakes one through the same checks as the Start button (§12). The exceptions are bounded:
   - Fly and Docker restart a server whose process failed, up to 3 times (`on-failure`).
   - A fleet node does the same, and starts again what ran before its host rebooted, only while
     it holds the execution lease the control plane grants ([fleet.md](fleet.md) §7).
   - Boat stops a sandbox at its time to live, where one is set (`BOAT_RUN_TTL_SECONDS`).
4. **Revisions are immutable and fully pinned.** Every jar, loader build and setting is decided
   before boot; the container resolves nothing. A server has a desired revision and an applied
   one, and rolling back is applying an earlier one (§4, §7).
5. **Access is not part of a revision.** Who may join, who is an operator and who is banned have
   two legitimate writers — Blockly and whoever types a command in game — and a restore rewinds
   the files under both. That is a reconciled record, not boot configuration (§15.1).
6. **One policy decides what an account may do.** Entitlements, standing, kill switches and rate
   limits are evaluated in one place, under an advisory lock, and workers check again before
   spending money on work accepted earlier (§6).
7. **The state machine is explicit and pure.** Commands and outcomes are decided by two pure
   functions over the current lifecycle, `decide` and `transition`, so a service accepting a
   request and a worker re-validating it agree by construction (§10).
8. **Commands and queries go over tRPC; realtime carries hints, never truth.** An event says
   something may have changed; the reader asks for the truth (§13).
9. **Operations converge rather than replay.** Each step is an `ensure*` that is safe to run
   again, queued per server in strict order, enqueued inside the transaction that decided it
   (§9).
10. **Object storage is a capability, not a requirement.** A deployment without it runs
    everything except durable archives, downloads, uploaded jars and the catalog mirror, and
    says so in its own words rather than failing (§15.4).

---

## 1. Addressing and provider boundaries

**Two kinds of address, two audiences.** The Minecraft join address is application data: views,
listings and edge routes all need it, so `PlayAddressing` is a port services may hold. Web, API
and realtime origins are wiring: Better Auth, CORS and realtime tickets consume them once at the
composition root, through `DeploymentConfig`. Putting `webOrigin()` on the interface services
receive is exactly the leak the split exists to prevent (§11).

**Addressing is a bijection, with aliases.** The edge reports the hostname a player typed, and
the control plane maps it back to a slug: `addressFor(slug)` and `slugFor(hostname)`, tested as
round trips. Aliases are how a play domain moves with nobody noticing — the old name keeps
routing while players drift onto the new one.

**There is no cookie domain.** The browser talks only to the web origin, and Next rewrites
`/api/*` to the control plane, so cookies are host-only and first-party everywhere: preview
deployments, Safari's cross-site rules and local ports all work without configuration, and a
staging cookie can never reach production through a shared parent. Realtime is the one direct
browser-to-control-plane path, and it carries a short-lived ticket rather than a cookie (§13,
§14).

**A runtime handle is opaque.** The application stores whatever the adapter issued and hands it
back; only the issuing adapter can read it. The alternative, a `{ provider, externalId,
metadata }` record, is stringly typed, means something different per provider, and invites
consumers to read fields they should not know exist (§8).

**Region and size are product; machine class is not.** Someone picks Frankfurt and a 4 GB
server, so the domain keeps a product region key and a memory tier, validated against a
configured catalog. Turning those into a provider region and a machine size is the adapter's
job, under that provider's own rules about memory per CPU (§8, §11).

**Restoring a backup replaces the runtime.** A machine's volume cannot be swapped, so a restore
is a new volume and a new machine. The handle therefore changes on restore and relocation, and
edge destinations are written so that nothing depends on machine identity (§8, §12).

---

## 2. What the platforms actually do, and what it forces

| Finding | Decision it drives | Source |
|---|---|---|
| A machine's volume can't be changed by update; restore = new volume from `snapshot_id` + new machine. | `restore`/`relocate` return a **new handle**. Edge destinations use a name stable across machine replacement. | https://fly.io/docs/machines/api/machines-resource/ · https://fly.io/docs/volumes/snapshots/ |
| Deleting an app loses volumes after 24 h, and snapshots can't be relied on afterwards. | Deletion is two-phase (soft delete → purge). Durable backups need object storage (**archive** tier). | https://fly.io/docs/volumes/volume-states/ · community.fly.io/t/…/28627 |
| `GET /v1/platform/regions` exposes `deprecated`, `requires_paid_plan`. Region deprecation requires fork + recreate; nothing moves automatically. | Product region catalog maps onto provider regions and is checked at boot. `relocate` is a real operation. | https://fly.io/docs/machines/guides-examples/machine-placement/ · https://fly.io/blog/the-region-consolidation-project/ |
| Shared CPUs max at 2 GB per CPU; performance 2–8 GB per CPU. 8 GB needs shared-cpu-4x or performance-1x. | Sizing is an adapter concern keyed by memory. | https://fly.io/docs/machines/guides-examples/machine-sizing/ |
| No machine-state webhooks; the org machine list supports `updated_after`, and changes may land late. | Reconcile by polling with overlapping windows. | spec · community.fly.io/t/…/10064 |
| Machines API rate limit ≈ 1 req/s per action per machine/app (burst 3). | Fly client is rate-limited and retry-aware. Reconcile uses the org-wide list. | https://fly.io/docs/machines/api/working-with-machines-api/ |
| Logs: NATS `logs.<app>.<region>.<machine>` (live, experimental) and HTTP (7-day history, unofficial). | `LogSource` port; the Fly impl combines both. | https://fly.io/docs/monitoring/logs-api-options/ |
| Separate orgs per environment are recommended; 6PN and billing are per org. | One Fly org per deployment. Everything a deployment runs lives in its org. | https://fly.io/docs/blueprints/staging-prod-isolation/ |
| Fly never exposes TLS keys. UDP needs a dedicated IPv4 bound to `fly-global-services`; WebTransport on UDP 443 works. | The realtime process terminates its own TLS: a pinned self-signed cert, or ACME DNS-01 on an A-only hostname. | https://fly.io/docs/networking/udp-and-tcp/ · community.fly.io/t/…/8753 |
| mc-router: routes file JSON (`mappings`, `default-server`) with watch mode. The webhook scaler applies to file *and* API routes, and its reply may override the backend. Connect/disconnect webhooks carry the client-claimed `player{name,uuid}`. Hostnames are lowercased, with trailing dot and Forge `\0FML` stripped. | Edge agent writes the routes file. Edge player identity is a *hint*; RCON `list` is authoritative. | https://github.com/itzg/mc-router (source at a9d1d96) |
| Better Auth: `trustedOrigins` supports wildcards and functions; `oAuthProxy` handles previews with one registered callback; its docs recommend a reverse proxy for cross-domain setups. Vercel external rewrites proxy server-side (120 s cap; upstream caching on by default for new projects). | Same-origin proxy for all browser→API traffic. `Cache-Control: no-store` on API responses. | https://www.better-auth.com/docs/concepts/cookies · https://www.better-auth.com/docs/plugins/oauth-proxy · https://vercel.com/docs/limits |
| `*.localhost` resolves via the macOS system resolver and systemd-resolved. nip.io (`x.127.0.0.1.nip.io`) is the portable fallback. The handshake carries the typed hostname. | Local play domain `play.localhost`, fallback `127.0.0.1.nip.io`. | https://nip.io/ · minecraft.wiki SLP |
| Transport.io: rooms are per process ("two machines is a silent split"). A cert rotation restarts the process and drops sessions. WebTransport requests carry no cookies. | Realtime is a **singleton process role**. Events travel between processes via Postgres `NOTIFY`. Tickets in the query string. | transport-io `guides/deploy.md`, `guides/certificates.md` |

---

## 3. System overview

```
 Browser ──HTTPS──► Web (Next.js, Vercel) ──rewrite /api/*──► control:api ─────┐
    │                                                                          │
    └──WebTransport (ticket)──────────────────────────────► control:realtime   │   Postgres
                                                              ▲  LISTEN        │   (domain, pg-boss,
 Minecraft client ──TCP──► Edge (mc-router + edge-agent) ─────┼── edge protocol ┤    NOTIFY bus)
                              │  (6PN)                        │                │
                              ▼                          control:worker ───────┘
                       Game runtime (per server)  ◄── MinecraftRuntime adapter (Fly | Docker | Boat | Fleet | Fake)
```

**Processes.** One codebase (`apps/control`) runs in three roles, selected by `ROLES`, a
comma-separated list:

| Role | Scales | Does |
|---|---|---|
| `api` | horizontally | tRPC, Better Auth, edge-protocol endpoints (internal listener), billing webhooks |
| `worker` | horizontally | pg-boss workers: operations, schedules, reconciliation |
| `realtime` | **exactly one** | Transport.io server: LISTENs to events, tails logs for watched servers |

In local development all three run in one process. On Fly, `api` and `worker` are process
groups of the control app, and `realtime` is an app of its own, the only one with the UDP
service (§13).

**Layers inside `apps/control`.**

```
interfaces/   inbound adapters: trpc, edge protocol, billing webhooks, realtime server
    ↓ call one method on
app/          application services, operations (workers), policy, queries, ports
    ↓ uses                           ↓ implemented by
domain/       pure Minecraft model    infra/  outbound adapters: fly, docker, boat, fleet, fake,
minecraft/    pure Minecraft → RuntimeSpec translation          modrinth, s3, polar, pg, mc-protocol
config/       DeploymentConfig schema + PlayAddressing impl
main.node.ts  composition root (no DI container)
```

---

## 4. Domain model

```
Account ─ User (Better Auth) + AccountStanding + Entitlements(derived) + BillingSubscription?
 └─ MinecraftServer                                 aggregate root
     ├─ slug: Slug                                  owned identity; the address is derived
     ├─ regionKey: RegionKey                        desired placement (product region)
     ├─ memoryTier: MemoryTier                      desired size (product promise)
     ├─ status / stopReason / failure               lifecycle state machine (§10)
     ├─ desiredRevision ──► ServerRevision[]        immutable BOOT configuration
     │                        ├─ GameVersion, Loader
     │                        ├─ ServerSettings     boot-applied properties only
     │                        └─ PinnedMod[]        frozen facts + ModArtifact (durable ref + sha512)
     ├─ ServerAccess                                LIVE administration: whitelist, operators, player bans
     ├─ activeWorld ──► World[]                     generation identity + level name
     ├─ ServerRuntime                               infrastructure binding (opaque handle)
     │    └─ applied { revisionId, worldId, memoryTier, regionKey, specDigest }
     ├─ ServerOperation[]                           async work, auditable
     ├─ Backup[]                                    snapshot (fast, provider) | archive (durable)
     ├─ PublicListing?                              owner intent + moderation; eligibility derived
     └─ usage: PowerInterval[]                      facts for quotas and billing

Shared, outside any server aggregate:
  StoredArtifact     content-addressed bytes in ArchiveStore (custom uploads, optional mirror)
  CatalogRecord      cached, dynamic catalog state of a project/version (refreshed; never authored)
  TrustedModProject  the mods Blockly vouches for
  CuratedRelease     one release of a pack Blockly offers by name, as ingestion checked it
                     (docs/modpack-templates.md); a server's PinnedModpack names it `key@version`
```

**Three kinds of server state.** This classification decides where every future setting goes.

| Kind | Examples | Owner | Lives in | Changed by | A restore… |
|---|---|---|---|---|---|
| **Boot configuration** | version, loader, mods, difficulty, default gamemode, PvP, view/simulation distance, max players, MOTD, spawn protection | Blockly | `ServerRevision` (immutable) | new revision + `apply`: a restart, except for settings a running game takes by command (difficulty, default gamemode, PvP from 1.21.9) or shows from its next start (MOTD), `minecraft/settings.ts` | may roll config back (the existing offer) |
| **Server administration** | whitelist on/off, whitelist, operators, player bans | Blockly's record, with in-game operators as a second writer | `ServerAccess` (Postgres) and the server's JSON files | `AccessService` over RCON, live; in-game commands, imported | **never rewinds it** |
| **World state** | blocks, `level.dat`, gamerules, inventories | the game | the volume | gameplay, console | rewinds it: that is what a restore is |

Rule: Blockly models live state **only when the product needs a record that is independent of
the volume**. Access needs one. It's shown and edited while the server is stopped, and it
must survive a restore. Gamerules don't; they belong to the world and are edited through the
console.

### Value objects

| Type | Rules | Notes |
|---|---|---|
| `Slug` | DNS label: `[a-z0-9-]`, 3–40 chars, no leading or trailing hyphen, not reserved | The only addressing state persisted. A generic reserved list (`www`, `api`, `admin`, `status`, `play`, …) lives in the domain. |
| `RegionKey` | Non-empty string, validated against `RegionCatalog` at the service boundary | The product meaning ("Frankfurt") comes from config. The provider meaning (`fra`) comes from the adapter. |
| `MemoryTier` | `'3g' \| '4g' \| '6g' \| '8g' \| …` | A product promise. The entitlement caps which tiers a plan may use. 3 GB is the smallest sold (the capacity research OOM-killed 2 GB); servers on a size a plan sold before keep running on it (`legacyMemoryTiers`). |
| `GameVersion` | e.g. `1.21.8`, `26.1` | Validated against the loader/version catalog. |
| `Loader` | `vanilla \| paper \| fabric \| quilt \| neoforge \| forge` + `loaderVersion` | Plain Minecraft (`vanilla`) with a `loaderVersion` runs on that Paper build (`runsOnPaper`): what a new plain server made from nothing or a template gets where Paper has a stable build for its release. Its owner sees "Vanilla on Paper" and can switch to Mojang's own server under Advanced. Revisions made before keep `null`, Mojang's own. |
| `ServerSettings` | difficulty, defaultGameMode, pvp, viewDistance, simulationDistance, maxPlayers, motd, spawnProtection | Re-applied at every boot: from the image's variables, and PvP from 1.21.9 by `gamerule pvp`, since the game keeps it in the world and ignores the property. `onlineMode=true` and `enforceWhitelist=true` are constants of the Minecraft layer, not settings. |
| `PlayerRef` | `{ uuid, name }` | UUID is the identity. The name is display data, refreshed from Mojang when delivering commands. |
| `ModSource` | `{ catalog: CatalogId; projectId; versionId }` or `{ catalog: 'upload'; uploadId }` | Provider-neutral identity. The catalog id is data, not a type dependency. |
| `ArtifactRef` | `{ kind: 'remote'; url }` or `{ kind: 'stored'; key: StoredArtifactKey }` | **Durable** references only. `remote` is a permanent public URL issued by a catalog. `stored` is a content-addressed object in `ArchiveStore`. Temporary URLs never appear here (§15.2). |
| `ModArtifact` | `{ ref: ArtifactRef; sha512; sizeBytes; fileName }` | `sha512` is the identity of the bytes. It is verified at ingest and on disk after boot. |
| `PinnedMod` | `{ source, name, versionLabel, artifact, environment, loaders, gameVersions, origin: 'user'\|'dependency', requiredBy[] }` | **Frozen facts** as of resolution: identity, bytes, and why the mod is present. Catalog status and allowlist membership are *not* here; they're dynamic (§15.3). `environment`: `server \| both`. Client-only mods are rejected at resolution. |
| `CatalogState` | project: `approved \| archived \| unlisted \| withheld \| absent`; version: `listed \| archived \| unlisted \| absent` | Normalized from the catalog. `absent` = the public API omits it (deleted, rejected, private, draft); Modrinth doesn't distinguish these for anonymous clients. |
| `Trust` | `vanilla \| catalog_trusted \| untrusted` | **Derived**, never stored on the revision (§15.3). |

### Entities

**MinecraftServer** (aggregate root). Fields:
- `ownerId`, `name`, `slug`, `regionKey`, `memoryTier`
- `description`, `icon`, `tags`, `inviteCode` and `expiresAt` (§15.6); `lastActiveAt` and
  `storedAt` (§15.5 stored worlds)
- `status`, `stopReason` (`user | idle | policy | entitlement | crash | maintenance | session_cap`), `failure`
- `desiredRevisionId`, `activeWorldId`
- `version` (monotonic; optimistic concurrency and event ordering)
- `deletedAt`, `purgeAfter`

It holds **no hostname, no provider identifiers and no player counts.**

**ServerRevision** (immutable). Holds a per-server `number`, `gameVersion`, `loader`,
`loaderVersion`, `settings`, `mods: PinnedMod[]`, `reason`
(`created | mods_changed | settings_changed | version_changed | rollback | restore`),
`basedOnRevisionId` and `createdBy`. Installing, removing or upgrading a mod, changing
settings, upgrading the version, or rolling back all create a revision. Nothing edits one.
Access changes never create a revision.

A revision is reproducible indefinitely. Every artifact is a durable reference plus a
sha512, and nothing in it expires. The availability guarantees are in §15.2.

**ServerAccess** (1:1 with server, mutable).
- `whitelistEnabled`, plus a pending value while undelivered
- entries: `whitelist | operator | ban`, each keyed by player UUID, with
  - `state: active | pending_add | pending_remove | rejected`
  - `origin: blockly | game`
  - observed details: op level, ban reason, source, expiry
- `reseedRequired`: true when the volume's files can't be trusted, i.e. a fresh volume or a
  restored one
- `syncedAt`, `syncError`, `version`

It is Blockly's durable record of the server's administration state. The algorithm is in §15.1.

**World.** Holds `levelName` (the directory on the data volume; a Minecraft concept), `seed`,
`levelType`, `hardcore` and `generatedOnVersion`.
- `levelType` is one of the four a person picks when creating a world (normal, superflat, large
  biomes, amplified), or `blockly:void`, which only templates make: vanilla's superflat preset
  "The Void", nothing but the small start platform, as the base for islands and arenas
  (`minecraft/worlds.ts`).
- A server has one *active* world.
- "New world" creates a World with a fresh `levelName` and switches `activeWorldId`, which
  applies with a restart.
- Old world directories are removed by a `prune_worlds` maintenance operation unless a backup
  or the user keeps them.

**ServerRuntime** (1:1 with server, infrastructure binding). Fields:
- `provider` (which adapter issued the handle)
- `handle` (opaque)
- `placement` (`{ regionKey }`, the *actual* region)
- `applied` (`{ revisionId, worldId, memoryTier, regionKey, specDigest }`, what the runtime
  last booted successfully)
- `observed` (`{ state, at, detail }`, the last observation)

The application compares desired values (server + desired revision) with `applied` to know
what an operation must do. It never looks inside `handle`.

**ServerOperation.**
- `kind` (§9) and `status` (`queued | running | succeeded | failed | cancelled`)
- `input`, `requestedBy` (`user:<id> | system:<reason> | admin:<id>`)
- `idempotencyKey`, `progress`, `error`

It is the domain's record of async work. The pg-boss job id equals the operation id.

**Backup.**
- `worldId`, and `revisionId` (what was applied at capture, so restore can offer to roll back
  config as well)
- `tier: snapshot | archive`
- `trigger: scheduled | pre_apply | pre_restore | pre_relocate | manual | uploaded | stored`
- `status`, `sizeBytes`, `expiresAt`
- Snapshots carry an opaque `snapshotHandle` issued by the runtime. Archives carry an
  `archiveKey` issued by the `ArchiveStore`.

**PublicListing.** Three concerns that are easy to confuse, and are kept apart:
- **Owner intent:** `visibility: published | unpublished` (`draft` is still in the enum and no
  longer written), and `copyable`, whether others may make a server like it (§15.6). What the
  directory and a shared page show, the server's name, `description`, `icon` and `tags`, lives on
  the server itself.
- **Moderation (admin decision):** `moderation: clear | removed`, `moderationNote`.
- **Eligibility (derived):** a pure function of the applied revision, the allowlist, the
  catalog cache, standing and entitlement. It is materialized on the row as a read model:
  `eligible`, `ineligibleReasons`, `evaluatedRevisionId`, `evaluatedAt` (§15.3).

A listing is visible when all of these hold: `published`, `clear`, `eligible`, and the
platform switch is on. A listing that becomes eligible again reappears without the owner
re-publishing, because their intent never changed. Player count is joined from presence at
read time.

**StoredArtifact** (shared, content-addressed). `sha512` (the identity), `key` (issued by
`ArchiveStore`), `sizeBytes`, `source: upload | mirror | built | curated` (a pack rebuilt from an
upload; Blockly's copy of a curated release, §15.2), `verifiedAt`. Blobs are shared across
servers and deleted only when no revision of a non-purged server references them. A `ModUpload`
(owner, file name, upload time) points at one.

**CatalogRecord** (shared cache of dynamic external facts, per project and per version):
`state: CatalogState`, `fetchedAt`, `stateChangedAt`, `absentStreak`. Never authored by
users. Refreshed by `CatalogSync` (§15.3).

**TrustedModProject** (the mods Blockly vouches for): `(catalog, projectId)`, `addedBy`, `note`,
`displayName`.

**PowerInterval.** Holds `serverId`, `memoryTier`, `startedAt` and `stoppedAt`. These are
persisted **facts**, used for free-tier hour quotas, abuse detection and usage-based billing.
They can't be reliably reconstructed from the provider.

**AccountStanding.**
- `status: active | suspended | terminated`, `reason`
- `restrictions: { provisioning?, publicListing?, consoleCommands? }`
- `limitOverrides`

**BillingSubscription.** Holds `provider` (`polar`), `externalCustomerId`,
`externalSubscriptionId`, `planKey`, `status` and `currentPeriodEnd`. Written only by the
billing webhook sync. `Entitlements` are derived from it, falling back to the free plan.

**Entitlements** (derived, never stored; the whole table is `domain/account/entitlements.ts`):
- `monthlyPriceCents`, `maxServers`, `maxRunning`, `allowedMemoryTiers`, `legacyMemoryTiers`
- `includedUnits` (hours of play a month, a large size counting two; or unlimited), `mayBuyMore`
  (extra hours past them; off until billing meters them end to end), `idleShutdownAfter` (or `never`)
- `playerIdleKickMinutes` (Minecraft's own AFK kick), `mayChooseAfkKick`, `maxSessionMinutes`
  (null on every plan; an admin override only), `worldRadius` (the world border's largest radius)
- `allowedLoaders`, `mayUseMods`, `settingCaps { maxPlayers, viewDistance, simulationDistance }`
  (or none), which a revision is checked against when it is made
- `backupPolicy { snapshotsKept, archiveEnabled, archiveRetentionDays, downloadsPerDay }`
- `storage { startGb, mostGb, paidForGb }`, `storeAfterIdleDays`, `deleteAfterIdleDays`
- `mayListPublicly`, `mayUploadCustomMods`, `trashRetentionDays`

A plan's values change on their own timetable: nothing restarts, a server above a new limit keeps
running and starting, and the limit reaches it at its next start or change (§9 `session-check`,
§7 plan limits).

Entitlements are plan facts only. They never encode what a deployment supports.
`DeploymentCapabilities` does that (§15.4), and a feature is usable only when both allow it.

**PlatformControls** (singleton):
- kill switches `provisioningEnabled`, `startsEnabled`, `publicListingEnabled`, `uploadsEnabled`
- global caps `maxServers`, `maxRunningServers`
- changed by admins on Admin → Platform (under the capacity lock, audited with each field's
  before and after); the policy reads them on every check, the directory at read time.

**Moderation.** `ListingReport` (reporter, listing, reason, status) and an append-only
`AuditEntry` (actor, action, subject, data), used for admin actions, console commands and
standing changes.

### Ownership and lifecycle rules
- Every mutation of a server or its children goes through `MinecraftServerService` or a
  sibling service in `app/servers`. Workers change state only through the same persistence
  functions and state machine.
- `desiredRevisionId` moves on request. `runtime.applied.revisionId` moves only after the
  runtime boots that revision and passes the readiness probe.
- A runtime belongs to one server and is never shared. `relocate` and `restore` produce a new
  handle for the same runtime row.
- Deletion is soft (`deleted`, restorable until `purgeAfter`). Purge destroys provider
  resources and snapshot backups. Archives follow their own retention.
- Slugs of deleted servers are **quarantined** for 30 days before reuse (§19).
- `ServerAccess` belongs to the server, not to a world, revision or runtime. Switching worlds,
  applying revisions, relocating and restoring all keep it.
- A `StoredArtifact` is never deleted while any revision of a non-purged server references
  it. Custom uploads and mirrored copies share this rule.
- Nothing persisted holds a URL that expires. Presigned URLs exist only inside one HTTP
  response or one operation.

---

## 5. Persistence (Drizzle/Postgres)

The tables:

```ts
// ── minecraft_servers: placement and size intent, trash, no hostname ─────────
regionKey: text('region_key').notNull(),                 // product region, validated by RegionCatalog
memoryTier: text('memory_tier').notNull(),
description: text('description').notNull().default(''),  // what a shared page and the directory show (§15.6)
icon: text('icon'), tags: text('tags').array().notNull().default([]),
inviteCode: text('invite_code').notNull(),               // the invite link's secret half (§15.6)
expiresAt: ts('expires_at'),                             // a server made for a while (§15.6)
purgeAfter: ts('purge_after'),
// removed: nothing hostname-shaped ever existed here; keep it that way (boundary check, §17)

// ── retired_slugs: hijack protection ────────────────────────────────────────
export const retiredSlugs = pgTable('retired_slugs', {
  slug: text('slug').primaryKey(),
  serverId: uuid('server_id').notNull(),
  retiredAt: ts('retired_at').notNull(),
  availableAfter: ts('available_after').notNull(),
})

// ── server_runtimes: provider-neutral binding ───────────────────────────────
export const serverRuntimes = pgTable('server_runtimes', {
  serverId: uuid('server_id').primaryKey().references(() => minecraftServers.id),
  provider: text('provider').notNull(),                  // adapter id that issued `handle`
  handle: text('handle'),                                // opaque; null until first resource exists
  placementRegionKey: text('placement_region_key'),      // actual product region
  applied: jsonb('applied').$type<AppliedConfig | null>(),
  observed: jsonb('observed').$type<{ state: ObservedState; at: string; detail?: string } | null>(),
  ...audit,
})
// removed: ref{app,volumeId,machineId}, privateAddress (both derivable from the handle by its adapter)

// ── server_revisions: neutral mods, no stored trust ─────────────────────────
mods: jsonb('mods').$type<PinnedMod[]>().notNull().default([]),
basedOnRevisionId: uuid('based_on_revision_id'),
// removed: trust (derived from mods + allowlist + catalog cache, §15.3)
// index for moderation queries: GIN (mods jsonb_path_ops)

// ── worlds ──────────────────────────────────────────────────────────────────
levelName: text('level_name').notNull(),                 // unique per server

// ── backups ─────────────────────────────────────────────────────────────────
export const backups = pgTable('backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => minecraftServers.id),
  worldId: uuid('world_id').notNull().references(() => worlds.id),
  revisionId: uuid('revision_id').notNull().references(() => serverRevisions.id),
  tier: text('tier').notNull(),                          // snapshot | archive
  trigger: text('trigger').notNull(),
  status: text('status').notNull(),                      // pending | ready | failed | expired | deleted
  snapshotHandle: text('snapshot_handle'),               // opaque, runtime-issued (tier=snapshot)
  archiveKey: text('archive_key'),                       // opaque, ArchiveStore-issued (tier=archive)
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  expiresAt: ts('expires_at'),
  createdAt: ts('created_at').defaultNow().notNull(),
}, (t) => [
  check('backups_handle_only_on_snapshots', sql`${t.tier} = 'snapshot' or ${t.snapshotHandle} is null`),
  // a snapshot that failed records the attempt without a handle
  check('backups_ready_snapshot_has_handle',
    sql`${t.tier} <> 'snapshot' or ${t.status} in ('failed', 'deleted') or ${t.snapshotHandle} is not null`),
])

// ── server access: live administration (§15.1) ──────────────────────────────
export const serverAccess = pgTable('server_access', {
  serverId: uuid('server_id').primaryKey().references(() => minecraftServers.id),
  whitelistEnabled: boolean('whitelist_enabled').notNull(),
  whitelistEnabledPending: boolean('whitelist_enabled_pending'),   // null = nothing to deliver
  reseedRequired: boolean('reseed_required').notNull().default(true), // true until the first boot syncs
  syncedAt: ts('synced_at'),
  syncError: text('sync_error'),
  version: integer('version').notNull().default(0),
})

export const accessList = pgEnum('access_list', ['whitelist', 'operator', 'ban'])
export const accessEntryState = pgEnum('access_entry_state', ['active', 'pending_add', 'pending_remove', 'rejected'])

export const serverAccessEntries = pgTable('server_access_entries', {
  serverId: uuid('server_id').notNull().references(() => minecraftServers.id),
  list: accessList('list').notNull(),
  playerUuid: uuid('player_uuid').notNull(),
  playerName: text('player_name').notNull(),                   // display; refreshed on delivery and import
  state: accessEntryState('state').notNull(),
  origin: text('origin').notNull(),                            // blockly | game
  details: jsonb('details').$type<{ level?: number; reason?: string; source?: string; expiresAt?: string }>().notNull().default({}),
  error: text('error'),
  requestedBy: text('requested_by'),                           // user:<id> | admin:<id>; null when imported
  updatedAt: ts('updated_at').defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.serverId, t.list, t.playerUuid] })])

// ── artifacts (§15.2) ───────────────────────────────────────────────────────
export const storedArtifacts = pgTable('stored_artifacts', {
  sha512: text('sha512').primaryKey(),                         // content address
  key: text('key').notNull(),                                  // opaque, ArchiveStore-issued
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  source: text('source').notNull(),                            // upload | mirror | built | curated
  verifiedAt: ts('verified_at').notNull(),
  createdAt: ts('created_at').defaultNow().notNull(),
})
// mod_uploads(id, owner_id, sha512 → stored_artifacts, file_name, loader_metadata jsonb, created_at)

// ── catalog cache (§15.3): only the tracked set, only trust-relevant fields ──
export const catalogProjects = pgTable('catalog_projects', {
  catalog: text('catalog').notNull(),
  projectId: text('project_id').notNull(),
  state: text('state').notNull(),                              // approved|archived|unlisted|withheld|absent
  absentStreak: integer('absent_streak').notNull().default(0),
  fetchedAt: ts('fetched_at').notNull(),
  stateChangedAt: ts('state_changed_at').notNull(),
}, (t) => [primaryKey({ columns: [t.catalog, t.projectId] })])

export const catalogVersions = pgTable('catalog_versions', {
  catalog: text('catalog').notNull(),
  versionId: text('version_id').notNull(),
  projectId: text('project_id').notNull(),
  state: text('state').notNull(),                              // listed|archived|unlisted|absent
  absentStreak: integer('absent_streak').notNull().default(0),
  fetchedAt: ts('fetched_at').notNull(),
  stateChangedAt: ts('state_changed_at').notNull(),
}, (t) => [primaryKey({ columns: [t.catalog, t.versionId] })])

// ── public listings: intent, moderation, materialized eligibility ───────────
export const publicListings = pgTable('public_listings', {
  serverId: uuid('server_id').primaryKey().references(() => minecraftServers.id),
  visibility: text('visibility').notNull().default('unpublished'), // published | unpublished (owner; draft no longer written)
  moderation: text('moderation').notNull().default('clear'),   // clear | removed                   (admin)
  moderationNote: text('moderation_note'),
  copyable: boolean('copyable').notNull().default(true),       // owner offers copies (§15.6)       (owner)
  eligible: boolean('eligible').notNull().default(false),      // read model, recomputable (§15.3)
  ineligibleReasons: jsonb('ineligible_reasons').$type<IneligibleReason[]>().notNull().default([]),
  evaluatedRevisionId: uuid('evaluated_revision_id'),
  evaluatedAt: ts('evaluated_at'),
  ...audit,
}, (t) => [index('listings_browse').on(t.updatedAt).where(sql`${t.visibility} = 'published' and ${t.moderation} = 'clear' and ${t.eligible}`)])

// ── presence: derived, disposable ───────────────────────────────────────────
// UNLOGGED: fast, not crash-safe, rebuilt from RCON `list` by reconciliation.
// CREATE UNLOGGED TABLE server_presence (server_id uuid, player_uuid uuid, player_name text,
//   source text /* edge|rcon */, seen_at timestamptz, PRIMARY KEY (server_id, player_uuid));
// CREATE UNLOGGED TABLE server_activity (server_id uuid PRIMARY KEY, last_player_at timestamptz);

// ── facts, billing, moderation ──────────────────────────────────────────────
// power_intervals(id, server_id, memory_tier, started_at, stopped_at)   index (server_id, started_at)
// billing_subscriptions(user_id, provider, external_customer_id, external_subscription_id unique,
//                        plan_key, status, current_period_end, updated_at)
// listing_reports(id, server_id, reporter_id, reason, status, created_at)
// trusted_mod_projects(catalog, project_id, display_name, added_by, note, created_at)  pk (catalog, project_id)
// audit_log(id, actor, action, subject_type, subject_id, data jsonb, at)
```

`server_revisions.mods` keeps its jsonb shape with the new `PinnedMod`/`ModArtifact`. The
existing GIN index (`jsonb_path_ops`) answers "which revisions reference project X, version X,
or sha512 X". That query drives catalog revocation, eligibility re-evaluation and artifact GC.

**What is deliberately *not* persisted:**

| Derived value | Derived from |
|---|---|
| Hostnames and addresses | slug + `PlayAddressing` |
| Edge routes and their version | Computed per poll, ETag = hash |
| Provider identifiers, private addresses | handle, by its adapter |
| Revision trust | Mods + allowlist + catalog cache |
| Entitlements | Plan / subscription |
| Deployment capabilities | Wiring (which ports exist) |
| Artifact download URLs | Stable links: HMAC. Presigned: minted per fetch |
| Current player counts | Presence tables, which are themselves disposable |

**What is persisted though it looks derivable:**
- **Power intervals.** Provider history is incomplete.
- **Observed runtime state.** Reconciliation needs the previous observation to detect
  transitions such as a crash.
- **Listing eligibility.** A read model, so browsing is an indexed filter. It is recomputed by
  explicit triggers plus a daily sweep, and can always be rebuilt from local tables.
- **Catalog state.** External facts that can't be re-derived offline. Only the tracked set is kept
  and only the trust-relevant fields.
- **Access entries.** The only copy that survives a volume replacement.

---

## 6. Application layer

The call path is unchanged:

```
tRPC procedure (parse input, get actor, call ONE method, return)
  → MinecraftServerService.x(actor, input)                 decide, policy.check, persist, enqueue — one tx
      → ServerOperation (+ its job via JobQueue, same tx; NOTIFY event, delivered on commit)
          → worker: its handler in operations/handlers.ts  re-validate, execute via ports, persist, emit
              → MinecraftRuntime | ServerConsole | ArchiveStore | …
                  → FlyRuntime | DockerRuntime | BoatRuntime | FleetRuntime | FakeRuntime
```

**Services (`app/`), all concrete classes, constructed by `composeControlPlane`
(`app/control-plane.ts`), which `main.node.ts` calls:**

| Service | Methods |
|---|---|
| `MinecraftServerService` | `createMinecraftServer`, `suggestAddress`, `start`, `stop`, `stopForMaintenance` (admin), `restart`, `retry`, `relocate`, `relocateForPlatform`, `deleteServer`, `terminate`, `undeleteServer`; `saveIdentity` (name, description, icon, tags), `changeAddress`, `resetInvite`, `keep` (a server made for a while, §15.6), `keepWorld` (§15.5 retention) |
| `SetupService` | `setupFrom`, `resolve` (what a new server runs, §15.6), `checkPacks`, `unchecked`, `checkBrowsed` (`pack-checks`), `pinnedPack` |
| `ModService` | `search`, `versions`, `plan` / `apply` (a mod change, resolved as one set by `domain/mods/resolve.ts`, the catalog states it saw written through to the cache), `planVersion` / `changeVersion`, `resolveNew` (for a server not made yet); `beginUpload` / `finishUpload` (presigned PUT → verify sha512 and jar → `StoredArtifact` + `ModUpload`), `deleteUpload` |
| `PackService` | packs people bring (docs/modpack-system.md): `beginUpload` / `finishUpload`, `runImport` / `importGaveUp` (the `pack-import` job), `view`, `pinnedFrom`, `linkOf`, `versions`, `updateFor`, `server` |
| `RevisionService` | `changeSettings`, `changeAuthentication`, `changeVersion`, `changeMods`, `changePack`, `resize`, `rollback` (each refuses taken-down artifacts without an explicit acknowledgement, §15.3) |
| `WorldService` | `createWorld`, `switchWorld`, `deleteWorld` (its directories go by `prune_worlds`) |
| `AccessService` | `add`, `remove` (a whitelist, operator or ban entry), `setWhitelistEnabled`, `refresh` (persist pending + enqueue `access_sync`; never a revision, never a restart) |
| `BackupService` | `createBackup`, `restoreBackup`, `archiveBackup`, `downloadArchive`, `deleteBackup`, `beginWorldUpload` / `finishWorldUpload` (a download brought back, §15.5) (archive methods need the archives capability) |
| `ConsoleService` | `run` (synchronous, audited, via `ServerConsole`; refuses `ban-ip`/`pardon-ip`, §15.1) |
| `ListingService` | `setPublic`, `setCopyable`, `report`, `moderate`, `dismissReport`, `trustProject` / `untrustProject` (the allowlist), `catalogMoved`, `sweep`, `reevaluate(serverIds)` (materializes the read model); browsing is `ListingQueries.browse` |
| `SharingService` | `joinThroughInvite` (§15.6); the pages themselves are `SharingQueries` |
| `GuestbookService` | `star`, `notes`, `addNote`, `deleteNote` (stars and short notes on public servers) |
| `ArtifactService` | `preflight(revision)`, `pinned`, `mirror(sha512)`, `locate(serverId, sha512, token)` (runtime-facing), `source`, `refresh`, `collectGarbage` |
| `CatalogSync` | `refresh()` (bulk state poll → transitions → eligibility re-evaluation), `recordObserved(states)` (write-through from resolution) |
| `PackCuration` | `queueDue`, `ingest` (fetch, verify, judge licences, keep a copy where allowed), `publish` / `withdraw` / `retry` (admins), `offered`, `releaseFor`, `newerFor` (docs/modpack-templates.md) |
| `EdgeService` | `routes`, `wake`, `idleHint`, `recordSession` (the edge protocol's application side) |
| `AccountService` | `suspend`, `reinstate`, `terminate`, `setRestrictions`, `setPlan`, `setLimits`, `grantAdmin`, `revokeAdmin` (admin actors only; each audited); the owner's own `allowExtraPlay`, `setAfkKick`, `recordSource`; `enforce` (`standing-sweep`) |
| `BillingService` | `startCheckout`, `customerPortal`, `refresh`, `receiveWebhook` → `syncSubscription` |
| `PlatformControlsService` | `view`, `set` (kill switches and caps), `refreshCatalog` (admin) |
| `RuntimePlacement` | which runtime a new server goes to, and the rules and moves operators steer it by (docs/runtimes.md) |

**Admins.** An admin is an account with a `platform_admins` row. The first come from
`ADMIN_EMAILS`: an account whose email is listed becomes an admin once the email is confirmed,
and stops being one when it is taken off the list. Admins can make others admins. tRPC's
`adminProcedure` turns a signed-in admin into an `admin:<id>` actor and answers anyone else as
if nothing were there.

**Queries** (`app/**/queries.ts`) return view models. A view is where derived data is joined
in: `joinAddress` from `PlayAddressing`, `trust` from mods + allowlist + catalog cache, `online`
from presence.

### Ports (`app/ports/`): only where there's a real external boundary

| Port | Implementations | Why it exists |
|---|---|---|
| `MinecraftRuntime` | `FlyRuntime`, `DockerRuntime`, `BoatRuntime`, `FleetRuntime`, `FakeRuntime` | provider isolation; local dev; Boat's sandboxes ([runtimes.md](runtimes.md), [boat-runtime-plan.md](boat-runtime-plan.md)); Blockly's own hosts ([fleet.md](fleet.md)); tests |
| `ServerConsole` | `RconConsole` (infra/mc-protocol), `BoatConsole` (through Boat's command endpoint), fake | RCON is a network protocol; tests |
| `ReadinessProbe` | `SlpProbe` (Server List Ping), `BoatProbe` (through Boat's command endpoint), fake | "ready" is a Minecraft-protocol fact |
| `LogSource` | `FlyLogSource` (NATS live + HTTP history), `DockerLogSource`, `BoatLogSource`, `FleetLogSource`, fake | provider-specific log plumbing |
| `ModCatalog` | `ModrinthCatalog` | Modrinth API isolation; offline tests. Adds `states(projects, versions)`, a bulk state lookup where omitted ids map to `absent` |
| `ArchiveStore` | `S3ArchiveStore` (R2; RustFS locally); **optional** (§15.4) | Durable archives, uploads, mirror. Only generic primitives: `newKey(kind, scope)`, `presignPut(key, ttl, audience, sizeBytes?)`, `presignGet(key, ttl, audience, downloadName)`, `ingestFromUrl(url, sha512) → key`, `ingestFile(path, sha512) → key`, `head`, `delete`. The audience (`runtime` or `browser`) picks the name a link is signed for: one in production, two locally, where containers reach the host's store as `host.docker.internal` |
| `PlayerProfiles` | `MojangProfiles` | Name → UUID validation when adding players (even while stopped), UUID → current name before delivering commands, and UUID → skin for the faces player rows show |
| `EventBus` | `PgNotifyEventBus` | cross-process fan-out without Redis |
| `JobQueue` (`app/ports/jobs.ts`) | `PgBossJobs` (`infra/pg/jobs.ts`) | the queue behind operations and the side queues: `enqueue` joins the deciding transaction, and admins see and settle blocked keys (§9) |
| `BillingProvider` | `PolarBilling` | checkout and portal links, authenticated webhooks (`receive`), a customer's current standing (`stateOf`); Polar's SDK pinned to API version 2026-04 |
| `PlayAddressing` | `ConfiguredPlayAddressing` | deployment-configured addresses |
| `RegionCatalog` | `ConfiguredRegionCatalog` | product regions from config |

`app/ports/` also holds smaller ones: `Locks` (`PgAdvisoryLocks`), `Limits` (§15.6),
`LoaderBuilds`, `FileFormats` and `PackArchives` (reading what people upload), `CurseForge`,
`Mailer`, `RealtimeTickets`, `CertificateIssuer` and `Authenticator`.

These are **not ports**:
- Persistence: plain functions over Drizzle in `app/**/persistence.ts`, tested against real
  Postgres.
- Policy: a concrete module.
- Configuration: a typed object.
- `ArtifactService` and `CatalogSync`: application logic composed from ports, each with one
  implementation.
- `ArtifactLinks`: a pure function built at the composition root, `(serverId, artifact) →
  stable URL`.
- `DeploymentCapabilities`: a record of optional port instances (§15.4).

---

## 7. The Minecraft → runtime translation boundary

```
ServerRevision + World + MemoryTier + RuntimeSecrets + artifactUrl: (ModArtifact) => string
        │                    (worker obtains artifactUrl from ArtifactLinks after ArtifactService.preflight)
        ▼   minecraft/runtime-spec.ts   toRuntimeSpec(input): RuntimeSpec      ← pure, Minecraft-aware;
        │                                  also the image tag, ServerSettings → itzg env (never
        │                                  access state), PinnedMod[] → MODS, a pack, the heap
        │   minecraft/versions.ts        offered releases; the Java each needs (javaFor)
        │   minecraft/settings.ts        how a running server takes each setting (now, next start, restart)
        │   minecraft/jars.ts            where jars go (MODS or PLUGINS) and their on-disk names
        │   minecraft/access.ts          RCON access commands; access-file read command + parsers
        │   minecraft/console.ts         the platform's own console commands + parsers; refused ones
        │   minecraft/install-check.ts   installed-artifact hash command + parser
        ▼
RuntimeSpec (generic: image, env, secrets, resources, storage, ports, stop, labels)
        │
        ▼   app/ports/runtime.ts         MinecraftRuntime
        ▼
infra/fly | infra/docker | infra/boat | infra/fleet | infra/fake   ← provider-aware, knows nothing about Minecraft
```

**The rules, enforced by a boundary check in CI (§17):**
- `domain/` imports nothing outside itself.
- `minecraft/` imports `domain/` and `app/ports/runtime.ts` types only.
- It is the **only** module that knows:
  - itzg env var names, 25565/25575, Java variants, `LEVEL`, `MODS`
  - the `STOP_DURATION` ↔ stop-timeout relation
  - access command syntax and access file names/formats
  - the mods directory and on-disk jar naming
- Its IO-shaped outputs are *descriptions*: command arrays, parsers. Workers execute them
  through ports.
- `infra/fly`, `infra/docker`, `infra/boat`, `infra/fleet` and `infra/fake` import only
  `app/ports/*` types. They must not import `domain/` or `minecraft/`. They do not know what
  Fabric, difficulty or Modrinth are.

**What `toRuntimeSpec` decides (all Minecraft knowledge):**
- **Image.** `itzg/minecraft-server:<pinned release>-java<N>` (`imageFor`), with Java from the
  game version (`javaFor` in `minecraft/versions.ts`): 8 up to 1.16.x, 17 up to 1.20.4, 21 for
  1.20.5–1.21.x, 25 for 26.x. Plain Minecraft (vanilla, no mods, no pack) on Java 21 or 25 runs
  the image's Alpine build, `…-java<N>-alpine`: smaller, and quicker to wake on Boat. Loaders, mods and packs keep the Ubuntu build, for
  the native libraries they bring; Java 8 and 17 have no Alpine build.
- **Env.**
  - Server type and version: `EULA=TRUE`, `TYPE`, `VERSION`, loader version pins.
  - World: `LEVEL=<world.levelName>`, and `SEED`/`LEVEL_TYPE`/`HARDCORE` for a new world. The
    void is `LEVEL_TYPE=minecraft:flat` with the preset's `GENERATOR_SETTINGS`.
  - Datapacks: `BLOCKLY_DATAPACKS`, read by Blockly's own step before the image starts
    (§15.5, Datapacks).
  - Settings: `ServerSettings` → `DIFFICULTY`, `MODE`, `PVP`, `VIEW_DISTANCE`, `MOTD`,
    `MAX_PLAYERS`, `SPAWN_PROTECTION`, `ONLINE_MODE` (true for every new server; its own
    setting, §15.1). Constant: `ENFORCE_WHITELIST=TRUE`.
  - Access: **nothing.**
    - Never `WHITELIST`, `OPS`, `WHITELIST_FILE`, `OPS_FILE` or `ENABLE_WHITELIST`, not even
      empty. An empty string counts as set and triggers the image's user management.
    - So access never enters `RuntimeSpec` or `specDigest`, and an access change can never
      cause an `apply` or a restart.
  - Server type: `TYPE` from the loader; `PAPER` with `PAPER_BUILD` for plain Minecraft on Paper.
    The entrypoint's first step puts the volume's files as the type reads them: on Paper, a pinned
    jar the image already installed starts as `PAPER_CUSTOM_JAR`, with no call to Paper's API (one
    hung a wake on Boat, 2026-10-04); on any other type, `<level>_nether/DIM-1` and
    `<level>_the_end/DIM1` move back into the level directory where a Paper run left them and the
    world has none of its own. Drift doesn't compare that step (`withoutFilesStep`), so it reaches
    a server at its next start.
  - Mods: `MODS=<artifactUrl(a) for each pinned mod>` (`PLUGINS` on Paper).
    - Always emitted, even empty, for loaders with a mods/plugins directory. When `MODS` is
      unset the image skips reconciliation; when it's empty the image removes every managed
      jar.
    - A server that plays a modpack lists none: the image installs the pack itself
      (`TYPE=MODRINTH`, `MODRINTH_MODPACK`; docs/modpack-system.md).
    - `MODRINTH_DOWNLOAD_DEPENDENCIES` stays unset.
  - Plan limits: `PLAYER_IDLE_TIMEOUT` (the owner's `playerIdleKickMinutes`, 0 for none) and
    `MAX_WORLD_SIZE` (`worldRadius`, omitted for none). These come from the plan, not the revision,
    so they are left out of the digest drift compares: a plan change never restarts a server.
  - Memory: `MEMORY=<heap>` (`heapMb`): 75% of the size for a vanilla server and 65% for one
    with mods or a pack, which needs more room outside the heap; from 3 GB up, never more than
    the size less 1024 MB.
  - Shutdown: `STOP_DURATION=60`.
- **Secrets.** `RCON_PASSWORD`. Like the artifact token, it's derived as
  `deriveServerSecret(key, serverId, purpose)` with the current runtime key
  (`runtimeSecrets.current`, §11). Nothing per-server is stored, and rotating the key version
  rotates every server on its next apply.
- **Resources.** `{ memoryMb: memoryMb(memoryTier) }`. CPU class is *not* chosen here.
- **Ports.** `[{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge', 'control'] }, { name: 'rcon', port: 25575, protocol: 'tcp', audience: ['control'] }]`.
- **Stop.** `{ signal: 'SIGTERM', timeoutSeconds: 90 }`, which must exceed `STOP_DURATION`.
- **Storage.** `{ mountPath: '/data', sizeGb }`: the plan's disk, or the larger one the world
  grew into (§15.5 storage).
- **Labels.** `{ 'blockly.server': serverId }`, for inventory. The adapter adds the deployment
  id.

`specDigest(spec)` hashes the spec minus secrets. It is stored in `runtime.applied`, and drift
detection compares digests. Artifact links are stable (no expiry, no per-build nonce), so the
digest of a revision is the same on every build.

---

## 8. `MinecraftRuntime` and the runtime handle

### Choosing the handle representation

| Option | Verdict |
|---|---|
| `{ provider: 'fly', app, volumeId, machineId }` | Leaks Fly into `app/` and the schema. |
| `{ provider, externalId, metadata: Record<string,string> }` | Stringly typed. `externalId` is meaningless for multi-resource runtimes, and consumers *can* read metadata, so eventually they will. |
| Generic `MinecraftRuntime<H>` | The type parameter infects every service and worker, and it doesn't survive the DB column anyway: the value comes back as `unknown` and needs runtime validation regardless. |
| **Opaque branded string issued by the adapter** | ✅ The application can store and pass it but can't inspect it without a cast that review would catch. The adapter validates it on decode (versioned codec, zod). The `provider` column guards against feeding one adapter's handle to another, for example a local dev control plane pointed at a copy of staging data. |

```ts
// app/ports/runtime.ts — the only runtime types app/ ever sees
declare const brand: unique symbol
type Opaque<T, B extends string> = T & { readonly [brand]: B }

export type RuntimeKey = Opaque<string, 'RuntimeKey'>         // stable platform id (the serverId); adapters may embed it in names
export type RuntimeHandle = Opaque<string, 'RuntimeHandle'>   // issued by the adapter; may change on restore/relocate
export type SnapshotHandle = Opaque<string, 'SnapshotHandle'>

export interface Placement { regionKey: string }              // product region key; adapter maps it

export interface RuntimeSpec {
  image: string
  env: Readonly<Record<string, string>>
  secrets: Readonly<Record<string, string>>
  resources: { memoryMb: number }
  storage: { mountPath: string; sizeGb: number }
  ports: readonly PortSpec[]
  stop: { signal: 'SIGTERM' | 'SIGINT'; timeoutSeconds: number }
  labels: Readonly<Record<string, string>>
}
export interface PortSpec { name: string; port: number; protocol: 'tcp' | 'udp'; audience: readonly Audience[] }
export type Audience = 'edge' | 'control'                     // who must be able to reach this port
export interface Endpoint { host: string; port: number }

export type ObservedState = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'unknown'
export interface RuntimeObservation { state: ObservedState; at: Date; exit?: { code: number; oom: boolean } }

export interface ProgressSink {
  step(name: RuntimeStep): Promise<void>                        // 'allocating' | 'storage' | 'compute' | 'booting' | …
  handle(h: RuntimeHandle): Promise<void>                       // persist immediately; orphan-safety
}

export interface MinecraftRuntime {
  readonly provider: string                                      // recorded beside each handle; never branched on
  readonly serverCeiling: number | null                          // most servers it holds, where its provider limits that (§19.12)

  /** Idempotent and convergent: creates whatever is missing for `key`, leaves it started. */
  ensureProvisioned(key: RuntimeKey, placement: Placement, spec: RuntimeSpec, progress: ProgressSink): Promise<RuntimeHandle>
  apply(h: RuntimeHandle, spec: RuntimeSpec): Promise<void>     // new config; restarts if running
  start(h: RuntimeHandle): Promise<void>                         // idempotent
  stop(h: RuntimeHandle): Promise<void>                          // graceful, idempotent
  waitRunning(h: RuntimeHandle, signal: AbortSignal): Promise<void>

  snapshot(h: RuntimeHandle): Promise<{ snapshot: SnapshotHandle; sizeBytes: number; at: Date }>
  /** Which stored snapshots the provider no longer holds, by its own identity; unknown = not gone. */
  goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>>
  /** Replaces storage (and compute, where the provider requires it). Returns the new handle. */
  restore(h: RuntimeHandle, from: RestoreSource, spec: RuntimeSpec, progress: ProgressSink): Promise<RuntimeHandle>
  relocate(h: RuntimeHandle, to: Placement, spec: RuntimeSpec, progress: ProgressSink): Promise<RuntimeHandle>
  exportSnapshot(s: SnapshotHandle, target: UploadTarget): Promise<{ sizeBytes: number; sha256: string }>
  exec(h: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult>  // short maintenance tasks

  decommission(h: RuntimeHandle): Promise<void>                  // remove compute, keep storage + snapshots (soft delete)
  destroy(keyOrHandle: RuntimeKey | RuntimeHandle): Promise<void> // remove everything; 404 = done

  observe(h: RuntimeHandle): Promise<RuntimeObservation>
  observeChanged(since: Date): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle; observation: RuntimeObservation }>
  inventory(): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle }>   // everything tagged with this deployment

  /** Pure: where `audience` reaches `port`, for every handle it issued. May change when the handle does. */
  endpoint(h: RuntimeHandle, port: string, audience: Audience): Endpoint
}

export type RestoreSource = { kind: 'snapshot'; snapshot: SnapshotHandle } | { kind: 'archive'; download: DownloadTarget }
export interface UploadTarget { url: string; headers: Record<string, string> }   // presigned, from ArchiveStore;
export interface DownloadTarget { url: string }                                  // both consumed inside one operation, never persisted
```

This is the shape the port was designed in. `app/ports/runtime.ts` is the contract as it stands,
and says what each member promises, which of them a provider may decline, and how another
runtime is added. `exportSnapshot` now takes an `ArchiveTarget` from `ArchiveStore.archiveTarget`:
one presigned PUT, the most one carries (`maxPutBytes`, R2's 5 GiB less 5 MiB), and `inParts`,
which begins an S3 multipart upload sized for the archive and returns a presigned URL per part,
with `complete` and `abort`. Every runtime sends an archive larger than one PUT in parts: blocklyd
itself, Fly and Docker from their helpers (`dd` of each part into `curl`, its length declared),
Boat from inside its sandbox, and the fleet's copy from the store by ranges. A `restart` operation is the application's own stop and start, with the world
saved between them. The port also has a `restart(h)` of its own, which the sketch above lacks:
boot uses it to start the workload again on the same compute, its handle and endpoint unchanged,
when a boot must start it once more (files fetched again, access to load, a start that hung).

**Why `endpoint` takes an audience.** Reachability is relative to where the caller sits:
- On Fly the edge and the control plane share 6PN, so both audiences get the same endpoint.
- Under Docker locally, the edge container reaches `mc-<key>:<port>` on the compose network,
  but the control plane on the host reaches `127.0.0.1:<published port>`.

Naming the audience keeps that honest without leaking networks into `app/`.

**Why the Fly adapter keeps `endpoint(…, 'edge')` stable across replacement.** Restore and
relocate create a new machine. The Fly adapter returns the app's **Flycast** address,
`<app>.flycast:<port>`, rather than a machine address. The app is stable per server, so the
edge's routes don't churn and need no update on restore.

Stability is a kindness to the edge, not something the application depends on. Routes are
computed from the current handle on every poll, and a wake answers with the destination once the
server is up (§12), so a runtime whose restore or move lands somewhere else, such as another host,
returns the new address and the edge follows within a poll. What every runtime must do is answer
`endpoint` for any handle it issued, a released one included: a resting world keeps its route,
since a join is what wakes it.

The game app lives on its own private network (§19a). The Flycast address is allocated *on
the default network*, so the edge and control plane reach the game server one-way. With
autostart off, a stopped machine stays stopped, but Fly's proxy still takes a connection to it,
and nothing answers. So the edge routes a sleeping server to a notice of its own, and a join goes
through the wake flow, which starts it first (§12).

**Inside `infra/fly` (the only place these words exist):**
- App naming: `bly-<deploymentId>-<key>`, with the key as undashed hex. App create uses
  `idempotency_key = <deploymentId>:<key>` and `network = <app name>`. That is a private 6PN
  of its own, fixed at creation. The only address is a Flycast `private_v6` allocated for
  the org's default network. No public IPs.
- One volume and at most one machine per app, found by listing: list-before-create is the
  idempotency.
- The handle codec (`fly:v1:{app, machineId, volumeId, region}`) and zod decode.
- Placement map `regionKey → fly code`, checked at boot against `/v1/platform/regions`
  (non-deprecated), and capacity via `/v1/platform/placements`.
- Sizing: `memoryMb` → performance CPUs only, as the capacity research found (every shared size
  was throttled and crashed): 1 core up to 3 GB, 2 at 4 GB, 4 from 6 GB, within 2–8 GB per
  CPU, so a 6 GB server runs on 4 cores with 8 GB. A one-shot helper on a volume is 1 shared CPU,
  1 GB. The placement check asks about the same machine the server will run on.
- Machine config:
  - `restart: on-failure` (max 3).
  - One `services` entry per `spec.ports` port, raw TCP, with `autostart: false` and
    `autostop: 'off'`. Flycast needs the block, and power still has a single writer.
  - Leases with a nonce on update/stop, and `stop_config` from `spec.stop`.
- Volumes: `auto_backup_enabled: false`, because the product owns backup scheduling.
  `snapshot_retention` is set to the longest entitlement.
- Restore: new volume from `snapshot_id`, then a new machine on it, then destroy the old
  machine; the old volume goes after the new one is `created`. Returns the new handle.
- Relocate: stop, fork the volume with `source_volume_id` + region, create a machine, wait
  until the fork is `created`, destroy the old one.
- Export: restore the snapshot into a temporary volume, run a one-shot archiver machine
  (generic image: tar `mountPath` → PUT to the upload URL), then destroy both.
- A rate-limited Machines API client (≈1 req/s per action per app, burst 3).
- `observeChanged` over `GET /orgs/{org}/machines?updated_after=` with an overlapping window.
- `inventory` filters by the deployment label, so orphan cleanup can never touch another
  environment's resources.

---

## 9. Operations and jobs

One pg-boss queue, `server-ops`, with policy `key_strict_fifo` and `singletonKey = serverId`.
Operations for one server run strictly in order, and different servers run in parallel. Each
worker:
1. re-reads the server
2. re-validates the transition
3. re-checks policy where it spends money
4. executes through ports
5. persists and emits

| Operation | Triggered by | Does | Final failure |
|---|---|---|---|
| `provision` | create | `preflight` → `ensureProvisioned` → **boot sequence** → `applied` | `failed{provisioning}`; retry / delete |
| `start` | user, wake, admin | policy → `start` → **boot sequence** | `failed{starting}` |
| `stop` | user, idle, policy, entitlement, session cap | import access → `save-all` via console → `stop` | forced stop, then `failed{stopping}` |
| `restart` | user | stop + start | as start |
| `apply` | revision change, world switch, resize | `preflight` → pre-apply snapshot → `apply(spec)` → **boot sequence** → `applied` | auto-rollback to previous applied config once, then `failed{updating}` |
| `relocate` | user region change, region deprecation, host failure | snapshot → `relocate` → **boot sequence** | `failed{relocating}`; original kept until success |
| `backup` | schedule, manual, pre-apply | console `save-off`/`save-all flush` → `snapshot` → `save-on` | backup `failed`; server unaffected |
| `archive` | manual, schedule (if entitled **and** capable) | `exportSnapshot` → `ArchiveStore` | backup `failed` |
| `restore` | user | import access → pre-restore snapshot → `restore(source)` → `reseedRequired = true` → **boot sequence** → new handle | automatic return to the pre-restore snapshot |
| `access_sync` | `AccessService` mutation, owner opens the access page | if running: reconcile access (§15.1); else no-op (pending waits for the next boot) | never fails the key: delivery errors are recorded on the entries and the op succeeds |
| `prune_worlds` | world deletion | `exec` rm of level dirs (command built by `minecraft/`) | retry |
| `decommission` | delete | stop → `decommission` (storage kept) | retry until converged |
| `purge` | `purgeAfter` reached, terminate | `destroy` → delete snapshot backups → server `purged` | retry; alert |

**Boot sequence.** Every operation that ends in `running` shares it, in `app/operations/boot.ts`:

```
waitRunning
  → readiness probe (Server List Ping)
  → verify installed artifacts   one exec: hash the mods dir, compare with the revision (§15.2)
                                 mismatch → delete those files, restart once, then fail the op
  → reconcile access             §15.1; if reseedRequired and delivery fails → fail the op
                                 (the server is stopped: never run with unknown access)
  → status running, routes include it, events emitted
```

**Queues outside the per-server FIFO:**
- `artifact-mirror`: singleton key = sha512. Enqueued when a revision references a remote
  artifact that isn't stored yet, and only if the deployment mirrors (§15.2).
- `listing-eligibility`: input is a set of server ids. Enqueued by apply success, allowlist
  changes, catalog transitions, standing/restriction changes and subscription changes.
- `curation-ingest`: one reviewed release of a curated pack, singleton per `key@version`, enqueued
  by the `curation` schedule (hourly, and as a worker starts) and by an admin's "Check again".
  Downloads are held to the catalog's hosts; a release that fails twice is refused, never left
  pending (docs/modpack-templates.md § Ingestion).
- `pack-import`: one uploaded pack, read and built off the request that sent it, one job per
  upload. It is tried once more after a failure, then its owner is told it couldn't be read
  (docs/modpack-system.md).

**Schedules** (separate queues, `singleton` policy, in `infra/pg/jobs.ts`):
- `reconcile`: `observeChanged` every minute, reading everything on a process's first pass and
  hourly, to detect crashes and OOMs and to stop compute that runs behind a server holding none
  (§15.5).
- `drift`: every minute. A running server whose spec no longer matches what it should run gets an
  `apply`, only while nobody is online, at most 5 a pass (§15.5).
- `relocations`: every minute, at most 3 a pass. A server whose region now maps elsewhere moves
  there (a running one only while nobody plays); one whose host has been lost for 10 minutes is
  rebuilt elsewhere from its newest snapshot; and the moves to another runtime an operator asked
  for are made (docs/runtimes.md).
- `orphans`: `inventory()` hourly; what a purged server left, and what a move left on a runtime
  its server isn't bound to, gets `destroy`. Compute whose server the database doesn't know is
  kept and logged for an operator: after a restore from a backup, that is every server made since.
- `presence-sync`: RCON `list` for running servers every minute.
- `idle-check`: running servers with no players for longer than `entitlements.idleShutdownAfter` → `stop{idle}`.
- `session-check`: a running server on a plan with `maxSessionMinutes` is told in game 10 and 2
  minutes before its current run reaches the cap, each once, then `stop{session_cap}` the ordinary
  way. The owner may start it again at once; `includedUnits` stays the budget. No plan sets a cap;
  it is an admin's per-account override.
- `backup-schedule`: per entitlement. Skips servers with no activity since their last backup,
  and skips the archive tier when the deployment has no archives.
- `purge-sweep`: servers past `purgeAfter`, every 10 minutes. A purge that failed is enqueued
  again once per failure (idempotency key `purge:after:<failed op>`), so it retries until it
  converges; one still undone an hour after its date is an admin alert.
- `expiry-sweep`: every 5 minutes. A server made for a while whose time is up is deleted into the
  trash, as its owner deleting it would (§15.6).
- `standing-sweep`: every minute. Suspended accounts' servers stop and terminated ones' close,
  including any that were mid-way through other work when the standing changed. For the rest it
  warns as a month's play runs out and stops everything once it has; otherwise it stops what the
  plan doesn't run, and the servers started last beyond its running limit (§15.5 billing).
- `usage-close`: closes power intervals for servers seen stopped.
- `store-sweep`: hourly. Servers idle past their plan's days → `store` (§15.5 stored worlds).
- `disk-check`: every 10 minutes. Running servers whose plan grows disks are measured; one that
  needs room now is told in game and restarted onto a bigger disk (§15.5 storage).
- `retention-sweep`: daily. Warns, then deletes Free worlds unplayed for a year (§15.5 retention).
- `catalog-refresh`: hourly bulk state poll of the tracked set (§15.3).
- `pack-checks`: hourly, and as a worker starts. The default modpack list's packs with no
  verdict from the last day are checked the way picking them would be (§15.6).
- `listing-eligibility-sweep`: daily full rebuild of the eligibility read model, to catch
  missed triggers.
- `artifact-gc`: daily. Deletes stored blobs no revision of a non-purged server references,
  after a grace period. Skipped without archives.
- `admin-alerts`: every 5 minutes. Evaluates what needs an admin (blocked keys, overdue
  purges, a catalog that has failed to refresh for 6 h) into `platform_alerts`: raised when first seen and
  emailed to every admin once, cleared when the condition passes, raised and emailed again if
  it returns. The admin pages read the conditions live.
- `provider-tags`: every 10 minutes. Each server's owner, name and plan are written where its
  provider lists its compute, only where they differ, so an operator reading the provider's
  console sees whose machine each is.
- `runtime-upkeep`: every minute. What a runtime keeps tidy behind its port; only the fleet has
  any (docs/fleet.md).

**Idempotency, three layers** (unchanged in principle):
1. `(ownerId, createIdempotencyKey)` unique.
2. `(serverId, idempotencyKey)` unique on operations, with operation id = job id.
3. The runtime's `ensure*` and `destroy` converge.

`start` while starting or running, and `stop` while stopping or stopped, succeed as no-ops.
Wake storms from several edges collapse this way.

**A key blocked by a permanently failed job** is the intended safe default. Admin actions
exist to `retry` or `discard` it, and there's an alert on blocked keys.
- The runner records a final failure itself and completes the job, so a job fails for good
  only when an attempt outlives its deadline (`expireInSeconds`) or recording fails. pg-boss's
  `key_strict_fifo` then holds everything behind it for that server (`getBlockedKeys`).
- `retry` is pg-boss `retry`: the job runs once more, then the queue behind it.
- `discard` settles the operation as the runner settles a final failure (the server leaves
  the phase it was in, the handler's `abandon` runs), then deletes the job.
- An operation's outcome is recorded once: the first `finishOperation` wins, so an attempt
  that hung and returns after a retry or a discard changes nothing.

---

## 10. MinecraftServer state machine

Statuses: `provisioning`, `stopped`, `starting`, `running`, `stopping`, `updating`,
`restoring`, `relocating`, `storing`, `stored`, `failed`, `deleted`, `purged`.

| From | Event | To |
|---|---|---|
| — | create | provisioning |
| provisioning | ready / failed | running / failed |
| stopped | start (policy ✓) | starting |
| starting | ready / failed | running / failed |
| starting | refused: no room where it runs, or no longer allowed when the worker checks again | stopped (`stopReason` idle or policy): back to sleep, and the next join or press tries again |
| running | stop(reason) | stopping → stopped (`stopReason`) |
| running | crashed (reconcile; restart policy exhausted) | stopped (`stopReason=crash`) |
| running | restart | stopping → starting |
| stopped | restart | starting (a start) |
| running | apply / resize / switchWorld | updating → running, or → updating(rollback) → running, or → failed |
| stopped | apply / resize / switchWorld | stopped (desired changes; the next start boots it) |
| running, stopped | restore | restoring → previous power state, or failed |
| failed | restore | restoring → running (stopped where policy refuses the boot), or failed |
| running, stopped | relocate | relocating → previous power state, or failed |
| failed | relocate (a lost host, a remapped region) | relocating → stopped, or failed |
| failed | retry | the phase that failed, again |
| failed | rollback | starting, on the earlier revision |
| any except deleted/purged | delete | deleted (compute decommissioned; restorable) |
| stopped | store (idle past the plan's days, copy verified) | storing → stored (§15.5 stored worlds) |
| stored | start / restart / a join (policy ✓) | restoring (`unstore`) → running, or → stored if the wake fails |
| deleted | undelete (before `purgeAfter`, policy ✓) | stopped, or stored if its world was stored |
| deleted | purge | purged (terminal) |

It is two pure functions in `domain/server/lifecycle.ts`:
- `decide(lifecycle, command)` answers a command (`start`, `stop`, `restart`, `apply`,
  `rollback`, `restore`, `relocate`, `retry`, `delete`, `undelete`) with `accept` (the status to
  move to, and the operation to enqueue, if any), `noop` (already where it leads) or `invalid`.
- `transition(lifecycle, outcome)` applies what a worker reports (`provisioned`, `started`,
  `stopped`, `crashed`, `updated`, `restored`, `relocated`, `restarting`, `failed`, `refused`,
  `storing`, `stored`, `purged`) and throws `InvalidTransition` when it doesn't fit the current
  status.

`ServerTransitions` (`app/servers/transitions.ts`) is the single writer: services accept requests
through `decide`, and workers report through `transition`. A worker runs only while its server is
in a status its operation still makes sense in, and is cancelled otherwise.

Account suspension is **not** a server status. It shows up as `stopped` with
`stopReason = policy`, and as start/wake denial.

---

## 11. Addressing and deployment configuration

### `PlayAddressing`: the only address knowledge `app/` has

```ts
// app/ports/platform.ts
export interface PlayAddress { hostname: string; port: number }

export interface PlayAddressing {
  /** What users are shown and copy. */
  primary(slug: string): PlayAddress
  /** Every address that must route to this server (primary + migration aliases). */
  all(slug: string): readonly PlayAddress[]
  /** Inverse, for edge reports. Normalizes case, trailing dot, port; null if not ours. */
  slugFor(hostname: string): string | null
  /** The play domains, primary first, so an alias's joins can be watched before it goes. */
  domains(): readonly { domain: string; alias: boolean }[]
  domainFor(hostname: string): string | null
}
```

`ConfiguredPlayAddressing` is built from `config.play = { domain, aliases, port }`:
- `primary(s) = { hostname: `${s}.${domain}`, port }`
- `slugFor` strips a known suffix and validates the label

Round-trip tests: `slugFor(primary(s).hostname) === s` for every alias.

Formatting for display (omitting `:25565`) is Minecraft knowledge and lives in
`minecraft/address.ts`. Views return `{ joinAddress: 'slug.<play domain>' }` fully formatted.
The web app never assembles addresses.

### `DeploymentConfig`: parsed once, consumed by the composition root

```ts
// config/schema.ts (zod), read from the environment by config/load.ts. A sketch: a field whose
// schema adds nothing is written by name. Boot fails loudly on invalid or inconsistent values.
export const DeploymentConfig = z.object({
  deploymentId: z.string().regex(/^[a-z0-9-]{2,16}$/),     // tags provider resources, ticket audience, cookie prefix
  roles: z.array(z.enum(['api', 'worker', 'realtime'])).min(1),
  database: z.object({ url, directUrl }),                   // directUrl skips a pooler, for LISTEN and migrations (§13)
  web: z.object({
    canonicalOrigin: Origin,                                // auth baseURL = canonicalOrigin + /api/auth
    trustedOrigins: z.array(z.string()),                    // extra origins/patterns (previews)
  }),
  listen: z.object({ api: HostPort, internal: HostPort }),
  realtime: z.object({
    listen: HostPort, publicUrl: z.url(),                   // WebTransport: what browsers dial
    fallbackListen: HostPort, fallbackUrl: z.url(),         // the WebSocket fallback
    tls: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('pinned'), hostname }),     // self-signed ECDSA ≤ 13 days, hash served by api
      z.object({ mode: z.literal('provided'), certPath, keyPath }),
      z.object({ mode: z.literal('acme'), hostname, directoryUrl, email, agreeTos,
                 dns01 }),                                   // DNS-01 through Cloudflare
    ]),
    ticketSecret: Secret,
  }),
  play: z.object({ domain: Hostname, aliases: z.array(Hostname), port }),
  regions: z.array(z.object({ key, label })).min(1),        // product region catalog
  auth: z.object({
    secret: Secret, cookiePrefix,                           // blockly-<deploymentId>
    github: OAuthClient.nullable(), google: OAuthClient.nullable(),
    admins: z.array(z.email()),
    oauthProxy: z.object({ secret: Secret }).nullable(),    // previews sign in through the canonical origin (§14)
    proxySecret: Secret.nullable(), hostAddressHeader,      // whose word a browser's address is taken on
  }),
  mail: z.object({ smtpUrl, from }),
  edge: z.object({ token: Secret }),
  // the runtime keyring: the current key derives each server's RCON password and artifact token
  runtimeSecrets: z.object({ current: RuntimeKey, previous: z.array(RuntimeKey) }),
  // every runtime the deployment runs, each once (docs/runtimes.md)
  runtimes: z.array(z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('fly'), org, apiToken, natsUrl, regionMap, machineLimit, platformMachines }),
    z.object({ provider: z.literal('docker'), socketPath, gameNetwork, regionMap }),
    z.object({ provider: z.literal('boat'), apiToken, apiUrl, regionMap, runTtlSeconds, startReserve }),
    z.object({ provider: z.literal('fleet'), regionMap, caCertPem, caKeyPem, nodeListen, endpointHosts,
               placement, heartbeatSeconds, leaseSeconds, … }),   // docs/fleet.md
    z.object({ provider: z.literal('fake'), regionMap }),
  ])).min(1),
  defaultRuntime: z.string(),                               // one of `runtimes`; new servers go there by default
  operatorToken: Secret.nullable(),                         // the operators' API; null turns it off
  artifacts: z.object({
    runtimeFacingUrl: z.url(),                              // the control plane as game runtimes reach it (§15.2)
    mirrorCatalogArtifacts: z.boolean(),                    // requires `archive`; operator's licensing decision
  }),
  catalog: z.object({ userAgent }),                         // how this deployment names itself to Modrinth
  // null ⇒ no archives capability (§15.4)
  archive: z.object({ endpoint, runtimeEndpoint, bucket, region, accessKeyId, secretAccessKey }).nullable(),
  // null ⇒ entitlements from the plan column (self-host)
  billing: z.object({ provider: z.literal('polar'), accessToken, webhookSecret, server, products }).nullable(),
})
```

Env-var mapping (`config/load.ts`; every variable is in [configuration.md](configuration.md)):
`DEPLOYMENT_ID`, `ROLES`, `DATABASE_URL`, `DATABASE_DIRECT_URL`, `WEB_CANONICAL_ORIGIN`,
`WEB_TRUSTED_ORIGINS`, `REALTIME_PUBLIC_URL`, `REALTIME_TLS_MODE`, `PLAY_DOMAIN`,
`PLAY_DOMAIN_ALIASES`, `PLAY_PORT`, `RUNTIME_PROVIDERS` (every runtime the deployment runs) and
`RUNTIME_PROVIDER` (the default among them), each runtime's own variables (`FLY_*`, `DOCKER_*`,
`BOAT_*`, `FLEET_*`) and its region map, `<NAME>_REGION_MAP` or else `RUNTIME_REGION_MAP`, …

**Boot-time consistency checks:**
- No platform hostname (web, realtime) is a subdomain of `play.domain` or of any alias.
- Every `regions[].key` has a placement in the default runtime's region map; another runtime
  may map only some regions.
- Every runtime is listed once, and the default is one of them. A Fly runtime's machine limit
  leaves room for a server, Docker runs one region, the fleet has an archive store and an
  operator token, and the fake runtime serves only a loopback origin.
- Every region a Fly runtime maps to exists and is not deprecated (checked against Fly as it
  starts).
- `web.canonicalOrigin` is https unless it is local (loopback, or a private address for
  `bun run dev:lan`).
- The realtime hostname has no AAAA record when TLS mode is `acme`.
- `artifacts.mirrorCatalogArtifacts` requires `archive`.
- Without `archive`, the boot logs a warning (not a failure) if archive-tier backups or stored
  artifacts exist. That means a deployment lost the capability (§15.4).

### The hostname audit

| Place | Before | After |
|---|---|---|
| `minecraft_servers` | `slug` (no host, correctly) | unchanged; nothing hostname-shaped may be added (§17 lint) |
| tRPC server views | assembled `slug.play.<a fixed domain>` in docs | `PlayAddressing.primary` in the query layer |
| Edge routes | control plane built mc-router hostnames | control plane emits `{hostname, destination}` already resolved (§12) |
| Better Auth | cookie domain on the parent domain, `api.` origin | host-only cookies via same-origin proxy; `baseURL` and `trustedOrigins` from config |
| CORS | needed for `api.` | none: browsers never call the API cross-origin |
| Transport.io | implicit host | `realtime.publicUrl` from config; `authorize` checks `Origin` ∈ web origins and ticket audience = `deploymentId` |
| Web bundle | would have held `NEXT_PUBLIC_API_URL` | holds no origins. It uses relative `/api` and asks the API for `realtime.connectInfo` |
| Internal edge endpoints | `blockly-control.internal` implied | the edge agent's `CONTROL_URL` is config; the control plane's internal listener address is config |
| DNS | a fixed `*.play.` domain in docs | Terraform variable per environment: wildcard A/AAAA for each of `play.domain` + aliases → edge IPs |
| Fly app names | `bly-<id8>` | `bly-<deploymentId>-<key>`, inside `infra/fly` only |

**Changing domains** (e.g. moving the root domain):
1. Point new DNS at the same edge IPs.
2. Set `PLAY_DOMAIN=<new>` and `PLAY_DOMAIN_ALIASES=<old>`.
3. Set `WEB_CANONICAL_ORIGIN=<new>` and update the OAuth app callback.
4. Redeploy.

No migration, no domain change, no edge code change. The edge receives alias routes
automatically. Drop the alias once traffic on it stops (edge session events report which
hostname was used).

---

## 12. Edge routing, wake, idle and presence

### The edge protocol: generic, versioned, in `packages/contracts/edge.ts`

```ts
// GET  {CONTROL_INTERNAL_URL}/edge/v1/routes           → EdgeRoutes   (ETag; 304 when unchanged)
export interface EdgeRoutes {
  routes: {
    hostname: string
    destination: string /* host:port */
    state?: 'asleep' | 'restarting' // absent while it runs
  }[]
}

// POST /edge/v1/wake      { hostname }                 → WakeResult (blocks up to 25 s)
export type WakeResult =
  | { outcome: 'ready'; destination: string }
  | { outcome: 'starting' }                              // still booting when the wait ran out
  | { outcome: 'restarting' }                            // still on its way back from a restart
  | { outcome: 'denied'; reason: 'unknown' | 'suspended' | 'paused' | 'quota' | 'deleted' }

// POST /edge/v1/idle      { hostname }                 → 204      (a hint; the control plane decides)
// POST /edge/v1/sessions  { edgeId, hostname, event: 'connect' | 'disconnect', player?: { name, uuid }, at } → 204
```

The protocol is authenticated with `Authorization: Bearer <edge token>`. It's served only on
the control plane's **internal listener**: 6PN on Fly, loopback or the compose network locally.

### Control-plane side (`EdgeService`, no mc-router knowledge)

- **`routes()`.** It pairs `PlayAddressing.all(slug)` with
  `runtime.endpoint(handle, 'game', 'edge')` for every server with a handle whose status is
  `stopped`, `stored`, `starting`, `running`, `stopping`, `updating` or `relocating`.
  - A `stored` server's handle is the one `release` returned: a join is what wakes a resting
    world, so its route stays, and every runtime answers `endpoint` for it (§8).
  - Servers in `provisioning` and `restoring` are omitted. Their access record is being
    reseeded (§15.1), so nobody can join before it's in force. The exception is a restore of a
    running server: it's routed as `restarting`, which the edge never dials.
  - `state` is absent for `running`. It's `restarting` for a server on its way back from a
    restart Blockly began: any `updating` (settings, versions, packs, worlds, a rollback), a
    `restart` operation in either half, and a `restore` or `relocate` of a running server. Every
    other routed status is `asleep`.
  - Servers in `failed`, `deleted` and `purged` are omitted too.
  - Suspended accounts keep their routes, so players see the asleep message instead of
    "unknown host".
  - Where a runtime's addresses aren't stable (`stableEndpoints` false: Boat, whose stopped
    sandbox's address may go to anyone's), a route that isn't running names `0.0.0.0:0`
    (`NOWHERE`): nothing answers there, so a ping gets the asleep message and a join asks for a
    wake, which answers with where the server runs once it is up.
  - The ETag is a hash of the result. Nothing is persisted.
- **`wake(hostname)`.** `slugFor` → server → `MinecraftServerService.start(actor = system:wake)`.
  That call is policy-checked, so kill switches, standing, quota and entitlements all apply.
  It then waits on the event bus for `running`, up to 25 s (`wakeWaitMs` in `main.node.ts`),
  and returns the destination. A `restarting` server is never started: the join waits for the
  restart to finish, and gets `restarting` if it hasn't by then. So nothing is woken twice.
  - A join to a server being put to rest (`storing`) waits for that to finish, then wakes it.
  - Each server may be woken by a connection at most 12 times an hour (`WAKES_PER_HOUR` in
    `app/edge/service.ts`); past that the wake is `denied: quota`. Nothing about a connection
    proves who sent it, and each wake costs the owner a run.
  - A deleted server's address answers `denied: deleted`, so its players are told.
- **`idleHint(hostname)`.** Triggers an immediate idle evaluation. Only the idle policy
  (`Schedules.evaluateIdle`, entitlement-aware: some plans never idle-stop) decides whether to
  stop. The edge timer is
  just the earliest possible moment.
- **`recordSession`.** Upserts presence with `source = 'edge'` and bumps
  `server_activity.last_player_at`. This identity is **client-claimed**, so it's used for
  display and activity only, never for authorization. `presence-sync` (RCON `list`) is
  authoritative and overwrites it.

### Edge side (`apps/edge`): the only mc-router-aware code

- `mc-router` plus `edge-agent` (Bun/TS) in one image.
- The agent polls `/edge/v1/routes` every second. It renders
  `{"default-server": null, "mappings": {…}}` to a file and sends mc-router SIGHUP to reread it.
- **The notice** (`apps/edge/notice.ts`). A `restarting` route maps to a listener in the agent,
  not to the server. It answers the server list with "Restarting · back in a moment" and turns a
  join away with "Restarting · join again in a moment". mc-router has one asleep MOTD for every
  server it can't reach, so it can't tell a restart from sleep.
- **Sleeping servers.** An `asleep` route maps to a second listener in the agent, not to the
  server. On Fly the server's Flycast address takes the connection even while the machine is
  stopped, so mc-router's asleep MOTD, shown only when a dial fails, never showed and a ping got
  no answer. The listener routes by the handshake's next state:
  - A ping (1) is answered "Sleeping · join to wake it up". It never calls the wake webhook and
    is never reported as a session, so it never wakes a server or keeps one up.
  - A join (2) to a sleeping server goes to the wake webhook first, whose `{"backend": …}` is where
    mc-router connects it (the waiting room, below), so a join reaches this listener only when it
    arrived in the moment another join was asking. mc-router holds it until that ask is over, and
    the listener connects it to the server, as dialling the server directly would have.
  - While a join is waking a server, mc-router answers a ping with its own loading MOTD.
- **The waiting room** (`apps/edge/hold.ts`). A wake takes 40 to 60 s on Fly, and a Minecraft
  client gives up on a connection that says nothing for 30 s. mc-router holds a join silently
  while the wake webhook runs, and closes it without a word when the webhook fails, so the first
  join after a sleep used to be dropped. Now every join to a server that isn't running (asleep,
  restarting, or not routed yet) is sent at once to a third listener in the agent:
  - It wakes the server (`POST /edge/v1/wake`, again every time one comes back `starting`; joins
    to the same server share one ask) and holds the player meanwhile, for up to 3 minutes
    (`WAKE_HOLD_MS`).
  - While it holds, it sends the client a login query every 10 s, on a channel no client knows.
    Every client since 1.13 answers it, and hearing from the server keeps it waiting. The answers
    are the hold's own and never reach the server.
  - Once the server is up, it connects the player, sending the server what the client sent, so
    the join goes on as if it had just dialled. The player's first click gets them in.
  - Otherwise the player is told why, in a login disconnect: still starting (join again),
    restarting, refused (the owner can see why), paused, deleted, or no server at that address.
  - A client from before 1.13 can't be spoken to, so it is held only through one wake ask
    (25 s), then told it's still starting.
- **Restarts Blockly doesn't see.** When Fly brings back a crashed server, the control plane
  still says `running`. So any connection to a running server (pings included, which is why
  `-webhook-require-user` is off) makes the agent send it a status request of its own, at most
  every 5 s per server. A server that doesn't answer is routed to the notice until it does. A
  join to it waits up to 20 s for that, and is otherwise told it's restarting.
- mc-router flags point both webhooks at the local agent:
  - `-auto-scale-webhook-url http://127.0.0.1:<agent>/scale`
  - `-webhook-url http://127.0.0.1:<agent>/session`
- The agent translates in both directions:
  - `{"action":"up"}` for a running server's route → `POST /edge/v1/wake`. `ready` →
    `{"backend": destination}`. `restarting` → `{"backend": notice}`, so the join is told why.
    Anything else, and every join to a route that isn't running → `{"backend": waiting room}`,
    which wakes the server and holds the join, or tells the player why not. The webhook never
    answers non-2xx: mc-router closes a join it can't wake without a word.
  - `down` → `/idle`. Connect/disconnect → `/sessions`, except connections to the notice: being
    told a server is restarting isn't a join, and never keeps a server up.
- MOTD copy and `-auto-scale-down-after` are edge config.
- Several edge machines can run behind the same IPs. Routes are pulled, so every machine
  converges, and session events carry `edgeId`.

Replacing mc-router means rewriting `apps/edge` against the same protocol. Nothing in
`apps/control` changes.

---

## 13. Realtime

- **Contract** (`packages/contracts/src/realtime.ts`). Every event is a *hint*; clients refetch
  truth via tRPC on each new session.
  - `serverChanged {serverId, status, version}`
  - `operationProgress {serverId, operationId, kind, step, status}`
  - `presence {serverId, online, players}`
  - `backupChanged {serverId}`
  - `accessChanged {serverId, version}`: entries delivered, imported or rejected
  - `sessionCap {serverId, minutes, minutesLeft}`: the plan's session cap, `minutesLeft` to go,
    or 0 as the server is stopped
  - `listingChanged {serverId}`: eligibility or moderation changed
  - `consoleLine {serverId, at, text, level}`
  - `consoleHistory {serverId, lines}`: what the server printed before someone started watching,
    sent to that watcher alone
  - client→server `watch {serverId, topic: 'console'}` / `unwatch` (the same shape)
- **Emits only.** Nothing uses `call` or `stream`, so the WebSocket fallback (Safari, networks
  with UDP blocked) gets identical behaviour.
- **Rooms.**
  - `onSession` joins `user:<userId>` from the ticket.
  - `watch` is authorized by the realtime role against the DB (owner, or admin) and joins
    `console:<serverId>`.
  - When a console room's member count goes 0→1, the realtime role starts
    `LogSource.tail(handle)`, and each new watcher gets the last 200 lines from
    `LogSource.recent` as `consoleHistory`. At 1→0 it stops.
- **Fan-out.** Services and workers publish through `EventBus` = `pg_notify('blockly_events', json)`
  **inside the domain transaction**, so an event exists only if the write committed. The
  realtime role LISTENs, on `DATABASE_DIRECT_URL` (past Managed Postgres's pooler, which closes a
  client idle for ten minutes and breaks `LISTEN` in transaction mode), and emits into rooms. Payloads stay under Postgres's 8 kB `NOTIFY`
  limit by construction (IDs and statuses only). Log lines never touch Postgres.
- **Connecting.**
  1. tRPC `realtime.connectInfo` returns `{ url: config.realtime.publicUrl, certificateSha256?, ticket }`.
     The hash is present in pinned mode.
  2. The ticket is an HMAC of `{ userId, aud: deploymentId, exp: now + 60s }`.
  3. `authorize` verifies it and checks `headers.origin` against the web origins.
  4. The client's `connect` callback runs this on every reconnect.
- **Singleton.** One machine of its own Fly app (`bly-<deployment>-realtime`, the control
  plane's image with `ROLES=realtime`, `infra/fly/realtime.toml`), restart `always`. It is an app
  and not a process group of the control app because public ports belong to an app, and both
  the api (HTTPS) and the WebSocket fallback need TCP 443. WebTransport arrives on UDP 443 of its
  dedicated IPv4, and the process listens on `fly-global-services:443`: Fly rewrites a UDP
  packet's address and never its port, so the listener is on the port browsers dial, which the
  config refuses to get wrong. Fly terminates the fallback's TLS. A cert rotation is a restart,
  and clients reconnect as new sessions.

---

## 14. Auth, origins and sessions

- **Better Auth runs in `control:api`, mounted at `/api/auth`.** Browsers reach it only through
  the web origin's `/api/*` rewrite, so every cookie is host-only on the web origin.
- **`baseURL` = `web.canonicalOrigin + /api/auth`**, with `trustedOrigins` =
  `[canonicalOrigin, ...web.trustedOrigins]`.
- **`advanced.cookiePrefix = blockly-<deploymentId>`.** `useSecureCookies` is derived from the
  canonical origin's scheme (true unless loopback http).
- **Previews:** `oAuthProxy` with `productionURL` = the *environment's* canonical origin (the
  staging web origin, not production) and a per-environment proxy secret
  (`AUTH_OAUTH_PROXY_SECRET`; absent, previews sign in with email only).
  `web.trustedOrigins` includes the team's preview pattern (`https://<project>-*-<team>.vercel.app`),
  never a bare `*.vercel.app` (config refuses a pattern whose wildcard spans a whole label).
  Behind the rewrite a request's URL carries the api's host, and Vercel's external rewrites set
  `X-Forwarded-Host` to the upstream's host too, so the api presents each `/api/auth` request to
  Better Auth at the origin in its `Origin` header, when that origin is trusted. The sign-in
  POST always carries one: from the canonical origin the proxy steps aside, from a preview the
  canonical callback hands the profile back to the preview, which makes the session.
- **Web server components** call `API_UPSTREAM` directly (server to server, forwarding the
  cookie header). `API_UPSTREAM` is a Vercel **server-only** env var used by `rewrites()` and
  RSC fetches. It never reaches the bundle.
- **API responses** set `Cache-Control: no-store`, because Vercel caches rewrite upstreams by
  default on new projects. Nothing long-lived goes through the rewrite (120 s cap). Realtime
  is direct.
- **Email flows** use Better Auth's `baseURL`, which comes from config. There are no magic links:
  people sign in with an email and a password, or a configured OAuth provider. The emails are a
  verification link on sign-up, a password reset link that works for an hour, and, once a reset
  has signed out every session, a notice that the password changed (`infra/auth/better-auth.ts`).
  The mail transport is config too (`mail.smtpUrl`; a Mailpit container locally).
- **OAuth apps are per environment.** Each has its callback on that environment's canonical
  origin: `<canonicalOrigin>/api/auth/callback/<provider>`. Google is the primary way in;
  a provider is offered only where its client is configured, and the web pages learn which
  from `GET /api/auth-methods`. Account linking keeps Better Auth's defaults: a Google sign-in
  joins an existing account only when both Google and the account have verified the email.

---

## 15. Capability designs

### 15.1 Server access: live administration

**What goes where.**
- `ServerRevision.settings` holds the properties the server reads at boot (§4 table).
- `ServerAccess` holds whitelist on/off, the whitelist, operators and player bans.
- `RuntimeSpec` holds none of it (§7).

So `whitelist add steve` never creates a revision, never enqueues an `apply`, and never
restarts anything.

**Source of truth.** There are two legitimate writers: Blockly (the UI) and in-game operators
(including anyone typing into the Blockly console). The server's JSON files and the Postgres
record relate like this:
- **Steady state:** the files are the server's working copy, and in-game changes land there
  first. Blockly *imports* them. A difference between file and record is not drift; it is an
  in-game change not yet imported.
- **Across a volume replacement** (fresh provision, snapshot or archive restore), the files
  can't be trusted. The **record is re-imposed** (`reseedRequired`).
- **The whitelist is written; operators and bans are commanded.** Blockly writes
  `whitelist.json` whole and has the server reload it (`whitelist reload`, which also kicks
  whoever it no longer holds under `enforce-whitelist`). Operators and bans go by command:
  they have no reload command, the server reads them only as it starts, and it saves its
  in-memory copy over the files on its next change. The one exception is below, under
  *who a name is*: where the console can't name the players Blockly holds, the boot writes
  those files and restarts the server once to load them.

So the files stay the server's working copies that Blockly reconciles; the whitelist is simply
delivered as a file rather than one name at a time.

**Who a name is.** A server that checks accounts (`online-mode=true`, every server by default)
knows a player by their Minecraft account's UUID. One that doesn't derives a version 3 UUID
from the exact name the player typed (`OfflinePlayer:<name>`), capitals included. Measured on
vanilla 26.1/26.3, Fabric 26.1 and Paper 1.21.8 on 2026-09-23 (`docs/dependency-audit.md`):
- On a server that doesn't check accounts, vanilla's console still names a player it hasn't met
  by asking Mojang, and falls back to the name in lower case. `whitelist add`, `op` and `ban`
  then land under someone other than the player who joins. Paper names them correctly.
- It names a player it has met through its name cache (`usercache.json`), which each login
  fills; the cache is loaded at start and not written on stop.

So Blockly computes identities itself (`app/access/identity.ts`): an account's UUID where the
server checks accounts, and the derived one where it doesn't. The record is kept keyed for the
kind of server that is running, which the reconciler reads from `server.properties`.
- **After the kind changes**, every entry is the same name and so the same person, re-keyed to
  the new kind; a name with no account is `rejected` on a server that checks accounts. At that
  boot the lists are written under the new identities, the name cache is deleted, and the
  server restarts once.
- **On a server that doesn't check accounts**, an operator or ban for someone it has never met
  would land under someone else: settle takes that off again, and the entry stays pending
  ("it takes effect when they next join"). Presence retries it once they are online, and the
  next boot writes it exactly.
- **Publicly**, a server that doesn't check accounts shows how many are playing, not who: the
  names are whatever somebody typed.

**Reconciliation** (`AccessReconciler` in `app/access/reconciler.ts`, over the pure import,
delivery plan and settling in `domain/access/reconcile.ts`; commands and parsers in
`minecraft/access.ts`). It runs only inside a server operation, so it's serialized with power
and apply:

```
reconcileAccess(server)                                       server must be running
  1. observed ← one runtime.exec reading whitelist.json, ops.json, banned-players.json,
                banned-ips.json and the `white-list` and `online-mode` properties
  2. if record.reseedRequired: target ← record (active + pending_add − pending_remove)
     else: import observed into every entry that is not pending
             (entry only in files → added, origin 'game'; entry only in record → removed)
           target ← record
     every entry re-keyed for the kind of server that is running (see *who a name is*)
  3. at boot, where operators or bans differ and the console can't name them (the server
     doesn't check accounts, or just changed kind): write all three lists, forget the name
     cache after a change of kind, and restart once; the boot reconciles again
     otherwise: write whitelist.json if it differs, then over RCON (ServerConsole):
       whitelist reload, op|deop <name>, ban <name> <reason>, pardon <name>, whitelist on|off
       each account's <name> is resolved from its UUID via PlayerProfiles just before sending
  4. observed ← re-read; the files decide each outcome, not RCON output text (its wording changes between versions):
       pending_add present → active · pending_remove gone → row deleted
       present under a different UUID → undo; renamed between lookup and send → rejected,
         or, where accounts aren't checked, pending until they join
       not effective → rejected(error), or pending until they join where accounts aren't checked
  5. reseedRequired ← false; syncedAt ← now; version++; emit accessChanged
```

**RCON mutations.** `AccessService.add(actor, serverId, 'whitelist', name)`:
1. Policy check: owner or admin, standing not terminated, rate limit.
2. The name becomes the player the server will know: where accounts are checked,
   `PlayerProfiles.byName(name)` returns the account's UUID, or nothing, which is refused as
   `unknown_player`; where they aren't, the UUID is derived from the name and no account is
   needed. This works while the server is stopped.
3. In one transaction: upsert the entry as `pending_add`, write the audit entry, enqueue
   `access_sync`, and emit the event.

If the server is running, the change lands within a queue tick. If it's stopped, it stays
pending and the next boot delivers it.

Commands carry names because vanilla doesn't document UUID targets for `game_profile`. The
UUID stays the identity, so a renamed or recycled name can't end up whitelisting the wrong
account.

**When reconciliation runs.**

| Trigger | Mode | Why |
|---|---|---|
| Boot sequence of every operation that ends in `running` | full (reseed or import+deliver) | delivers what changed while stopped; re-imposes after a restore |
| `access_sync` after each mutation; owner opens the access page (deduped per minute) | full | live edits; UI freshness |
| Before `stop` and before `restore` | import only | captures in-game changes before the files stop being observable or are replaced |
| `presence-sync` sees someone online with a change still pending for them | full (`access_sync`) | where accounts aren't checked, the server can name them once they have joined |

There is no periodic polling. The files persist on the volume across restarts and crashes,
so waiting never loses an in-game change. The one event that discards the files, a restore,
imports first.

What remains: a host failure that destroys the volume loses in-game access changes made
since the last sync point. Import-on-stop bounds that to the current session.

**Failure handling.**
- A reseed that can't be delivered fails the boot, and the server is stopped. Blockly never
  runs a server whose access state is unknown.
- In continuous mode, delivery failures leave entries `pending` or `rejected`, shown in the
  UI and retried at the next sync point.
- `access_sync` never permanently fails its per-server key.

**Gap window.** A player could join between the game accepting connections and step 3.
- **Reseed cases:** closed. Routes omit servers in `provisioning` and `restoring` (§12), and
  the status becomes `running` only after reconciliation.
- **Changes made while stopped:** bounded to seconds. `enforce-whitelist` kicks
  non-whitelisted players the moment `whitelist on` or a removal lands. `ban` kicks, and
  `deop` is immediate.

**Backups and restores.** A backup physically contains the access files, but restoring a
backup never restores its access. The restore operation first imports the current files. It
then sets `reseedRequired`, and the boot re-imposes the record. Restoring last week's world
never un-bans the griefer banned yesterday or re-ops an operator removed today. Relocate and
undelete keep the same volume contents, so they stay continuous.

**IP bans are not part of the model.**
- Behind the shared edge, every connection reaches the server from the edge's address. The
  Fly proxy or mc-router is the peer, and vanilla doesn't accept PROXY protocol. A Minecraft
  IP ban would ban the edge and lock everyone out.
- `ConsoleService` therefore refuses `ban-ip` and `pardon-ip`.
- An in-game operator can still run them, so reconciliation clears any `banned-ips.json`
  entries it finds, writes an audit entry and tells the owner why.
- Network-level abuse is an edge concern (connection rate limits).

**Where it shows.** The server page reads the record, with pending and rejected entries
visible. The directory's "whitelist only" badge reads `whitelistEnabled`. Purge deletes the
rows.

### 15.2 Mod artifacts: durable references, stable links

```ts
// domain/mods/artifact.ts
export type ArtifactRef =
  | { kind: 'remote'; url: string }             // permanent public URL issued by a catalog (Modrinth CDN)
  | { kind: 'stored'; key: StoredArtifactKey }  // content-addressed object in ArchiveStore

export interface ModArtifact {
  ref: ArtifactRef
  sha512: string        // identity of the bytes
  sizeBytes: number
  fileName: string      // as published
}
```

**Rule.** Temporary URLs never enter persisted state:
- not a revision
- not `RuntimeSpec`, which the provider stores in the machine config and replays on every
  boot, including crash restarts the control plane never sees
- not a database row

Presigned URLs exist only inside one HTTP response or inside one operation that consumes them
immediately (archive export and restore).

**Resolution chain.**

```
ServerRevision.mods                    durable refs + sha512
  → worker: ArtifactService.preflight  IO. Every artifact obtainable?
                                         stored: object exists (needs archives capability)
                                         remote: catalog state not absent/withheld, or acknowledged (§15.3)
                                         mirror now if the deployment mirrors and it isn't stored yet
                                       → typed ArtifactUnavailable{sha512, reason} before touching the runtime
  → worker: ArtifactLinks.forServer    pure. Stable URL per artifact:
                                         {runtimeFacingUrl}/runtime/v1/artifacts/{serverId}/{sha512}/{diskName}?t={token}
                                         token = deriveServerSecret(serverId, 'artifacts'), stable, no expiry
  → minecraft/mods.ts                  pure. MODS=<those URLs>
  → RuntimeSpec                        stable; the same digest on every build

at boot, the image fetches a link → interfaces/runtime → ArtifactService.locate
  authorize: the token matches serverId and sha512 is referenced by some revision of that server
  HEAD → 200 from the database alone: Last-Modified = the artifact's pinnedAt (fixed),
         Content-Length, Content-Disposition
  GET  → 302 to a presigned ArchiveStore URL (stored or mirrored), else to the remote URL
```

**Where each responsibility sits.**

| Candidate | Role | Why not more |
|---|---|---|
| `ModService` | Creates durable refs: catalog → `remote` from the catalog response; upload → `stored` after sha512 and jar verification | Runs at authoring time. Boot-time URLs aren't its concern |
| `ArchiveStore` | Primitives: `presignGet`, `presignPut`, `ingestFromUrl(url, sha512)`, `head`, `delete` | Knows nothing about servers, revisions or policy |
| `minecraft/` | Maps artifacts to `MODS` using an injected pure `artifactUrl` function; owns the on-disk name | Must stay pure; no IO |
| Worker | Sequences `preflight` → links → `toRuntimeSpec` → runtime | Orchestration only |
| **`ArtifactService`** (`app/artifacts`) | The policy: where bytes come from (store, mirror, upstream), who may fetch them, mirroring, GC | One implementation composed from ports, so it isn't a port itself |

**Why an endpoint rather than presigning at spec-build time.**
1. The image HEAD-checks every `MODS` URL on every start and aborts startup on 403/404, even
   when the jar is on disk. An expired URL means a server that can't boot. That includes the
   provider's own crash restarts.
2. Presigned URLs would change `specDigest` on every build. Drift detection would break, and
   every start would need a machine config update: another Fly API call inside the 30 s
   wake-on-join budget.
3. HEAD is answered locally with a fixed `Last-Modified`, and the image skips files whose
   mtime is newer. So **boots never depend on Modrinth, its CDN or object storage for jars
   already installed**. Only first installs download.
4. Where bytes come from becomes a fetch-time decision. Turning a mirror on, or losing the
   archives capability, never changes a revision or a spec.

**On-disk name** = `{sha512[:12]}-{fileName}`. It is the last URL path segment and the
`Content-Disposition` filename. Unique names mean the HEAD shortcut can never mistake one
file for a different file published under the same name. Loaders load any `.jar` in the
directory.

**Integrity.**
- Stored and mirrored bytes are verified against sha512 at ingest.
- The boot sequence verifies what is actually installed. One `exec` hashes the mods directory
  (command and parser in `minecraft/install-check.ts`), and the result is compared with the
  revision. This catches:
  - truncated downloads. The image writes files in place, non-atomically, and would skip a
    broken file forever because of its fresh mtime.
  - upstream substitution.
- On a mismatch, the worker marks the server's jars stale, restarts once, then fails the
  operation. For an apply, that triggers auto-rollback.
  - Stale means the artifact endpoint reports `Last-Modified` = the moment they were marked,
    which is newer than every file on disk, so the image downloads each one again. That works
    on every provider, where deleting files would need a running workload to `exec` in.
  - A truncated jar stops a mod loader before the world loads (Fabric: `ZipException: zip END
    header not found`), so the check after readiness would never run. A boot with jars that
    fails before it is ready gets the same treatment: marked stale, restarted once.
  - Observed with the image's mc-image-helper 1.68.0; see `docs/dependency-audit.md`.
- Honest limit: without a mirror, a substituted remote file is detected after it has loaded
  once, not before.

**Mirroring** (`artifacts.mirrorCatalogArtifacts`, requires archives, default off):
- Modrinth's terms don't address private mirroring, and mod licenses vary, so it's the
  operator's decision.
- Curated packs decide it per release instead, from each file's licence (source `curated`, kept
  while any release that holds it was ever verified); see docs/modpack-templates.md. Many mod
  licences forbid any copy but the one downloaded from their official page, which the
  deployment-wide switch can't tell apart.
- When on, `artifact-mirror` copies each newly referenced remote artifact into the store
  (verified, content-addressed, shared across servers), and `locate` prefers the copy.

**Reproducibility, stated precisely.**
- **Identity:** a revision's bytes are identified by sha512 forever.
- **Availability of stored artifacts:** guaranteed while referenced; GC refuses referenced
  blobs.
- **Availability of remote artifacts:**
  - Modrinth's service never deletes stored version files, even after deletion or rejection.
    That's observed in its source, not promised.
  - A mirror makes it guaranteed.
  - Installed jars also live on the volume and in every snapshot.

**Custom uploads.**
1. `beginUpload` returns a presigned PUT, signed for the size the browser declared, with the
   file's sha512 it computed. A `pending_uploads` row keeps the staging key, so an upload
   nobody finishes is deleted by `artifact-gc`.
2. `finishUpload` verifies size, sha512 and jar sanity. Loader metadata is parsed by
   `minecraft/` from what the `FileFormats` port decodes (zip, TOML, YAML).
3. It then records a `StoredArtifact` and a `ModUpload`.

Uploads are entitlement- and capability-gated and always `untrusted`. An upload referenced by
a revision of a non-purged server can't be deleted.

### 15.3 Catalog metadata, trust and listing eligibility

**What is frozen and what is dynamic.**

| Frozen in `PinnedMod` (facts at resolution, never change) | Dynamic, in the catalog cache (refreshed) | Ours (allowlist) |
|---|---|---|
| catalog, projectId, versionId · name, versionLabel · `ModArtifact` (ref, sha512, size, fileName) · environment · declared loaders and game versions · dependency edges (origin, requiredBy) | project state · version state · `fetchedAt` · `stateChangedAt` · `absentStreak` | `(catalog, projectId)` trusted, by whom, why |

The cache holds **only the tracked set**:
- every project and version referenced by a revision of a non-purged server
- plus allowlisted projects

It holds **only the trust-relevant fields**. No descriptions, downloads, licenses or search
data; search goes to the catalog live, which is fine on an authoring path.

**States.**
- Project: `approved | archived | unlisted | withheld | absent`.
- Version: `listed | archived | unlisted | absent`.
- `absent` means the public bulk API omitted it. The following all look identical to an
  anonymous client, deliberately on Modrinth's part:
  - deletion
  - rejection, including malware takedowns
  - private, draft and processing
- `withheld` is the only moderation state the public API shows.

**Trust** is a pure function (`domain/listing/trust.ts`) of local state only:

```
trust(revision, allowlist, cache) =
  no mods                                                          → vanilla
  every mod is a catalog mod
    ∧ (catalog, projectId) ∈ allowlist
    ∧ cache.project ∈ {approved, archived}
    ∧ cache.version ∈ {listed, archived, unlisted}                 → catalog_trusted
  otherwise                                                        → untrusted, with a reason per mod
```

The allowlist is **necessary, not sufficient**. It's our positive decision, and catalog state
is a revocation signal layered under it. Uploads are never trusted, and CDN reachability is
never a signal: the CDN keeps serving rejected files.

**Refresh.**
- **Write-through.** Every catalog read during resolution records the states it saw
  (`CatalogSync.recordObserved`). Every pinned project and version has a cache row before its
  revision exists.
- **`catalog-refresh`, hourly.** Bulk requests over the tracked set, chunked at about 100 ids.
  That's a few dozen requests an hour, far below the 300/min limit.
  - The project `updated` field doesn't move on status changes, so every state is re-read.
    There is no incremental shortcut.
- **Hysteresis.** A move to `absent` needs two consecutive refreshes (`absentStreak`), so one
  malformed response can't hide hundreds of listings. `withheld` applies immediately,
  because it's explicit.
- **Staleness.** Eligibility uses the last known state. Cache entries don't expire.
  - More than 6 h without a successful refresh raises an admin alert, once a refresh has asked
    since and got no answer (`catalog_refreshes.failed_at`). A cache that only grew old while no
    worker ran isn't the catalog failing: a worker that finds a refresh missed runs one as it
    starts, before the alert looks.
  - The emergency lever is the `publicListingEnabled` kill switch, not automatic mass
    delisting over *our* inability to check.

**When Modrinth is unavailable.**

| Path | Behaviour |
|---|---|
| Directory, listing reads, eligibility | Unaffected: local tables only |
| Boots of installed jars | Unaffected: HEAD is answered locally |
| New downloads (first install, restore of older content) | Go to the CDN, which is separate from the API, or to the mirror |
| Adding or upgrading mods | Typed `CatalogUnavailable`; nothing partial |
| Refresh | Keeps last known states; alerts after 6 h of failed refreshes |

**Revocation.** Suppose an approved project becomes `withheld`/`absent`, or a pinned version
becomes `absent`:
1. `CatalogSync` records the transition, finds servers whose **applied** revision references
   it (GIN index), and enqueues `listing-eligibility` for them.
2. Those listings leave the directory with a reason, and owners are notified.
3. Running servers are untouched: they are the owner's servers.
4. `apply`, `rollback` and restore-with-config to a revision containing a revoked artifact
   require an explicit acknowledgement. We can't tell an author's cleanup from a malware
   takedown, so it warns and doesn't block.
5. New resolutions can't pick it, because the catalog no longer returns it.

**Eligibility is a materialized read model** on `public_listings`: `eligible`,
`ineligibleReasons`, `evaluatedRevisionId`, `evaluatedAt`.
- It is computed by the pure trust function, plus standing, restrictions and
  `entitlements.mayListPublicly`.
- It is recomputed by `listing-eligibility` jobs, triggered by:
  - apply success
  - allowlist changes
  - catalog transitions
  - standing or restriction changes
  - subscription changes
- A daily sweep rebuilds it all.
- Owners pick up to five tags from a fixed set, so the directory filters by them and nothing
  free-form reaches it.
- The platform kill switch is applied at read time and is not materialized.
- Browse is one indexed filter: `published ∧ clear ∧ eligible`.

### 15.4 Deployment capabilities

```ts
// app/capabilities.ts
export interface DeploymentCapabilities {
  readonly archives: ArchiveStore | null      // present iff config.archive is set
  readonly billing: BillingProvider | null    // present iff config.billing is set
}
export type DeploymentCapability = keyof DeploymentCapabilities

export function requireCapability<K extends DeploymentCapability>(
  caps: DeploymentCapabilities, k: K,
): NonNullable<DeploymentCapabilities[K]>     // throws CapabilityUnavailable(k)
```

- `main.node.ts` builds it from config, and `main.node.ts` is the only place that knows.
  **Whether the port instance exists *is* the capability**, so no boolean can disagree with the
  wiring.
- `ArchiveStore` has no "not configured" code path, because an unconfigured store is never
  constructed.

**One decision order, one vocabulary** (`AccessPolicy.check`):

```
deployment capability → platform kill switch → account standing → restrictions → entitlement → caps
deployment_unsupported   platform_paused        account_suspended   restricted     not_entitled  limit_reached
```

Capability and entitlement are separate checks, and both must pass. The UI copy differs:
"Not available on this Blockly deployment" versus "Upgrade your plan".

| Policy capability | Deployment needs | Entitlement needs | Kill switch |
|---|---|---|---|
| Create archive (manual or scheduled) | archives | `backupPolicy.archiveEnabled` | — |
| Download / export world | archives | `backupPolicy.archiveEnabled` | — |
| Restore from archive | archives | — (owner) | `startsEnabled` |
| Upload custom mod | archives | `mayUploadCustomMods` | `uploadsEnabled` |
| Checkout / customer portal | billing | — | — |
| Snapshot backup / restore | — | `backupPolicy.snapshotsKept` | — |
| Mirror catalog artifacts (internal, no actor) | archives + `mirrorCatalogArtifacts` | — | — |

**Services.**
- A service calls `policy.check`, then `requireCapability(this.caps, 'archives')` for a
  non-null store. After a passing check this can't throw, but the types make it impossible to
  reach S3 without a store.
- Schedules and internal jobs skip unsupported work instead of failing. That covers the
  archive-tier backup schedule, mirroring and GC.

**Queries.**
- `platform.capabilities` returns `{ archives, billing }` booleans, so the web app hides what
  can't exist.
- The account view lists effective features as `{ feature, available, reason? }`. It is
  computed by running the same policy function without taking locks, so what the UI shows
  and what the API enforces can't disagree.

**Behaviour without archives.**
- Provider snapshots and snapshot restore work.
- Archives, downloads/exports, custom uploads and mirroring are unavailable, with
  `deployment_unsupported`.
- Deleting a server warns that no backup survives purge on this deployment.

**Behaviour without billing.** Entitlements come from `account_standing.plan` and admin
overrides (self-hosting).

**Losing a capability.** A deployment that used archives and removes the config:
- Archive rows stay, shown as unavailable. Operations on them deny with
  `deployment_unsupported`.
- Revisions referencing stored artifacts fail `preflight` with a typed reason.
- Installed jars keep working, because HEAD is answered from the database alone.
- Purge records archive deletions it couldn't perform, and completes them if the capability
  returns.

### 15.5 Other capabilities

**Mods and dependency resolution.**
- `ModCatalog` returns neutral `ModVersion` objects:
  `{ source, name, gameVersions, loaders, environment, dependencies: {source|projectRef, kind: required|optional|incompatible|embedded}[], artifact: ModArtifact /* ref: remote */, state: CatalogState }`.
- `ModService` (`plan` and `apply` for a change of mods, `resolveNew` for a server not made yet)
  fetches the dependency closure through the catalog (the IO step), round by round as the pure
  `domain/mods/resolve.ts` asks for it. That function:
  - picks versions compatible with `(gameVersion, loader)`
  - adds required dependencies (`origin: 'dependency'`)
  - rejects incompatibles, client-only mods and unresolvable requirements, returning a typed
    conflict list for the UI
- The result is a new `ServerRevision`. The UI shows the diff before apply.
- Upgrading a game version re-resolves every mod for the new version, fails with a precise
  conflict list if any can't follow, and never partially applies.
- Resolution only picks versions whose project state is `approved | archived | unlisted` and
  whose version state is not `absent`. The states it saw are written through to the cache.
- Custom uploads are `stored` artifacts (§15.2). They are capability- and entitlement-gated,
  and always `untrusted`.

**Datapacks.**
- A Modrinth datapack is a version whose loaders include `datapack`. Every server type's target
  includes that tag, so datapacks resolve by game version like mods, and pin into the same
  `mods` list: the diff, the snapshot before apply, rollback and revocation are the mods'.
- A pin is a datapack where none of its loaders is one the server loads jars with
  (`domain/mods/artifact.ts`). A version published for both runs as the mod where it can.
- A datapack asks nothing of players. Plain Minecraft with datapacks stays plain, on Paper where
  it runs on Paper; only a mod moves a vanilla world to a mod loader.
- Install: not the image's `DATAPACKS`, which never checks what it fetched and whose clean-up
  removes the owner's own zips. A step of Blockly's in the entrypoint puts the listed files into
  `<level>/datapacks`, fetches again only a file whose SHA-512 isn't the pinned one, and stops the
  start on a download that isn't, so the apply rolls back. It records what it put there in
  `<level>/.blockly-datapacks` and removes only those (`minecraft/datapacks.ts`).
- Worlds: datapacks belong to the server, and each start brings the world it opens to the
  server's list. A world created or switched to later gets them at its first start, before
  Minecraft generates it; a world switched away from keeps its copies until it runs again.
- Plans: `mayUseDatapacks`, beside `mayUseMods`. Whether plain Minecraft with a datapack stays
  Free is open; until it is decided, Free's is false.

**Rollback.**
- Safe failure is `apply` = pre-apply snapshot → apply → readiness probe. On failure it
  automatically re-applies the previous `applied` config.
- If the new version already migrated the world (version upgrades do), rollback also restores
  the pre-apply snapshot. The UI shows this before a version upgrade.
- Manual rollback creates a `rollback` revision copying an earlier one.

**Backups.**
- **Snapshots** are provider snapshots: fast, same-server restore. Their lifetime is bounded
  by the provider (Fly: ≤ 60 days, gone after purge).
- **Archives** are tarballs in `ArchiveStore`: downloadable, they survive purge, and their
  retention comes from the entitlement. They need the archives capability (§15.4).
- No backup carries access semantics: a restore re-imposes the current access record (§15.1).
- Consistency: `save-off` + `save-all flush` over RCON before the snapshot, and `save-on`
  after.
- `expiresAt = min(entitlement retention, provider limit)`. Reconciliation marks backups
  whose snapshot vanished as `expired`.
- Restore from an archive = `runtime.restore({kind: 'archive', download})`.
- A download can be brought back: uploaded like a jar (presigned PUT, `pending_uploads`), read
  for the world its `server.properties` names and its `level.dat` describes, and kept as an
  archive backup with trigger `uploaded` and those facts (`world_facts`). A world the server
  never had gets a world row that exists only in the backup until it is restored.

**Logs and console.**
- `LogSource.recent/tail` feed the console view (§13).
- A tail follows one workload through its restarts: a Fly subscription does by nature, and the
  Docker tail picks the container up again from its next start. The realtime role opens a tail
  when the server is `starting` or `running` and ends it when the server leaves `starting`,
  `running` and `stopping`, because restore, relocate and update can replace the workload.
- On Fly both are scoped to the server's machine, and only its own output (`app`) counts, so
  export and restore helper machines and Fly's proxy lines never reach the console.
- Commands go through `ConsoleService.run`. It is:
  - policy-checked (owner, server running, standing and restrictions)
  - rate-limited
  - written to `audit_log`
  - executed over RCON via `runtime.endpoint(handle, 'rcon', 'control')`
  - refused for `ban-ip` / `pardon-ip` (§15.1)
- Its responses return through tRPC. Output also appears in the log tail.
- Access commands typed into the console are in-game changes, and the next reconciliation
  imports them.

**Presence and idle.**
- Edge sessions (hint) and RCON `list` (authoritative) feed the unlogged tables.
- Directory player counts and idle detection read those tables.
- After a control-plane restart, the empty tables are treated as "activity unknown", with a
  grace period before idle stops.

**Player faces.**
- Every row that lists a player shows the face on their skin: the front of the head with the hat
  layer over it, cut by the pure `minecraft/skin.ts` from what `PlayerProfiles.skinOf` decodes.
- Blockly asks Mojang itself and serves the face at `/api/public/players/:uuid/face.png` (8×8,
  drawn large with `image-rendering: pixelated`). A third-party head service would learn who plays
  on whose server; this way Mojang learns only that Blockly asked, and the endpoint says nothing
  about servers.
- `PlayerFaces` keeps each answer for an hour (five minutes when Mojang couldn't answer), asks
  once per UUID at a time, and counts lookups under one `Limits` key so a flood of faces can't get
  Blockly's address refused by Mojang.
- A server that doesn't verify accounts makes a version 3 UUID up from the name, which no account
  has. Its players' faces come from `/api/public/names/:name/face.png` instead: the account that
  has the name, and so the skin skin plugins give that player in game. The name's account is kept
  for the same hour.
- Where there is no face (no skin of the player's own, no account with the name, Mojang busy) the web
  app draws one of its own from the name: seven styles over skin, hair, eye and accent palettes,
  the same face for the same name everywhere (`apps/web/src/ui/face.tsx`).

**Abuse controls and kill switches.**
- `AccessPolicy.check(tx, actor, capability)` checks, in order: deployment capability (§15.4)
  → kill switch → standing → restrictions → entitlements (incl. monthly run hours from
  `power_intervals`) → global caps. Each step has its own denial code.
- It runs under an advisory lock in the same transaction as the write, and is re-checked by
  workers.
- Wake-on-join goes through the same `start`, so it inherits every check.
- Suspension enqueues `stop{policy}` for running servers, and re-evaluates their listings
  (standing is an eligibility input, so they leave the directory without losing owner intent).
- Termination enqueues delete + purge (`purgeAfter = now`).

**Plans.** One table, `domain/account/entitlements.ts`, holds every plan fact, and one rule,
`planGap(plan, runs, 'offered' | 'startable')`, says whether a plan runs a size, a server type and
mods, and `planThatRuns` names the plan that would. Creating, changing, starting, the lapse sweep
and the create flow's cards all ask it. Free runs Vanilla and Paper without plugins on the 3 GB
size, one server, 20 hours; Plus runs everything on 3, 4 and 8 GB, three servers, 60 hours. A size
counts one hour an hour, or two for a large one (`domain/account/meter.ts`). The pricing page reads
the same table through `GET /api/public/plans` and `billing.plans`. The size behind each answer to
"Who is playing?" is public too, at `GET /api/public/sizes`, for the guide that shows it.

**Billing.**
- `BillingService.startCheckout` / `customerPortal` use `BillingProvider` (Polar). A checkout
  carries the edge the person met (`reason`, audited as `billing.checkout_started`) and where to
  land after paying (`next`, only ever a path in the app).
- Polar webhooks go to the `interfaces/billing` handler, which verifies the signature and
  calls `BillingService.syncSubscription`. That upserts `billing_subscriptions` and
  re-evaluates the affected servers.
- The plan in force is a paying subscription's (active or trialing, with three days' grace
  past its period end for a late renewal webhook, `RENEWAL_GRACE_MS`), or a past-due one's for
  seven days from the failed charge while Polar retries the card (`PAST_DUE_GRACE_MS`; both in
  `app/billing/persistence.ts`), else `account_standing.plan`: free, or one an admin gave the
  account. `loadStanding` applies the rule, so every entitlement read does.
- The webhook route is `POST /api/billing/webhook`, read raw because the signature covers the
  exact bytes. Coming back from checkout or the portal (`/account?from=billing`), the page asks
  `BillingService.refresh`, which reads the provider's standing before the webhook arrives.
- On a downgrade, servers over the limit are stopped with `stopReason = entitlement`. They
  are never deleted, and `start` is denied until the limit fits. The sync enforces it at once,
  and the minute's `standing-sweep` catches what came up in between. A server whose setup the
  new plan doesn't run (mods or a modded server type after Plus ends) is stopped the same way and
  kept exactly as it is: nothing is converted or taken off it, and it starts again on Plus.
- Extra hours past the included ones read `power_intervals`; they stay off (`mayBuyMore`) until
  metering to Polar is proven end to end.
- Every change to a subscription and to the plan it gives is audited on the account, with the
  actor and `data.source` (`webhook`, `user` for the person's own refresh, `scheduled` for the
  sweep): `billing.subscribed`, `billing.cancel_scheduled`, `billing.cancel_undone`,
  `billing.plan_switched`, `billing.renewal_failed`, `billing.renewal_recovered`,
  `billing.subscription_ended`, `billing.subscription_lapsed` and `account.plan_changed`
  (`app/billing/audit.ts`). A lapse is paid time running out with no word from Polar, which drops
  the plan by the clock alone; the minute's `standing-sweep` records each once, keyed by the
  subscription and the moment it lapsed. Syncs and the sweep take the account's standing lock, so
  each change is audited against the one before.
- `order.paid` and `order.refunded` are kept in `billing_orders`, one row per order by its id,
  every amount in cents: revenue measured, not modelled. An order for someone this deployment
  never made is not kept.

**Storage.** Every server starts on its plan's disk (`storage.startGb`: Free 3 GB, Plus 5 GB,
whatever its size). Each stop measures what the world takes (`du` over the runtime's exec, kept as
`disk_used_bytes`). Once a world leaves less than a fifth of its disk, or 1.5 GB, free, the next
start gives it one the world fills to about 70% (at least 2 GB more), up to the plan's most
(`grownDisk`). A world can grow gigabytes an hour while a group explores, so `disk-check` measures
running servers every 10 minutes too, and one that needs room now is told in game and restarted
onto the bigger disk (the restart applies the spec, and Fly extends the volume): a disk never runs
full with players on it. Free's world border keeps it far inside its 3 GB. What a
world costs grows with it (about $0.44 a GB-month on Plus with its snapshots and weekly downloads),
so `storage.paidForGb` (Plus 10 GB) is the world data an account's price covers; an account past
it is the `worlds_outgrow_plan` admin alert, and nothing is done to its servers.

**Stored worlds.** A world nobody has played on for the plan's `storeAfterIdleDays` (Free 14,
Plus 30) rests in the archive store and lets go of its compute and disk. `lastActiveAt` moves on
a player seen, or the owner's own start; a run a connection woke that nobody joined never moves it.
- `store-sweep` (hourly) finds them; the `store` operation, under the server's lock, makes or
  reuses a copy (a snapshot exported to the archive store, its size checked and the tarball read
  back), checks again that nobody played and nothing else is queued, moves to `storing`, calls
  `runtime.release` (machines and volumes go, the app stays) and ends `stored`. Nothing is let go
  before the copy is verified. A release that stops partway ends `stored` too, audited, and the
  wake clears what was left. A store whose copy failed is tried again a day later, not the next
  hour, since every try snapshots and packs the whole world; one its runtime can't pack at all (a
  world larger than one upload on a fleet node that can't send parts, `RuntimeUnsupported` from
  `exportSnapshot`) fails at once.
- The copy never expires while the world rests, can't be deleted by hand, and is removed only by
  the purge. Undelete of a stored server returns it `stored`.
- Any start, restart or join of a stored server is `unstore`: `runtime.restore({kind:'archive'})`
  on the released handle recreates compute and storage from the copy, then the boot sequence.
  A wake that fails goes back to `stored` with the copy untouched. A server can never boot while
  `storedAt` is set on an empty disk.
- Admins pause it with `platform_controls.storing_enabled`. Players see only "Asleep", and that a
  wake takes a minute or two.

**Retention.** A Free world nobody has played for `deleteAfterIdleDays` (a year) is deleted into
the trash, and never without two emails first, 30 and 7 days before, each with "Keep it" and a
download. `retention-sweep` (daily) sends them, records each (`deletion_warned`), and deletes only
past the date and a full week after the last warning, so a late or paused sweep never deletes
anyone unwarned. Keeping it or playing starts the year over. Plus keeps worlds for as long as it is
Plus. It is off until an admin turns on `platform_controls.expiring_enabled`.

**Telemetry.** Kept as durable columns, never a pipeline: `account_standing.signup_source` (the
`ref` or `utm_source` of the link that brought the account, carried on the links into sign-up and
kept once in its first week; no cookie), `billing_orders`, `created_from` (template, curated,
modpack, upload, copy, invite, direct), `server_players` (first and last seen; a second player is
a friend), `power_intervals` (by size, and whether a join woke it), `last_active_at`,
`disk_used_bytes`, `stored_at` and the `store`/`unstore` operations' timestamps, `billing.checkout_started` with its
reason, and `account.plan_changed`. The queries are in `docs/metrics.md`.

**Reconciliation and orphans.**
- `reconcile` maps `observeChanged` onto `runtime.observed`:
  - unexpected exit → `stopped{crash}`
  - OOM detail → surfaced to the user with a resize suggestion
  - compute running behind a server that holds none (stopped, failed, storing or stored, with
    nothing in flight) → stopped
- `drift` is a schedule of its own, not part of `reconcile`. A running server whose spec no
  longer matches what it should run (a key rotation, a new pinned image) gets an `apply`, only
  while nobody is online and at most 5 a pass, so a deploy that moves every spec never restarts
  the platform under its players. The digest it compares (`driftDigest`) leaves out the plan's
  limits, the disk size, and the server's icon and MOTD, which wait for the next start.
- `orphans` destroys inventory items of purged servers, and those a move left on a runtime the
  server isn't bound to. Items whose server the database doesn't know are kept and logged, never
  destroyed: destroying is one-way. Inventory is scoped by deployment id.

**Deletion.**
- Delete → `deleted`, `purgeAfter = now + entitlements.trashRetentionDays`, `decommission`
  (compute gone, storage and snapshots kept). The slug is retired to `retired_slugs`, and
  routes disappear.
- Undelete within the window → `stopped`, or `stored` for a world that was resting. The next
  start's `ensureProvisioned` recreates the compute.
- Purge → `destroy`, snapshot backups marked `deleted`, server `purged`.

### 15.6 Setups, sharing and failures in owners' words

Making a server asks what to play, what to call it, and who is playing where the plan offers more
than one size; Blockly decides the rest. Sharing it is one action. When something goes wrong, the
owner reads what happened and what to do, in their own terms.

**Setups.** A setup is the portable half of a server: what to play, with nothing of the place it
came from (`domain/setup/setup.ts`). Every server begins as one, turned into its first revision.
- It carries the Minecraft version, the server type (and its build, when copying something that
  runs), the mods its owner chose by catalog project and version or else a modpack, the settings
  that decide how it plays, how the world is made, and a suggested party size.
- It never carries the world or its seed, players or access lists, secrets, uploaded jars, or the
  name, description, icon, address and MOTD. Every new server checks accounts, whatever the one it
  came from does.
- `SetupService` (`app/setups/service.ts`) takes it from a template, another server (by its slug,
  or the invite link that opens it), a catalog modpack, a curated pack
  (docs/modpack-templates.md) or a pack its owner uploaded. `resolve` decides what nobody is
  asked: the newest offered release everything in it runs on (a template names none; a copy keeps
  its own), the mods resolved for it, the loader build, and the size its content needs.
- The size is the larger of what the party needs (5, 10, 20 or more players) and what the content
  needs: no mods or a handful take the smallest, a light set the middle, anything heavier the
  large one (`tierFor`). A pack's is below.
- Templates (`app/setups/templates.ts`) are named for what is played: Survival, Creative,
  Hardcore, Smoother survival (Paper), and Create (NeoForge with the Create mod), with the bare
  server types under "more ways to play". Their words never mention a loader, a build or a mod
  list, and none names a Minecraft version: that is picked when the server is made.
- How each server was made is kept in `minecraft_servers.created_from`.

**Copies.** "Make one like this" copies a setup, and only what the server last booted. Nothing its
owner uploaded, a jar or a pack, is ever copied. Someone else may copy a server only when it is
public or they hold its invite, and only as `copying(trust, copyable)` allows
(`domain/listing/trust.ts`): a setup Blockly doesn't vouch for (an upload, a mod it hasn't
checked, a modpack; §15.3) can't be copied, and its owner can't turn copies on. One it vouches for
is its owner's to offer (`public_listings.copyable`, on by default). The page asks the same rule
before it shows the button.

**Modpacks.** A revision holds a mod list or a modpack (`server_revisions.modpack`), pinned to one
version, so a pack that publishes a new version never changes a world under its players. The
image installs the pack whole, and its Minecraft and mods change only with the pack
(`RevisionService.changePack`). The pipeline is docs/modpack-system.md.
- Before a pack has ever run, Blockly knows what its catalog and its files say
  (`minecraft/packs.ts`). One made for players' own games is refused, and so is one that leaves
  mods for each player to download by hand.
- The size it starts on (`packTierFor` in `minecraft/pack-build.ts`) comes from its author's
  memory setting, then its catalog tags, then what its jars weigh. The first boot settles it: a
  pack that runs out of memory is offered the next size.
- `pack-checks` judges the default list's packs before anybody picks one, and `pack_checks` keeps
  each verdict for a day. Browsing leaves out a pack Blockly can't run as a server; a search lists
  it, dimmed with the reason.
- A pack is never trusted (§15.3), so a pack server stays out of the directory and others can't
  copy it.

**Servers made for a while.** A server created `temporary` carries `expires_at`, a day after it
was made. `expiry-sweep` (every 5 minutes) deletes it then, into the trash, as its owner deleting
it would. `MinecraftServerService.keep` clears it at any time before.

**Sharing.** One Share action (`apps/web/src/ui/share.tsx`, `SharingQueries.share`) holds
everything about giving a server to someone: the invite link, the join address, the switch that
makes it public, and whether others may make one like it.
- The public page, `/server/<slug>`, and the invitation, `/join/<code>`, are the same page
  (`app/sharing/queries.ts`), written for a player: what the server is, who is on, what to install
  (usually nothing), and the address. It says nothing about machines, regions or sizes.
- The page exists while the server is public (`published`), not removed by moderation, the
  directory switch is on and the owner's account is active. Its owner sees it before anyone else
  can.
- An invitation works while the server is private: only a takedown or the owner's standing stops
  it. It does the one thing a page can't: while the whitelist is on, its holder puts their own
  Minecraft name on it, with no Blockly account (`SharingService.joinThroughInvite`, through
  `AccessService.add`, audited). One link lets in at most 10 people an hour, and `resetInvite`
  issues a new code, which ends the old link and its count.
- Outside Blockly a public server answers at `GET /api/public/servers/<slug>` with what a
  community page or a bot needs (name, description, address, awake or asleep, players, the
  Minecraft it runs, whitelist only, the pack to install), beside `badge.svg` and `card.png`, the
  1200×630 picture a link preview shows (`interfaces/http/card.ts`). An invitation has the same
  status and card under `/api/public/invites/<code>`. A server's status, badge and card are cached
  for 30 s and readable from any origin; an invitation's status isn't cached. A private server's
  status and card answer 404 (`interfaces/http/public.ts`).

**Limits on public reads.** Nobody signs in to reach these, so `AccessPolicy` has no account to
bound. The `Limits` port (`app/ports/limits.ts`; `MemoryLimits`, in each process, on
`rate-limiter-flexible`) counts each minute by what is asked about, never by who asks: a page
people open 120, a server's status (its title, JSON, badge and card) 240, one invite code 60, and
every invite together 1,200. A refusal says Blockly is busy for a moment, and the status JSON
answers 429 with `Retry-After`. Player faces count under a key of their own (§15.5).

**Failures in owners' words.** An owner reads what happened and what to do, never a stack trace
(`app/errors.ts`).
- `AppError`, `PermanentFailure` and `PlainFailure` carry the owner's words. Anything else is
  told as a failure on Blockly's side that trying again usually gets past (`inPlainWords`), and
  everything it said stays on the operation's record (`inFull`).
- A start that stops or hangs is read for the signatures Minecraft, the loaders and the image
  print (`minecraft/diagnosis.ts`, the only place that knows them), in its last 300 lines after
  the server last said it had started. A match is a `DiagnosedFailure`: one sentence and one
  remedy (`ours`, `more_room`, `mods`, `modpack` or `restore`; `retry` is tried again instead),
  kept on the server's failure for the page to offer as one action. Out of memory offers the next
  size by name.
- What a plan doesn't run is said in the owner's terms, never in gigabytes (`planFit` in
  `app/servers/queries.ts`): a bigger server, a group past a size, mods. Such a choice is dimmed,
  with why and which plan would, from `planGap`, the rule creating is checked by.
- A mod with no build for the world's release is offered the smallest newer release where the
  change works; the world moves there only if the owner accepts, since moving forward is one way
  (`ModService.plan`).
- In the web app, each field's rule (`apps/web/src/lib/rules.ts`) returns Blockly's sentence or
  nothing, and nothing for a blank field. `useChecked` shows it once the person leaves the field
  or presses the button, and clears it while they fix it. `rules.test.ts` holds the rules to the
  API's own bounds.

---

## 16. Environments

| Concern | Local | Staging | Production |
|---|---|---|---|
| Web | `next dev` on `http://localhost:3000`, rewrites `/api/*` → `http://localhost:4000` | Vercel preview + staging branch domain; rewrites → staging control | Vercel production; rewrites → prod control |
| Control plane | host process, all roles in one: `:4000` api, `127.0.0.1:4001` internal, `127.0.0.1:7443` realtime (`:7444` WebSocket fallback) | Fly org `…-staging`: a control app with process groups api/worker, and a realtime app from the same image (`infra/fly/`) | Fly org `…-prod`, same shape; api ×2 (`min_machines_running = 2` in `infra/fly/control.toml`), realtime ×1; no file sets a worker count |
| Postgres | compose service | Fly Managed Postgres (staging) | Fly Managed Postgres (prod) |
| Runtime | `docker` (`DockerRuntime` via the Docker socket; game containers on their own network `blockly-games`, which only the edge also joins) | `fly` (a private network per game app) | `fly` (same) |
| Artifact links (`runtimeFacingUrl`) | `http://host.docker.internal:4000` | staging control plane's public origin | prod control plane's public origin (game networks have no route to the default 6PN) |
| Tests | `fake` runtime + real Postgres | — | — |
| Edge | compose service: mc-router + edge-agent, host port 25565; agent → `http://host.docker.internal:4001` | Fly app, dedicated IPv4, TCP 25565, agent → control 6PN internal listener | same, 2 machines |
| Play domain | `play.localhost` (macOS, systemd Linux); fallback `127.0.0.1.nip.io` | `play.<staging web host>` wildcard → staging edge | `<prod play domain>` wildcard → prod edge |
| Cookies | host-only `localhost`, not secure, prefix `blockly-local` | host-only on the staging web host, prefix `blockly-staging` | host-only on the prod web host, prefix `blockly-prod` |
| OAuth | "Blockly (local)" Google client (GitHub optional), callback on `localhost:3000`; Mailpit for email | staging clients; `oAuthProxy` for previews | prod clients |
| Realtime TLS | `pinned` (self-signed ECDSA; `transport-io dev`-style) at `https://127.0.0.1:7443/` (an IP, not `localhost`: Chrome tries `::1` first and WebTransport does not fall back to IPv4) | `pinned` or `acme` | `acme` (DNS-01) on an A-only hostname |
| Archive store (optional capability) | RustFS compose service (MinIO's community edition is archived); leave it out to exercise the no-archives path | R2 bucket (staging) | R2 bucket (prod); a self-hosted deployment may omit it |
| Catalog mirror | off | on, to exercise the path (if licensing allows) | operator's decision |
| Billing | Polar sandbox | Polar sandbox | Polar production |
| Caps | tiny; kill switches on | low; separate Fly org machine limit | real |

The Staging column is the Terraform design; the staging that exists is made by
`scripts/staging.ts` in the `blockly-staging` org, with the web app on Fly, Postgres on a machine
of its own, archives in Tigris, and addresses on `fly.dev` and `nip.io`
([configuration.md](configuration.md)).

**Local, in practice.**
- `docker compose up` starts postgres, the object store, mailpit and edge. `bun run dev` starts web and
  control.
- Create a server: `DockerRuntime` starts `itzg/minecraft-server` as `mc-<key>` with a named
  volume. The edge routes `slug.play.localhost` → `mc-<key>:<game port>`. Join from the Minecraft
  client.
- Wake-on-join, idle stop, console, logs (Docker log API), backups (volume copy) and archives
  (RustFS) all run through the same application code.
- The DockerRuntime's `endpoint(…, 'control')` returns the published host port recorded in
  its handle, and `endpoint(…, 'edge')` returns the container name.

**Working on `FlyRuntime` itself.** Its integration tests run against a personal dev Fly org
from a laptop with `fly wireguard`. The peer joins the org's default network, where the game
apps' Flycast addresses live, so the local control plane reaches them as the deployed one does. They're the only tests that touch Fly.

**Staging vs prod isolation.** Separate orgs (6PN, machine limits and billing per org),
separate databases and separate OAuth apps. The deployment id is embedded in:
- provider resource names and labels
- cookie prefixes
- ticket audience

An accidental cross-wiring fails closed.

---

## 17. Repository layout and boundaries

```
blockly/
  apps/
    web/                         Next.js; no origins in the bundle; rewrites from API_UPSTREAM (server-only)
    control/src/
      domain/                    pure: server/(lifecycle, server, size, slug) revision/ world/ setup/
                                       mods/(resolve, artifact, modpack, curation, catalog) access/(access, reconcile)
                                       listing/(trust: trust, copying, eligibility; note) account/(entitlements,
                                       meter, standing) policy/
      minecraft/                 pure translation: runtime-spec.ts versions.ts settings.ts jars.ts mods.ts
                                       address.ts console.ts access.ts identity.ts install-check.ts logs.ts
                                       diagnosis.ts skin.ts uploads.ts worlds.ts, and the pack readers: packs.ts
                                       pack-build.ts pack-layout.ts pack-manifests.ts mrpack.ts server-pack.ts
      app/
        ports/                   runtime.ts minecraft.ts (console, probe, player profiles) platform.ts
                                       (addressing, regions, logs, mail) catalog.ts optional.ts (archive store,
                                       billing) events.ts jobs.ts locks.ts limits.ts loaders.ts formats.ts
                                       curseforge.ts auth.ts tickets.ts certificates.ts
        control-plane.ts         composeControlPlane: every service, built from the ports
        capabilities.ts          DeploymentCapabilities, requireCapability, CapabilityUnavailable
        errors.ts, secrets.ts    owners' words for failures (§15.6); per-server secrets and the runtime keyring
        servers/ setups/ sharing/ mods/ packs/ curation/ revisions/ worlds/ access/ backups/ console/
        listings/ guestbook/ edge/ accounts/ billing/ platform/ realtime/ uploads/
                                 most with service.ts, persistence.ts, queries.ts
        artifacts/               service.ts (preflight, mirror, locate, gc), links.ts (pure, HMAC)
        catalog/                 sync.ts (write-through, refresh, transitions)
        operations/              handlers.ts (a handler per operation kind), runner.ts, schedules.ts,
                                       boot.ts (shared boot sequence)
        runtimes/                router.ts (RuntimeRouter), placement.ts (the policy), service.ts
                                       (RuntimePlacement), economics.ts (runtimes.md)
        policy/                  access-policy.ts
      infra/
        fly/                     client.ts, fly-runtime.ts, machine-config.ts, handle.ts, fly-logs.ts, token.ts
        docker/                  docker-runtime.ts, docker-logs.ts, handle.ts
        boat/                    boat-runtime.ts, boat-minecraft.ts, sandbox-scripts.ts, starts.ts, client.ts,
                                       handle.ts (runtimes.md, boat-runtime-plan.md)
        fleet/                   fleet-runtime.ts, registry.ts, node-endpoint.ts, node-client.ts, placement.ts,
                                       ca.ts, store.ts, operator-api.ts, fleet-logs.ts (fleet.md)
        fake/                    fake-runtime.ts, fake-minecraft.ts (console, probe, logs), fake-catalog.ts, …
        mc-protocol/             rcon.ts, slp.ts
        modrinth/                modrinth-catalog.ts (incl. chunked bulk `states`)
        mojang/                  profiles.ts
        s3/                      s3-archive-store.ts
        polar/                   polar-billing.ts
        pg/                      events.ts (NOTIFY bus), jobs.ts (pg-boss), locks.ts (advisory locks)
        auth/ acme/ realtime/ mail/ limits/ loaders/ formats/ curseforge/
      interfaces/
        trpc/                    routers (parse → actor → one service call)
        http/                    the api role's HTTP app, the public status API and link pictures (§15.6)
        edge/                    edge protocol handlers (internal listener)
        runtime/                 artifact endpoint: the only inbound path from game runtimes (public listener, token auth)
        operator/                the operators' runtimes API (internal listener, operator token)
        billing/                 webhook handler
        realtime/                Transport.io server (realtime role)
      config/                    schema.ts, load.ts, play-addressing.ts (ConfiguredPlayAddressing and the region
                                       catalog, ConfiguredRegionCatalog)
      testing/                   test support: the harness that builds the control plane; only tests import it
      main.node.ts               composition root, per ROLES
    edge/                        Dockerfile, agent.ts (the only mc-router-aware code: it runs mc-router with
                                       its flags), mappings.ts, notice.ts
    blocklyd/                    Rust: the node daemon the fleet runtime drives (its own Cargo package,
                                       CI workflow and supply-chain policy; docs/protocol.md)
    devtools/                    the local inspector (`bun run devtools`): loopback only, never deployed
  packages/
    contracts/                   tRPC input schemas, view types, realtime contract, edge protocol v1
    db/                          Drizzle schema + migrations
  infra/fly/                     control.toml, realtime.toml, edge.toml
  infra/terraform/               modules: fly-org, control, edge, dns, archive, web (vars = DeploymentConfig
                                       values); environments/ (staging, production); stack/
```

**Boundary rules, checked by a script in CI** (`scripts/check-boundaries.ts`, `bun run
check:boundaries`; like transport-io's):
- `domain/` → nothing, not even a package.
- `minecraft/` → `domain/`, and `app/ports/runtime.ts` types; no packages.
- `app/` → `domain/`, `minecraft/`, the rest of `app/`, and the packages `@blockly/db`,
  `@blockly/contracts`, `drizzle-orm`, `zod` and `node:*`; anything else goes behind a port.
  Never `infra/`, `interfaces/` or `config/`.
- `infra/*` → `app/ports/*`: types, the errors a port declares, and its `as const`
  vocabularies. Never `domain/` or `minecraft/`. No adapter imports another: `infra/x` never
  imports `infra/y`. An adapter's generated API types stay inside it, and an SDK belongs to its
  adapter (`@nats-io/*` to fly, `@aws-sdk/*` to s3, `@polar-sh/*` to polar).
- `interfaces/*` → `app/` (services, queries and ports; never a module's `persistence.ts`) and
  `packages/contracts`; never `@blockly/db`.
- `config/` → `config/`, `domain/` and `app/ports/`.
- Only `main.node.ts` imports `config/` and `infra/`, apart from tests and `testing/`, the test
  support that builds the control plane as main does, which only tests may import.
- The same script rejects a hostname literal outside `config/` and tests, except a provider's own
  hosts in its adapter; `25565` outside `minecraft/` and `config/`; and access file names or
  command words (`ops.json`, `whitelist add`, …) outside `minecraft/` and the fake runtime.
- No runtime's provider id (`fly`, `docker`, `boat`, `fleet`, `fake`: each adapter's `provider`) is a literal in
  `domain/`, `minecraft/`, `app/`, `interfaces/` or `packages/contracts`. The application
  records it beside a handle and never branches on it; only `infra/`, `config/` and the
  composition root tell runtimes apart (§8). A deployment may run several at once, each server
  on the one its handle names, behind `app/runtimes/router.ts`; which runtime a new server goes
  to is the placement policy's, recorded ([runtimes.md](runtimes.md)).

---

## 18. What Blockly deliberately doesn't have

The decisions it does follow from are §0. These are the ones it was easy to reach for and did
not take:

- **No Redis.** Postgres is the queue (pg-boss 12.x, pinned at 12.28 or newer), the cache and
  the lock. One thing to run, one thing to back up, one thing to reason about.
- **No agent inside a game server.** Everything the control plane needs from a running server
  it gets through the runtime port's `exec` and RCON over the private network. Nothing of
  Blockly's runs in a server's container. On the hosts Blockly manages itself (the `fleet`
  runtime) one daemon per host, blocklyd, stands where Fly's machine API stands for Fly: it runs
  containers and reports them, and never looks inside one ([fleet.md](fleet.md)).
- **No dependency-injection container.** The composition root builds the object graph by hand,
  which is also the only place that knows which adapters a deployment has.
- **No microservices.** One control plane with roles — api, worker, realtime — that a
  deployment turns on where it wants them.
- **No workflow engine.** Operations are convergent `ensure*` steps queued in strict order per
  server, which is simpler to resume than a checkpointed workflow and impossible to half-apply.
- **No object storage requirement.** It is a capability: archives, downloads, uploaded jars and
  the catalog mirror need it, and a deployment without it says so rather than failing (§15.4).
- **No public address on a game server.** One shared edge IP routes by hostname; the servers
  themselves are reachable only from inside the deployment's private network. The exception is
  Boat, whose sandboxes have no private network: a server's game port is published on its
  sandbox's public IPv6 address, where the edge dials it and anyone can reach it without the
  edge ([boat-runtime-plan.md](boat-runtime-plan.md)).
- **No RCON anywhere but the private network**, with a secret derived per server. Boat has no
  private network, so there RCON never crosses one: the console runs `rcon-cli` inside the
  sandbox through Boat's command endpoint (`BoatConsole`).

---

## 19. Concerns that shaped the design

1. **Slug reuse is an impersonation vector.** A deleted popular server's address could be
   claimed and receive its players. Slugs are quarantined (`retired_slugs`, 30 days), and
   listed servers' slugs longer.
2. **Play-domain overlap.** If `PLAY_DOMAIN` were the root domain, a slug like `api` would
   shadow the platform host. Boot validation forbids platform hosts under play domains, and
   the domain keeps a reserved-slug list.
3. **SRV records rewrite the handshake hostname.** Using SRV for anything (custom domains, a
   bare-apex join) would send the SRV *target* to the edge. Every hostname routed must be an
   A/AAAA name. That's in the edge design, and must stay in mind if custom domains are ever
   added. User-owned custom hostnames are the one case where persisting a hostname would be
   correct, as product state with verification.
4. **Edge player identity is client-claimed.** It's never used for authorization or bans;
   RCON is authoritative.
5. **The realtime singleton is a single point of failure for hints only.** Correctness never
   depends on it: tRPC refetch on session, and polling fallback built into the client's
   reconnect loop. Its restart on cert rotation is expected.
6. **The Transport.io hostname must be A-only** when UDP answers on IPv4 only, or browsers
   land on IPv6 and fail. It's validated at boot in `acme` mode.
7. **Cross-environment blast radius.** Orphan cleanup deleting another environment's servers
   would be catastrophic. Inventory is filtered by the deployment label. There are separate
   Fly orgs, and destroy refuses handles whose deployment id differs.
8. **Fly API rate limits.** Wake storms and reconcile loops must go through a rate-limited
   client, and reconcile uses org-wide listing.
9. **Snapshot lifetime is provider-bounded,** and purge deletes snapshots. Users are told that
   only archives survive deletion. Entitlements expose both.
10. **Crash-consistency of snapshots.** Backups use RCON save-off/flush. Relocate and restore
    stop the server first.
11. **Vercel rewrite caching and the 120 s cap.** `no-store` on every API response. No
    long-polling through the web origin. The wake wait happens on the internal edge path,
    not through Vercel.
12. **Fly machine limit per org** must stay above `platform_controls.maxServers` +
    per-server transient machines (restore, export and relocate briefly use extra machines).
    Size caps with that headroom.

### 19a. Untrusted code on a shared private network

13. **Untrusted code shares the private network.** Every mod is arbitrary code, and custom
    uploads are anyone's code. On Fly's default org network a game machine can reach Postgres,
    the control plane's internal listener, the edge and other servers' RCON ports. Only
    secrets protect them.
    - **Change (infra and config only):** each game app is created on its own private
      network. Apps on separate networks "can never communicate unless explicitly
      configured" (https://fly.io/docs/networking/custom-private-networks/).
    - The edge and control plane reach it through a Flycast address allocated *for the
      default network*, which is one-way (https://fly.io/docs/networking/flycast/).
    - The game app's `services` block keeps autostart and autostop off.
    - Game runtimes reach the control plane only through the token-authenticated artifact
      endpoint on its public origin (`artifacts.runtimeFacingUrl`).
    - Locally, game containers sit on a network only the edge also joins.
    - `endpoint(…)` absorbs all of this, so no application code changes.
    - **Spikes before relying on it:**
      - raw TCP to `<app>.flycast` with autostart off. A connection to a stopped machine isn't
        refused: Fly's proxy takes it and nothing answers, so the edge routes a sleeping server
        to its own notice (§12)
      - RCON over Flycast
      - any limit on the number of custom networks per org
    - Also keep the game process non-root (the itzg default is uid 1000), and never place Fly
      tokens or control-plane secrets in game machines.
14. **Game servers see the edge's address, not the player's.** This is why IP bans are not
    modelled (§15.1). If real client IPs are ever needed, the path is PROXY protocol end to
    end: the Fly proxy handler → mc-router `-receive/-use-proxy-protocol` → a server type that
    supports it. Vanilla does not.
15. **Modrinth moderation is invisible for malware.** A security takedown is publicly
    indistinguishable from an author deleting a version, and the CDN keeps serving the file.
    Blockly's allowlist is therefore the primary trust decision, catalog state a revocation
    signal, and revoked artifacts need acknowledgement before they're applied again (§15.3).
16. **The artifact endpoint is internet-facing** (game networks can only reach public
    origins). It authorizes by a per-server derived token *and* revision membership of the
    sha512. It answers HEAD without touching storage, and GET only redirects. So a leaked
    token exposes that server's own mod files and nothing else. Rotation is a key-version
    bump plus an apply.
17. **The image's download behaviour is load-bearing.** Three observations come from
    mc-image-helper at `aca1cfb`:
    - HEAD revalidation on every start, with a 403/404 aborting startup
    - in-place, non-atomic writes
    - manifest-based removal only when `MODS` is set

    The image is pinned per release (§7). The boot-sequence install check turns any
    regression in this behaviour into a detected, rolled-back apply rather than a silently
    broken server.
18. **Minecraft 26.3 changes access defaults and log lines.** `white-list` now defaults to
    true, and some log lines were removed. Blockly depends on neither:
    - it reads the files, not the logs
    - the reseed at first boot sets `white-list` explicitly, and itzg writes `false` into a
      brand-new `server.properties` anyway

---

## 20. Capability dependencies, and the order they can be built in

```
config + addressing + db schema + auth/standing + AccessPolicy/kill switches
  → runtime port + FakeRuntime + DockerRuntime + translation (toRuntimeSpec)
    + DeploymentCapabilities (wired from config; absent ports are the default)
    → provision / start / stop / restart + state machine + operations + boot sequence + EventBus + realtime
      → ServerAccess + PlayerProfiles + access reconciliation (the boot sequence depends on it)
      → edge protocol + edge agent (routing) → wake + presence + idle policy
      → FlyRuntime (same port; private networks + Flycast; staging)
        → reconcile + orphans + power intervals + entitlements/quotas
          → revisions: settings/version changes
            → artifact links + artifact endpoint + install check
              → mods + ModCatalog + resolution + catalog cache write-through → apply/rollback
            → backups (snapshot) → restore (access reseed) → relocate
              → ArchiveStore capability → archives, downloads, custom uploads → mirror + artifact GC
              → logs + console
                → catalog-refresh + allowlist → trust → listings (materialized eligibility) + moderation
                  → billing (Polar) → entitlement enforcement on downgrade
          → delete / undelete / purge (needs backups for snapshot handling)
```

The most complex pieces are:
- `apply` with auto-rollback
- `restore` / `relocate` (runtime replacement, plus the access reseed)
- the idle policy (presence correctness)
- access reconciliation, the one place with two legitimate writers

**Open questions:**
- The production and staging domains (only config needs them).
- The initial product region catalog.
- Memory tiers per plan.
- Trash retention days.
- Whether archive exports are a paid-only entitlement.
- Whether to mirror catalog artifacts in production: a licensing question for Modrinth
  support, not an architecture one.
- The initial trusted-project allowlist for public listings.
