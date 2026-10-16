# How long a wake takes

How a sleeping server's wake grows slower the longer it sleeps, where the time goes, and what
Blockly does about it. A resume that hangs, and the fallbacks for it, are
[resume-fallback.md](resume-fallback.md); the edge's side of a wake is §12 of
[architecture.md](architecture.md).

## A sleep, over hours and days

1. **Asleep, with its memory.** A server nobody is on sleeps after its plan's idle time (Free 10
   minutes, Plus 15), or after the 5-minute probation for a run a connection woke and nobody
   joined (`domain/server/idle.ts`). Where the suspend switch is on
   (`app/platform/suspend-switch.ts`, `FLY_SUSPEND`), Fly keeps its memory, once the world is
   saved, nobody is on, and its files are written through (`mayDoze`,
   `app/operations/handlers/winding-down.ts`). Otherwise it stops. A sleep that kept the memory
   says so in `server_runtimes.memory_kept_at`, which the next run's start clears.
2. **Stopped.** Nothing in Blockly turns a suspended machine into a stopped one after a while. The
   memory goes when:
   - Fly drops it: a host migration, maintenance, a lost snapshot. Fly promises no resume and
     names no time.
   - The next start finds the machine on another spec, and updates it first, which drops it
     (`asleepOn`, `infra/fly/machine-config.ts`). That happens after a new image release, a key
     rotation, or a change saved while it slept. Icon, message and plan limits don't count
     (`withoutPlanLimits`, `app/servers/specs.ts`).
   - A restore, a move or a rest stops it first.
3. **At rest.** Once nobody has played for the plan's `storeAfterIdleDays` (Free 14, Plus 30),
   the hourly `store-sweep` (at minute 47) stops it, packs its world into the archive store, and
   lets go of its machine and volume. Only its app stays (`stored-worlds.ts`).

## Where the time goes

Staging, 2026-10-16: a new Free survival server (plain Minecraft 26.3 on the Alpine image, 3 GB,
one performance CPU, a new world), timed from the click to running as its page shows it, with
Fly's events and every line the machine printed. A stopped wake was a suspended machine stopped
with `fly machine stop`, as Fly dropping its memory leaves it. The stopped wakes are three in a
row; the other two columns are one wake each.

| Part | From memory | Stopped | At rest |
|---|---|---|---|
| Asked, until Fly starts the machine | 0.6 s | 1.4 s | 1.2 s |
| A volume made, and a helper machine on it | | | 6 s |
| The copy downloaded and unpacked (one `curl \| tar -xz` stream), then the helper gone | | | 11 s |
| The server's machine made, pulling its image onto a host that didn't have it | | | 15 s |
| The machine started on its volume | 0.7 s | 1.4 s | 3 s |
| The image's start scripts | | 4 s | 6 s |
| Java, up to Minecraft's main class | | 4.3 s | 5 s |
| Minecraft's own start: registries, data fixers, advancements | | 21.3 s | 22.1 s |
| The world loaded, to "Done" | | 1.6 s | 1.7 s |
| Answering, access, every edge holding the route | 0.8 s | 3 s | 3.3 s |
| **Click to running** | **2.1 s** | **34.9, 36.1, 37.0 s** | **74.3 s** |

A plain server has no plugins to start; a Paper server adds its own patching and plugins, as
`minecraft/wake-step.ts` measured.

Nearly all of a cold boot is the game starting on one CPU. The image's scripts were cut from 18 s
to 4 s before (`minecraft/wake-step.ts`). A class data archive saved under 2 s of the same wake
and put 127 MB on every volume, backup and rest, so it isn't used. A rest adds a helper machine's
whole life and an image pull onto the volume's host.

## What Blockly does about it

- **A ping from a player starts the wake.** Opening the multiplayer screen pings the saved servers
  it shows, so a ping of a sleeping server is often seconds before the click. The edge asks the
  control plane to wake a sleeping server it is pinged for (`POST /edge/v1/ping-wake`), with the
  address the ping came from, waits up to 1.5 s for the answer, and the list shows "Waking up ·
  join in a few seconds" when one started. The join then waits only for what is left of the boot.
  Anything on the internet can ping: scanners, sites that list servers, bots. So the control plane
  wakes a server for a ping only when:
  - the ping comes from a network one of the server's own players joined it from, within
    `AbuseLimits.knownAddressDays` (`app/edge/known-addresses.ts`). Every other ping hears it
    sleeps, and a join from anywhere wakes it as always;
  - its wake is a boot from a sleep: one whose sleep stopped it. One that kept its memory resumes
    about as fast as the click, and a world at rest never comes back for a ping (below);
  - its owner can start it now, through the same checks as a join's wake;
  - it is under the hourly cap on wakes from connections;
  - its owner has included hours left;
  - its last ping wake was joined, or `AbuseLimits.pingWakeHoldHours` have passed, or someone has
    played since (`app/edge/ping-wake.ts`).

  Nobody joining puts it back to sleep after the probation, and that run counts toward no hours:
  a run a ping woke counts from the first player the server itself sees on it, on the meter and in
  the app alike (`countedFrom`, `app/accounts/persistence.ts`). The edge asks once every 30 s per
  server and network however often it is pinged (`apps/edge/ping-wake.ts`), so a stranger told no
  never stands in for a player.

  **What is kept.** A network counts once a join from it ends and the server's own reading had
  that player on in the minutes before; a client the server turned away leaves nothing. It is kept
  as one row per server and network: an HMAC of the network (an IPv4 address, or an IPv6 one's
  /64, which one home or phone keeps while its address changes daily) under a key derived for the
  server from the runtime key, and when that join ended. Not the address, not who joined. The
  hourly `known-addresses` job deletes a row once it no longer counts, `knownAddressDays` after
  the last join from it. Rotating the runtime key forgets them all.

  **A world at rest stays at rest for a ping.** It rests because nobody has played for weeks, so
  no join is recent enough to count, and its players' lists keep pinging it on the way to other
  servers. A restore brings the whole world back from storage, the slowest wake there is, and
  nobody would be there to play; the ping would save a few seconds of its 74. A join wakes it as
  always.

  **How much it hides.** The list pings a server as it first draws it, so the boot starts when the
  player opens the screen, and a click a few seconds later waits that much less of the 35 to 37 s
  of a stopped wake; a player who opens the list while friends gather may find it up. The ping's
  handshake is the first the edge hears of a player, and it asks at once, before the status
  request is read, so the edge can't start it sooner.
- **Every edge says a server is waking.** A server on its way up, by a join or a ping, is routed
  as asleep with `waking`, so every ping gets "Waking up" while it boots. That includes a world
  coming back from rest, which used to have no route at all until it was back.
- **The copy is read sooner.** A helper job's result is read every second for its first 20 s,
  then every 5 s. A small world's copy was done well inside the 5 s the helper used to wait
  between reads.

## Not done here

- **The restore inside the server's own machine.** No helper, so no second machine made, started
  and destroyed, and the image pulled once, while the copy downloads. On the rest above, that is
  most of the helper's 17 s. It costs nothing more, but changes how a restore fails and is checked
  on Fly, so it is a change of its own.
- **Keeping memory or volumes longer**, or more CPU while a server boots: each changes what a
  sleeping or waking server costs, so it is a pricing decision, not one made here.
