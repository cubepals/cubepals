# blocklyd audit (2026-10-06)

The question: where does blocklyd own code that a proven library, or a known and citable pattern,
could own for it, and which of its decisions don't hold up? The answer had to keep behaviour: the
wire to the control plane, the state on every node's disk, the config file, the CLI the systemd
unit runs, and the move from one build to the next and back.

## How it was done

- **Ten areas, each read in full:**
  - HTTP and mutual TLS;
  - the fleet client, enrollment and identity;
  - the CLI and self-upgrade;
  - the safe tree walk and archives;
  - the state directory;
  - the manager;
  - the Docker runtime and ports;
  - config, inference and doctor;
  - the protocol and its TypeScript mirror;
  - tests, build and CI.

  Every hand-written piece was set against named crates.
- **Every finding attacked.** A second reader per area tried to refute each finding: open the
  code, read the proposed crate's source, build the failing case concretely. Findings that
  couldn't be shown were dropped, and several proposals were narrowed or corrected this way.
- **The constraints any crate had to meet:**
  - those of `apps/blocklyd/deny.toml`: permissive licences, crates.io only, no OpenSSL;
  - TLS through rustls with ring, and a static musl release;
  - the unit's sandbox: no `AF_NETLINK`, nothing writable but the state directory.
- **A map of everything that depends on blocklyd**, so no fix breaks a consumer:
  - in the control plane: the node client, node endpoint, rollout and e2e suites;
  - on hosts: `join.sh`, and the systemd unit, frozen on each host at join;
  - the Terraform firewall;
  - the state directory, container labels and the spec digest.

## The verdict

blocklyd doesn't invent much. It already rests on the right libraries: tokio, axum and hyper,
rustls, webpki and rcgen, bollard, serde and toml, tar and flate2, prometheus-client, rustix.
Most of its hand-written code was checked against a named alternative and kept, for the reasons
in the table below.

What it owned for no reason is gone:

- the experiment's 887-line Python harness, which nothing ran;
- `tower-http` and `tokio-stream`, and unused features and dev-dependency lines;
- five hand-written atomic file writes, now one helper on `tempfile`;
- `tree::Exactly`, now std's `take`/`chain`;
- config and spec defaults written twice, now serde's container default;
- a second CI recipe for the release binary: CI builds the Dockerfile stage hosts run;
- the control plane's hand-kept copy of the wire types, which had drifted, now generated from the Rust
  types. Owned lines come out about even; what it buys is a drift gate.

Its real debt was bugs: found by reading, none caught by a test, several able to take a player's
server down.

## What was fixed

| What could happen | Fix |
|---|---|
| An exec that timed out before Docker started it reported pid 0. The kill then walked every process on the host and SIGKILLed the container's game server, without a save. | Wait up to 2 s for a real pid. The walk never starts from 0 or 1. |
| A player's archive made root blocklyd allocate without limit: tar reads long names and PAX records whole, before blocklyd's caps apply. Its `OOMScoreAdjust` meant tenants were killed first. | Each member's metadata is capped at 1 MiB, Go's and libarchive's limit. tar-rs PR #481 will make this a setting. |
| A power cut after a "finished" restore or snapshot left empty files: nothing synced the data, only the spools. | One `syncfs` before the marker or `snapshot.json`. |
| A heartbeat or restore download whose body stalled waited forever, stopping heartbeats or holding a workload's lock. | Timeouts cover the body. Downloads fail after 2 min with no data, or 3 h in all. |
| A new blocklyd that failed its `ExecStartPre` was never put back. One that hung while starting wasn't either. | Roll back by systemd's `$SERVICE_RESULT`. A 240 s backstop from process start. The state directory is read leniently. |
| A fence whose stop failed left the superseded copy serving players for good. | After each resync, a recorded fence is applied again to a copy found running. |
| Record writes from verbs and from Docker events shared one temp file. Records tore, the port quarantine was lost, retained workloads came back. | Writes take turns, each writing the newest state, through one atomic helper with unique temps. |
| Spools and unfinished snapshots left by a crash leaked forever. | Cleared at startup, and logged. |
| Concurrent snapshot copies and exports could fill the disk under running servers. | They stop at the disk floor, as restores already did. |
| One busy workload (an export, up to 3 h) stalled every crash restart on the node, and shutdown. A requested kill was scheduled for a restart. | The supervisor tries the lock and comes back. Only crashes schedule restarts. |
| The ops listener's shutdown waited forever on a half-sent request, which could freeze a self-upgrade. | Dropped at once on shutdown. |
| A TLS handshake cut short, or an answer cut off mid-body, counted as final. | Retried; certificate failures stay final. |
| An abandoned console follow kept its task and Docker stream open until the server printed again. | Ends when its reader goes. |
| Rolling back a part-failed port allocation quarantined ports nothing had used. | Given back at once. |
| An untagged image pulled every tag. | Pulls `latest`, as the CLI does. |
| The `method` metric label took any string a client sent. | Bounded. |
| Multi-member gzip archives were refused. The tree walk's entry cap didn't bound memory. | Fixed. |
| The control plane's log reader corrupted characters split across network chunks, like the `§` in colour codes. | Decoded as one stream. |
| `check-config` passed `fleet.url`s the client can't use, then `serve` crash-looped. | Read as the client reads it. |

## Guards added

- **Contract pins**:
  - today's spec digests, which a build must reproduce or it recreates every container;
  - fixtures of every file and label a node leaves behind, which upgrades and rollbacks must read.
- **`FEATURES` only grows**. The control plane gates placement and upgrades on it.
- **Supply chain**:
  - aws-lc is banned, so TLS stays rustls with ring;
  - advisories run weekly as well as on change;
  - CI builds and checks the release binary from the same Dockerfile stage that ships it.
- **Wire types**. The control plane's types are generated from the Rust protocol types, and
  `cargo test` and `openapi:check` fail on drift, as they do for Fly's and Modrinth's
  ([dependency-audit.md](dependency-audit.md#blocklyds-wire-generated-from-its-own-rust-types)).

## Kept custom, and why

| Piece | Checked against | Why it stays |
|---|---|---|
| The mTLS accept loop (`api/mod.rs`) | `axum::serve` with a custom listener, `axum-server` 0.8.0, `tls-listener` 0.11.2 | It is hyper-util's documented pattern. `axum::serve` 0.8.9 sets no timer, so it has no header-read timeout and no bounded drain. `tls-listener` logs handshake failures instead of counting them by reason. `axum-server` still needs a ~35-line acceptor for the client identity, and adds h2 and four other crates, to save ~15 lines. |
| The fleet HTTP client (`fleet/client.rs`) | `reqwest` 0.13.5; `hyper-rustls` 0.27.10 with hyper-util's client | It is ~50 lines over hyper's conn API. Each reqwest default would have to be switched off: redirects, pooling, proxies from the environment, URL normalisation of presigned URLs. It would add ~7 crates and blur enrollment's refused-versus-unreachable split. hyper-rustls panics with the ALPN setting the configs share. What reqwest had right, timeouts that cover the body, is now done here. |
| System CA bundle discovery | `rustls-native-certs` 0.8.4 | Two crates for four lines, and environment variables would steer what a root daemon trusts. Supported hosts are Debian and Ubuntu, whose bundle is the first path tried. It now trusts the roots that parse, as rustls's docs advise. |
| The O_NOFOLLOW tree walk (`tree.rs`) | `cap-std` 4.0.3, `walkdir`, `openat2` | It follows the pattern of std's own CVE-2022-21658 fix and fts(3) `FTS_PHYSICAL`. `walkdir` reopens by path, so it follows a directory swapped for a link, which two tests forbid. `cap-std` adds ~9 crates and follows links inside the sandbox by default, and the recursion, limits and skip counting would stay custom anyway. |
| `FICLONE` copies | `reflink-copy` 0.1.30 | It opens the source by path, which follows links. The walk reads through the descriptor it checked. |
| The archive unpack loop | `tar`'s `unpack_in` | `unpack_in` skips `..` instead of refusing the archive, creates links, writes unknown types as files, has no entry or byte caps, and can't stop at the disk floor. |
| The restore swap (`store.rs`) | none exists | No crate does a crash-settled directory exchange: `renameat2(RENAME_EXCHANGE)`, a two-rename fallback, and a marker only root can own. |
| The presigned multipart upload | `aws-sdk-s3`, `object_store` | The node holds presigned URLs, not credentials, and both crates sign their own requests. aws-sdk-s3 would also bring aws-lc. |
| The per-workload lock, restart scheduler, backoff and lease | `key-mutex`, `keyed-lock`, `DelayQueue`, `backon` 1.6, `tokio-retry` | The keyed-lock crates have 15–24k downloads. DelayQueue would mean more code. Each backoff is one line, and `backoff` itself is unmaintained (RUSTSEC-2025-0012). |
| The reconcile loop | `kube-runtime` | It is tied to the Kubernetes API. blocklyd uses the same pattern: events are hints, a periodic resync is the truth, state is level-triggered. |
| Self-upgrade and rollback | `self-replace` 1.5.0, `self_update` 1.3.0, systemd-sysupdate | self-replace only does the rename. self_update targets GitHub and S3 releases over a second HTTP stack with no mTLS. systemd has no health-gated rollback for a service. |
| systemctl as a subprocess | `zbus` | Dozens of crates for four calls in an operator CLI. |
| `/proc` reads (`host.rs`, `infer.rs`, `doctor/`) | `procfs` 0.18, `sysinfo`, `if-addrs` 0.15, `nix::ifaddrs`, `netdev` | getifaddrs opens a netlink socket, which the unit refuses (`RestrictAddressFamilies`), and musl has no fallback. procfs's lock parser drops the marker that tells a waiter from the holder. |
| Spec validation | `validator` 0.21, `garde` 0.23 | The 422's field paths are camelCase with map keys and indices, which neither crate produces. Most rules are cross-field or come from host policy. |
| Config loading | `figment`, `config-rs` | About 8 crates for provenance blocklyd already records. Keys are `*_seconds` and `*_mb`, so `humantime` and `bytesize` would have nothing to parse. |
| The test runtime (`runtime/fake.rs`) | `mockall` | The tests need a stateful fake (a port clash at start, a removed container gone), not expectations. |
| `Type=exec`, not `Type=notify` | `sd-notify` 0.5.0 | A first enrollment may wait indefinitely, which a start timeout would kill, and upgrades don't rewrite units on hosts. |
| `async-trait` | native async fn in traits | The manager holds `Arc<dyn ContainerRuntime>`, and native async trait methods aren't dyn-compatible. |
| `panic = "abort"` | unwinding | Crash-only: systemd restarts it and startup reconciles, rather than running on with poisoned locks. |
| The error envelope | RFC 9457 Problem Details | `code` is a contract the control plane already branches on. |

## Deferred, and why

- **The address is re-inferred at every start.** A host that later gains a second private address (Tailscale, a VPN) can no longer start blocklyd, including after a self-upgrade. The fix needs a design call and new on-disk state: remember the address served on, or have join persist it. It is the most important open item.
- **The unit drifts.** The unit on hosts is written once by join and never follows upgrades. Do this with the first release that changes the unit: a doctor check plus `doctor --fix`, the way daemon.json is handled.
- **Heartbeat fences run inline.** A long graceful stop delays heartbeats. The safe version needs care around the fencing invariant, and the re-applied fence above covers the dangerous case.
- **Rare races** (low impact, owned code for each):
  - a reconcile pass dropping an in-flight port allocation;
  - concurrent starts passing memory admission together;
  - the keyed lock's removal after a delete.
- **To measure first.**
  - Record fsyncs run on the two async workers. Measure before moving them.
  - A contract test for the fake runtime against real Docker.
- **Small items:**
  - The operations metric counts epoch refusals as errors.
  - Hetzner's /32 private addresses show no interface name.
  - Moving to toml 1.x.
  - `rust-toolchain.toml`.
  - The control plane's `FLEET_JOIN_URL` check is looser than blocklyd's new one.
  - A snapshot the control plane never recorded still leaks; that needs a control-plane reconcile.
